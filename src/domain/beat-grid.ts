/**
 * Per-track beat grid. Used by the browser to schedule phase-aligned
 * crossfades against the next beat or downbeat of the currently
 * playing track, and to start the incoming track at a beat-aligned
 * "first solid cuepoint" past sparse intros.
 *
 * Kept separate from {@link AnalysisRecord} on purpose: this payload
 * is bulky (hundreds of floats) and only relevant when a deck loads
 * the track; bundling it into the library listing would 10× the page
 * payload for no UI gain.
 */
export interface BeatGrid {
  /** Track-relative filename, same key as `AnalysisRecord`. */
  trackId: string;
  /** Track duration in seconds (sanity check for stale grids). */
  durationSec: number;
  /** Beat onset times in seconds, strictly ascending. */
  beats: Float32Array;
  /** Which of every-4 beats is the downbeat (4/4 assumption). */
  downbeatPhase: 0 | 1 | 2 | 3;
  /** Index into `beats` of the first "solid" downbeat (intro past, full
   *  mix in). `-1` means none detected (callers fall back to beat 0). */
  firstSolidBeatIndex: number;
  /** Track-level confidence in [0, 1]; below ~0.1 the grid is suspect. */
  confidence: number;
  /** Unix-epoch ms when this grid was computed. */
  analyzedAt: number;
  /** Bump to invalidate stale grids on disk after algorithm changes. */
  analyzerVersion: number;
}

/** Local (Ellis-DP) analyzer version. Bump when {@link trackBeats}
 *  output shape or precision changes meaningfully. */
export const BEAT_GRID_ANALYZER_VERSION = 1;

/** Version stamp for grids produced by the pass-the-beat sidecar. Kept
 *  distinct from {@link BEAT_GRID_ANALYZER_VERSION} so `BuildBeatGrids`
 *  re-grids the library when the `BEAT_ANALYZER` toggle switches engines
 *  (each analyzer reports its own version via `beatAnalyzerVersion`). */
export const BEATTHIS_ANALYZER_VERSION = 2;

/** Resolve the first "solid" cuepoint in seconds, or `null` when the
 *  grid has no solid run. Centralised so both browser and server agree. */
export function firstSolidCueSec(grid: BeatGrid): number | null {
  if (grid.firstSolidBeatIndex < 0) return null;
  const idx = grid.firstSolidBeatIndex;
  if (idx >= grid.beats.length) return null;
  return grid.beats[idx] ?? null;
}
