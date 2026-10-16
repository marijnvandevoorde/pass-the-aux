import type { BeatGrid } from "../beat-grid.ts";

/** Server-side audio analysis (decode + DSP). Returns the same
 *  features the browser analyser produces; null when the file can't
 *  be read/decoded (e.g. ffmpeg unavailable, not audio, < 1 s). */
export interface AudioFeatures {
  bpm: number | null;
  key: string | null;
  mode: string | null;
  camelot: string | null;
  energy: number | null;
}

/** A beat grid as an analyzer returns it. An empty `beats` array means
 *  "analysed, no trackable pulse": it is stored so the track is not sent
 *  to the same analyzer again. `bpm` is the tempo the analyzer measured
 *  alongside the grid, when it has one; it is not part of the stored grid
 *  but replaces the library BPM so the two agree. */
export type AnalyzedBeats = Omit<BeatGrid, "analyzedAt"> & {
  bpm?: number | null;
};

export interface AudioAnalyzer {
  /** Version stamp of this analyzer's beat-grid output. `BuildBeatGrids`
   *  rebuilds any stored grid below this version, so flipping the
   *  `BEAT_ANALYZER` toggle re-grids the library with the new engine. */
  readonly beatAnalyzerVersion: number;
  /** `trackId` is the bare filename within the user's music dir. */
  analyze(trackId: string): Promise<AudioFeatures | null>;
  /** per-track beat grid for phase-aligned crossfades. Null
   *  when no trackable pulse (silence/noise/free-time) or the file can't
   *  be decoded/reached — retried on the next run. Throws
   *  `AnalyzerUnavailableError` when the engine itself is down, which
   *  ends the run (the remaining tracks would fail the same way). */
  analyzeBeats(trackId: string): Promise<AnalyzedBeats | null>;
}
