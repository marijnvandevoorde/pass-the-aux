// Pure (DOM-free) tempo drift policy for Automix.
//
// Every transition tempo-matches the incoming track to the one playing
// out, and without a policy the incoming deck keeps that tempo: track 2
// plays at track 1's tempo, track 3 at track 2's (already shifted) one,
// and over a night the set walks up to ±8 % away from any track's own
// tempo (pitch too, with keylock off).
//
// Policy: once a fade has finished and the new track plays alone, glide
// its tempo back to its native 0 % on an ease-in-out curve, slowly enough
// to be inaudible (GLIDE_PCT_PER_BAR, at least a phrase). So every track
// plays most of its length at its own tempo, the shift only ever exists
// around a transition, and it can't add up. A glide holds its current
// value and stops when the DJ touches the tempo, the deck stops, or the
// next transition starts (the next track then syncs to wherever the glide
// got to, and glides home in turn).

/** Steepest glide, in tempo percent per bar: 8 % takes 32 bars (about a
 *  minute at 128 BPM), roughly 2 cents of pitch per second. */
export const GLIDE_PCT_PER_BAR = 0.25;
/** Even a small offset glides over a whole phrase. */
export const GLIDE_MIN_BARS = 8;
/** Offsets below this are left alone (the tempo knob's resolution). */
export const GLIDE_MIN_PCT = 0.05;

/** What the glide needs from a deck. `Deck` satisfies it. */
export interface GlideDeck {
  readonly isPlaying: boolean;
  readonly buffer: unknown;
  readonly tempoPercent: number;
  /** Track-time seconds per beat, or null without a BPM. */
  readonly beatLengthSec: number | null;
  setTempo(percent: number): void;
}

/** Glide length in real seconds for an offset of `pct` percent. */
export function glideDurationSec(
  pct: number,
  beatLenSec: number | null,
  rate = 1,
): number {
  const bars = Math.max(GLIDE_MIN_BARS, Math.abs(pct) / GLIDE_PCT_PER_BAR);
  // No BPM: assume 120 (a bar of 2 s).
  const bar = (4 * (beatLenSec && beatLenSec > 0 ? beatLenSec : 0.5)) / (rate > 0 ? rate : 1);
  return bars * bar;
}

/** Tempo percent `t` seconds into a glide from `fromPct` to 0 lasting
 *  `durSec`: smoothstep, so it eases out of and into a steady tempo. */
export function glidePercent(fromPct: number, t: number, durSec: number): number {
  if (durSec <= 0 || t >= durSec) return 0;
  if (t <= 0) return fromPct;
  const x = t / durSec;
  const ease = x * x * (3 - 2 * x);
  return fromPct * (1 - ease);
}

export type GlideState = "idle" | "gliding";

export class TempoGlide {
  #deck: GlideDeck | null = null;
  #from = 0;
  #t0 = 0;
  #dur = 0;
  /** The tempo this glide set last: anything else means the DJ moved it. */
  #last = 0;

  get state(): GlideState {
    return this.#deck ? "gliding" : "idle";
  }

  /** The deck being glided, if any. */
  get deck(): GlideDeck | null {
    return this.#deck;
  }

  /** Start gliding `deck` home from its current tempo. Returns the glide
   *  length in seconds, or null when there is nothing to do. */
  start(deck: GlideDeck, nowSec: number): number | null {
    this.cancel();
    const pct = deck.tempoPercent;
    if (!Number.isFinite(pct) || Math.abs(pct) < GLIDE_MIN_PCT) return null;
    this.#deck = deck;
    this.#from = pct;
    this.#t0 = nowSec;
    this.#dur = glideDurationSec(pct, deck.beatLengthSec, 1 + pct / 100);
    this.#last = pct;
    return this.#dur;
  }

  /** Advance to `nowSec`. Stops (keeping the current tempo) when the DJ
   *  changed the tempo, or the deck stopped or was emptied. */
  step(nowSec: number): GlideState {
    const d = this.#deck;
    if (!d) return "idle";
    if (!d.buffer || !d.isPlaying || Math.abs(d.tempoPercent - this.#last) > 0.005) {
      this.cancel();
      return "idle";
    }
    const pct = glidePercent(this.#from, nowSec - this.#t0, this.#dur);
    // Two decimals is the tempo knob's resolution; finer steps only
    // re-anchor the deck's clock for nothing.
    const rounded = Math.round(pct * 100) / 100;
    if (rounded !== this.#last) {
      d.setTempo(rounded);
      this.#last = rounded;
    }
    if (pct === 0) {
      this.cancel();
      return "idle";
    }
    return "gliding";
  }

  /** Stop where it is (the tempo stays at its current value). */
  cancel(): void {
    this.#deck = null;
  }
}
