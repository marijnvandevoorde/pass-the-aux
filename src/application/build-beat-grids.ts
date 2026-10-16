import type { AnalysisRepository } from "../domain/ports/analysis-repository.ts";
import type { AudioAnalyzer } from "../domain/ports/audio-analyzer.ts";
import type { BeatGridRepository } from "../domain/ports/beat-grid-repository.ts";
import { AnalyzerUnavailableError } from "../domain/errors.ts";

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
 */
export class BuildBeatGrids {
  readonly #analyses: AnalysisRepository;
  readonly #grids: BeatGridRepository;
  readonly #analyzer: AudioAnalyzer;
  readonly #userId: string;

  constructor(
    analyses: AnalysisRepository,
    grids: BeatGridRepository,
    analyzer: AudioAnalyzer,
    userId = "",
  ) {
    this.#analyses = analyses;
    this.#grids = grids;
    this.#analyzer = analyzer;
    this.#userId = userId;
  }

  async execute(): Promise<{
    scanned: number;
    built: number;
    unavailable: boolean;
  }> {
    const all = await this.#analyses.all(this.#userId);
    const rows = Object.keys(all);
    let built = 0;
    for (const id of rows) {
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
      } catch (e) {
        // Engine down: the rest would fail the same way. Stop; the next
        // sweep picks up where this one left off.
        if (e instanceof AnalyzerUnavailableError) {
          return { scanned: rows.length, built, unavailable: true };
        }
        // otherwise per-track best-effort; next sweep retries
      }
    }
    return { scanned: rows.length, built, unavailable: false };
  }
}
