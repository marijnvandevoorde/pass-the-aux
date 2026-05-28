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

export interface AudioAnalyzer {
  /** Version stamp of this analyzer's beat-grid output. `BuildBeatGrids`
   *  rebuilds any stored grid below this version, so flipping the
   *  `BEAT_ANALYZER` toggle re-grids the library with the new engine. */
  readonly beatAnalyzerVersion: number;
  /** `trackId` is the bare filename within the user's music dir. */
  analyze(trackId: string): Promise<AudioFeatures | null>;
  /** per-track beat grid for phase-aligned crossfades. Null
   *  when no trackable pulse (silence/noise/free-time) or the file can't
   *  be decoded/reached. */
  analyzeBeats(trackId: string): Promise<Omit<BeatGrid, "analyzedAt"> | null>;
}
