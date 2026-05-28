import type { AnalysisRepository } from "../domain/ports/analysis-repository.ts";
import type { AudioAnalyzer } from "../domain/ports/audio-analyzer.ts";
import type { BeatGridRepository } from "../domain/ports/beat-grid-repository.ts";

/**
 * backfill: walks every track in the user's library and
 * computes a beat grid for any track that doesn't already have one (or
 * has one from an older `analyzerVersion`). Best-effort — one bad
 * track does not abort the run.
 *
 * Runs in the background sweep alongside {@link AnalyzeLibrary}; the
 * `POST /api/build-grids` route exists for an explicit DJ kick-off.
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

  async execute(): Promise<{ scanned: number; built: number }> {
    const rows = Object.keys(await this.#analyses.all(this.#userId));
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
        const grid = await this.#analyzer.analyzeBeats(id);
        if (!grid) continue; // null = no trackable pulse / decode failed
        await this.#grids.put(this.#userId, grid);
        built++;
      } catch {
        // per-track best-effort; next sweep retries
      }
    }
    return { scanned: rows.length, built };
  }
}
