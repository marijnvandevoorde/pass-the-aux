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
  /** Which of every-4 beats is the downbeat (4/4 assumption). Only used
   *  when `barStarts` is missing. */
  downbeatPhase: 0 | 1 | 2 | 3;
  /** Index into `beats` of every bar's downbeat, ascending (pass-the-beat
   *  ≥ analyzer v3). A bar of 3 or 5 beats moves the later bars, which
   *  `i % 4` can't express. Missing / null: bars follow `downbeatPhase`. */
  barStarts?: Int32Array | null;
  /** Index into `beats` of the first "solid" downbeat (intro past, full
   *  mix in). `-1` means none detected (callers fall back to beat 0). */
  firstSolidBeatIndex: number;
  /** Index into `beats` of the mix-out downbeat: the phrase boundary
   *  where the outro starts (pass-the-beat ≥ analyzer v3). `-1` or
   *  missing: none, Automix fades a fixed time before the end. */
  mixOutBeatIndex?: number;
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
 *  (each analyzer reports its own version via `beatAnalyzerVersion`).
 *  3: the library BPM is taken from the same run as the grid, so every
 *  track is re-gridded once to replace BPMs that came from a fallback.
 *  4: pass-the-beat's BPM is no longer quantised to its 50 fps frame
 *  grid (125 / 130.4 instead of 128); re-grid to pick up the real one.
 *  5: pass-the-beat analyzer v3: cleaned grid and robust bar phase (v2),
 *  per-bar downbeats and the mix-out point. Needs that sidecar deployed
 *  first, or the re-grid stores grids without them. */
export const BEATTHIS_ANALYZER_VERSION = 5;

/** Resolve the first "solid" cuepoint in seconds, or `null` when the
 *  grid has no solid run. Centralised so both browser and server agree. */
export function firstSolidCueSec(grid: BeatGrid): number | null {
  if (grid.firstSolidBeatIndex < 0) return null;
  const idx = grid.firstSolidBeatIndex;
  if (idx >= grid.beats.length) return null;
  return grid.beats[idx] ?? null;
}

/** The mix-out point in seconds, or `null` when the grid has none. */
export function mixOutCueSec(grid: BeatGrid): number | null {
  const idx = grid.mixOutBeatIndex ?? -1;
  if (idx < 0 || idx >= grid.beats.length) return null;
  return grid.beats[idx] ?? null;
}

/** `barStarts` if it is usable for these beats (ascending, in range, bars
 *  of 1-8 beats), else null so callers fall back to `downbeatPhase`. */
export function validBarStarts(
  barStarts: ArrayLike<number> | null | undefined,
  beatCount: number,
): Int32Array | null {
  if (!barStarts || barStarts.length === 0) return null;
  const out = new Int32Array(barStarts.length);
  for (let k = 0; k < barStarts.length; k++) {
    const i = barStarts[k];
    if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= beatCount) return null;
    if (k > 0) {
      const len = i - out[k - 1]!;
      if (len < 1 || len > 8) return null;
    }
    out[k] = i;
  }
  return out;
}
