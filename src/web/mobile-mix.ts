// Pure (DOM-free) timing for the mobile DJ's crossfade: where the next
// bar is, and when the automatic transition at the end of a track starts.
// With a mix-out point from pass-the-beat the next track comes in on the
// outro's phrase, with the fade fitted to whole bars of the outro, like
// desktop Automix; without one it fades just before the end, as before.
//
// Self-contained on purpose (no value imports): Node runs it directly for
// the unit tests and the browser loads its compiled form, and the two
// spell sibling imports differently (see fade-to-next-plan.ts).

export interface MobileGrid {
  beats: ArrayLike<number>;
  downbeatPhase: 0 | 1 | 2 | 3;
  /** Every bar's downbeat (indices into `beats`); absent: every 4th beat
   *  from `downbeatPhase`. */
  barStarts?: ArrayLike<number> | null;
  /** Where the next track should come in (seconds); absent: none. */
  mixOutCueSec?: number | null;
}

export interface MixOutPlan {
  /** Track time at which the incoming track starts. */
  startSec: number;
  /** Fade length in seconds, whole bars of the outro. */
  fadeSec: number;
}

/** How long before the mix-out point the phone starts loading the next
 *  track, so it is ready on the downbeat. */
export const MIX_OUT_LEAD_SEC = 4;
/** Without a mix-out point: start the fade this long before it must end. */
const END_MARGIN_SEC = 0.75;
const FADE_BARS = [1, 2, 4, 8, 16, 32];

/** Time of the first downbeat strictly after `posSec`, or null. */
export function nextBarAfter(grid: MobileGrid, posSec: number): number | null {
  const { beats, downbeatPhase, barStarts } = grid;
  if (barStarts && barStarts.length > 0) {
    for (let k = 0; k < barStarts.length; k++) {
      const t = beats[barStarts[k] ?? -1];
      if (t !== undefined && t > posSec) return t;
    }
    return null;
  }
  for (let i = downbeatPhase; i < beats.length; i += 4) {
    const t = beats[i];
    if (t !== undefined && t > posSec) return t;
  }
  return null;
}

/** Median beat length around `atSec` (8 intervals), or null. */
export function beatLengthNear(beats: ArrayLike<number>, atSec: number): number | null {
  if (beats.length < 3) return null;
  let i = 0;
  while (i < beats.length - 1 && (beats[i] ?? 0) < atSec) i++;
  const from = Math.max(1, i - 4);
  const to = Math.min(beats.length - 1, from + 8);
  const gaps: number[] = [];
  for (let j = from; j <= to; j++) {
    const g = (beats[j] ?? 0) - (beats[j - 1] ?? 0);
    if (g > 0) gaps.push(g);
  }
  if (gaps.length === 0) return null;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? null;
}

/** The bar count from FADE_BARS whose length is closest to `wantedSec`
 *  and still ends before the track does. Null when not one bar fits. */
export function fitFade(
  wantedSec: number,
  startSec: number,
  durationSec: number,
  beatLenSec: number,
): number | null {
  if (!(beatLenSec > 0) || !(durationSec > startSec)) return null;
  const bar = 4 * beatLenSec;
  const room = durationSec - startSec - beatLenSec / 4;
  let best: number | null = null;
  for (const bars of FADE_BARS) {
    const len = bars * bar;
    if (len > room) break;
    if (best === null || Math.abs(len - wantedSec) < Math.abs(best - wantedSec)) best = len;
  }
  return best;
}

/** The transition at the mix-out point, or null when there is none, it
 *  has passed, or less than a bar is left after it. */
export function planMixOut(
  grid: MobileGrid | null,
  durationSec: number,
  nowSec: number,
  wantedFadeSec: number,
): MixOutPlan | null {
  const m = grid?.mixOutCueSec;
  if (!grid || typeof m !== "number" || !Number.isFinite(m)) return null;
  if (!(durationSec > 0) || m >= durationSec || m <= nowSec + 0.25) return null;
  const beatLen = beatLengthNear(grid.beats, m);
  if (beatLen === null) return null;
  const fadeSec = fitFade(wantedFadeSec, m, durationSec, beatLen);
  return fadeSec === null ? null : { startSec: m, fadeSec };
}

/** Whether the automatic transition should start now: shortly before
 *  the mix-out point, or near the end of the track without one. */
export function autoMixDue(
  plan: MixOutPlan | null,
  durationSec: number,
  nowSec: number,
  fadeSec: number,
): boolean {
  if (plan) return nowSec >= plan.startSec - MIX_OUT_LEAD_SEC;
  return durationSec - nowSec <= fadeSec + END_MARGIN_SEC;
}
