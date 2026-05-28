import type {
  AnalysisRecord,
  AnalysisRepository,
} from "../domain/ports/analysis-repository.ts";
import type { AudioAnalyzer } from "../domain/ports/audio-analyzer.ts";

/** A row still missing any browser-grade analysis field. */
function needsAnalysis(r: AnalysisRecord): boolean {
  return (
    r.bpm == null ||
    !r.key ||
    !r.mode ||
    !r.camelot ||
    r.energy == null
  );
}

/**
 * Backend bulk analysis (DJ ...): finds EVERY row for the user with
 * any of bpm/key/mode/camelot/energy missing and analyses it
 * server-side (ffmpeg decode + the shared DSP), updating the DB.
 * Independent of the paginated UI — the whole library, in the
 * backend. Never clobbers a field that's already set.
 */
export class AnalyzeLibrary {
  readonly #analyses: AnalysisRepository;
  readonly #analyzer: AudioAnalyzer;
  readonly #userId: string;

  constructor(
    analyses: AnalysisRepository,
    analyzer: AudioAnalyzer,
    userId = "",
  ) {
    this.#analyses = analyses;
    this.#analyzer = analyzer;
    this.#userId = userId;
  }

  async execute(): Promise<{ scanned: number; analyzed: number }> {
    const all = await this.#analyses.all(this.#userId);
    const pending = Object.entries(all).filter(([, r]) =>
      needsAnalysis(r),
    );
    let analyzed = 0;
    for (const [id, prev] of pending) {
      try {
        const f = await this.#analyzer.analyze(id);
        if (!f) continue;
        await this.#analyses.put(this.#userId, id, {
          ...prev, // keep size/mtime/artist/title; analyzedAt re-stamped
          bpm: prev.bpm ?? f.bpm,
          key: prev.key ?? f.key,
          mode: prev.mode ?? f.mode,
          camelot: prev.camelot ?? f.camelot,
          energy: prev.energy ?? f.energy,
        });
        analyzed++;
      } catch {
        // unreadable track — leave it, a later run retries
      }
    }
    return { scanned: Object.keys(all).length, analyzed };
  }
}
