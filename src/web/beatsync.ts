// Pure (DOM-free) tempo + phase math for Automix auto-beatsync.
// The Automix engine reads deck state and calls deck.syncTo/bend; all the
// arithmetic that decides "is this safe?" and "how hard to nudge?" lives
// here so it can be unit-tested.

/** Nearest power-of-two multiple of `refBpm` to `inBpm` (octave fold).
 *  e.g. ref 90, in 178 → 180 (= 2×90); ref 128, in 64 → 64 (= ½×128). */
export function octaveMatchedTarget(refBpm: number, inBpm: number): number {
  if (refBpm <= 0 || inBpm <= 0) return refBpm;
  const k = Math.round(Math.log2(inBpm / refBpm));
  return refBpm * Math.pow(2, k);
}

/** Percent tempo change to take `inBpm` to `targetBpm`. */
export function tempoPercentFor(inBpm: number, targetBpm: number): number {
  if (inBpm <= 0) return 0;
  return (targetBpm / inBpm - 1) * 100;
}

/** Is the required tempo change small enough to be musical (vinyl range)? */
export function withinRange(percent: number, max = 8): boolean {
  return Number.isFinite(percent) && Math.abs(percent) <= max;
}

/** Signed value of `a` modulo `m`, folded into [-m/2, m/2). */
export function signedMod(a: number, m: number): number {
  if (m <= 0) return 0;
  let r = ((a % m) + m) % m;
  if (r >= m / 2) r -= m;
  return r;
}

/** Position within the beat grid as a fraction of a beat, [0, 1). */
export function beatFraction(
  posSec: number,
  cueSec: number,
  beatLenSec: number,
): number {
  if (beatLenSec <= 0) return 0;
  return (((posSec - cueSec) / beatLenSec) % 1 + 1) % 1;
}

/** Phase fraction relative to the *actual* beat grid: finds the nearest
 *  beat to `posSec` and returns the signed distance as a fraction of a
 *  beat, wrapped to [0, 1). Use this for phase-error computation when
 *  the deck has a real grid — `beatFraction` with a default cuePoint
 *  of 0 is wrong unless the grid happens to start at time 0. */
export function gridBeatFraction(
  beats: ArrayLike<number>,
  posSec: number,
  beatLenSec: number,
): number {
  if (beatLenSec <= 0 || beats.length === 0) return 0;
  let nearest = beats[0] ?? 0;
  let nearestDist = Math.abs(nearest - posSec);
  for (let i = 1; i < beats.length; i++) {
    const t = beats[i];
    if (t === undefined) continue;
    const d = Math.abs(t - posSec);
    if (d < nearestDist) {
      nearest = t;
      nearestDist = d;
    }
    if (t > posSec + beatLenSec) break;
  }
  return beatFraction(posSec, nearest, beatLenSec);
}

/** Signed phase error (in beats, [-0.5, 0.5)) of incoming vs outgoing. */
export function phaseError(fIn: number, fOut: number): number {
  return signedMod(fIn - fOut, 1);
}

/**
 * Temporary pitch-bend to walk `errBeats` of phase error out over
 * `beats` beats, then release. Clamped so it's a gentle ride, never a
 * jump. errBeats > 0 ⇒ incoming is ahead ⇒ slow it down (bend < 1).
 */
export function phaseBend(
  errBeats: number,
  effBeatSec: number,
  beats = 2,
): { bend: number; durationMs: number } {
  const span = Math.max(0.001, beats);
  let bend = 1 - errBeats / span;
  bend = Math.min(1.06, Math.max(0.94, bend));
  return { bend, durationMs: Math.max(50, span * effBeatSec * 1000) };
}

/** index of the first beat strictly after `posSec`, or -1.
 *  Pure, unit-testable counterpart to `Deck.beatIndexAfter`. */
export function beatIndexAfter(
  beats: ArrayLike<number>,
  posSec: number,
): number {
  if (beats.length === 0) return -1;
  let lo = 0;
  let hi = beats.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((beats[mid] ?? 0) <= posSec) lo = mid + 1;
    else hi = mid;
  }
  return lo >= beats.length ? -1 : lo;
}

/** Track time of the next downbeat strictly after `posSec`, or null. */
export function nextDownbeatAfter(
  beats: ArrayLike<number>,
  posSec: number,
  downbeatPhase: 0 | 1 | 2 | 3,
): number | null {
  let i = beatIndexAfter(beats, posSec);
  if (i < 0) return null;
  while (i < beats.length) {
    if (((i % 4) as 0 | 1 | 2 | 3) === downbeatPhase) {
      return beats[i] ?? null;
    }
    i++;
  }
  return null;
}
