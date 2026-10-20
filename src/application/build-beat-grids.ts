import type { AnalysisRepository } from "../domain/ports/analysis-repository.ts";
import type { AudioAnalyzer } from "../domain/ports/audio-analyzer.ts";
import type { BeatGridRepository } from "../domain/ports/beat-grid-repository.ts";
import { AnalyzerUnavailableError } from "../domain/errors.ts";
import type { GridDemand } from "./grid-demand.ts";

/**
 * backfill: walks every track in the user's library and
 * computes a beat grid for any track that doesn't already have one (or
 * has one from an older `analyzerVersion`). Best-effort — one bad
 * track does not abort the run.
 *
 * Runs in the background sweep alongside {@link AnalyzeLibrary}; the
 * `POST /api/build-grids` route exists for an explicit DJ kick-off.
 *
 * When the analyzer reports a BPM with the grid, that BPM replaces the
 * library's: whatever filled it earlier (tags, a metadata lookup, the
 * local DSP while the sidecar was down) is provisional, and the grid
 * and BPM must agree for beat-sync. If the analyzer is unavailable the
 * run stops early and nothing is stored, so a track is never left with
 * a fallback result marked as done.
 *
 * Tracks in {@link GridDemand} (loaded, queued, crowd requests) go
 * first; demand is checked again before every track, so a track queued
 * mid-run is next instead of waiting for the rest of the library.
 * A `wantedOnly` run can go side by side with a full one (the server's
 * wanted-grid lane next to the library sweep): each track is claimed in
 * the demand first, so the two never build the same track.
 */
/** Per-track failures (the analyzer crashed on it) before the track is
 *  stored as "no grid" so it stops being retried. */
const MAX_TRACK_FAILURES = 3;

export class BuildBeatGrids {
  /** Failures per track since this process started. Tracks that failed
   *  go to the back of the next run, so one track that keeps timing out
   *  or crashing the sidecar can't hold up the rest of the library. */
  readonly #strikes = new Map<string, number>();
  readonly #analyses: AnalysisRepository;
  readonly #grids: BeatGridRepository;
  readonly #analyzer: AudioAnalyzer;
  readonly #userId: string;
  readonly #demand: GridDemand | null;

  constructor(
    analyses: AnalysisRepository,
    grids: BeatGridRepository,
    analyzer: AudioAnalyzer,
    userId = "",
    demand: GridDemand | null = null,
  ) {
    this.#analyses = analyses;
    this.#grids = grids;
    this.#analyzer = analyzer;
    this.#userId = userId;
    this.#demand = demand;
  }

  /** `wantedOnly`: only the tracks in demand (the sweep runs this before
   *  the long per-library analysis). */
  async execute(opts: { wantedOnly?: boolean } = {}): Promise<{
    scanned: number;
    built: number;
    unavailable: boolean;
  }> {
    const all = await this.#analyses.all(this.#userId);
    const strikes = (id: string): number => this.#strikes.get(id) ?? 0;
    // Stable sort: library order, previously failing tracks last.
    const rows = Object.keys(all).sort((a, b) => strikes(a) - strikes(b));
    const remaining = new Set(rows);
    let cursor = 0;
    const pick = (): string | undefined => {
      const wanted = this.#demand?.next(this.#userId, remaining);
      if (wanted !== undefined) return wanted;
      if (opts.wantedOnly === true) return undefined;
      while (cursor < rows.length && !remaining.has(rows[cursor]!)) cursor++;
      return rows[cursor];
    };
    let built = 0;
    for (let id = pick(); id !== undefined; id = pick()) {
      remaining.delete(id);
      // The other run is building it right now.
      if (this.#demand && !this.#demand.claim(this.#userId, id)) continue;
      let handled = true;
      try {
        const existing = await this.#grids.get(this.#userId, id);
        if (
          existing &&
          existing.analyzerVersion >= this.#analyzer.beatAnalyzerVersion
        ) {
          continue; // already gridded by this analyzer (or a newer one)
        }
        const result = await this.#analyzer.analyzeBeats(id);
        if (!result) continue; // null = no trackable pulse / decode failed
        const { bpm, ...grid } = result;
        await this.#grids.put(this.#userId, grid);
        const row = all[id];
        // same precision as the Tempo value object
        const measured =
          typeof bpm === "number" && bpm > 0 ? Math.round(bpm * 10) / 10 : null;
        if (row && measured !== null && measured !== row.bpm) {
          const { analyzedAt: _at, ...rest } = row;
          await this.#analyses.put(this.#userId, id, { ...rest, bpm: measured });
        }
        built++;
        this.#strikes.delete(id);
      } catch (e) {
        const n = strikes(id) + 1;
        this.#strikes.set(id, n);
        // Engine down: the rest would fail the same way. Stop; the next
        // sweep tries the others first and this track last.
        if (e instanceof AnalyzerUnavailableError) {
          handled = false; // still wanted: first in line when it's back
          return { scanned: rows.length, built, unavailable: true };
        }
        // Per-track failure: retried on later sweeps, until it has failed
        // too often to be a fluke; then record "no grid" so it stops
        // costing an upload every sweep.
        if (n >= MAX_TRACK_FAILURES) {
          await this.#grids.put(this.#userId, {
            trackId: id,
            durationSec: 0,
            beats: new Float32Array(0),
            downbeatPhase: 0,
            firstSolidBeatIndex: -1,
            confidence: 0,
            analyzerVersion: this.#analyzer.beatAnalyzerVersion,
          });
          this.#strikes.delete(id);
        }
      } finally {
        if (handled) this.#demand?.done(this.#userId, id);
        this.#demand?.release(this.#userId, id);
      }
    }
    return { scanned: rows.length, built, unavailable: false };
  }
}
