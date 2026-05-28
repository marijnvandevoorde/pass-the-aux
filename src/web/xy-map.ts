// Pure (DOM-free) mapping from normalised XY-pad coordinates (0..1, with
// y=1 at the top) to concrete per-effect parameters. Unit-tested; the
// pad UI and the deck setters stay dumb.

export type FxName =
  | "filter"
  | "echo"
  | "reverb"
  | "gate"
  | "flanger"
  | "phaser"
  | "bitcrush"
  | "alarm"
  | "strobe";

/** Effect cycle order for the ‹ › selector. */
export const FX_ORDER: readonly FxName[] = [
  "filter",
  "echo",
  "reverb",
  "gate",
  "strobe",
  "flanger",
  "phaser",
  "bitcrush",
  "alarm",
] as const;

export interface FxParams {
  filter?: number; // -1..1 bipolar (deck.setFilter)
  delayWet?: number; // 0..1.6
  delayTime?: number; // seconds
  delayFeedback?: number; // 0..0.88 (repeats)
  reverbWet?: number; // 0..1.8
  gateDepth?: number; // 0..1
  gateRate?: number; // Hz
  flangerWet?: number;
  flangerRate?: number; // Hz
  flangerDepth?: number; // seconds
  phaserWet?: number;
  phaserRate?: number; // Hz
  crushWet?: number;
  crushBits?: number; // 1..16
  alarmLevel?: number; // 0..1
  alarmPitch?: number; // Hz
  strobeAmount?: number; // 0..1
  strobeRate?: number; // Hz
}

const clamp01 = (n: number): number =>
  Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;

/** X → beat fraction: left=1 beat, middle=½, right=¼ (1/4·1/8·1/16). */
function division(x: number): number {
  const c = clamp01(x);
  return c < 1 / 3 ? 1 : c < 2 / 3 ? 0.5 : 0.25;
}

/** Finer beat fractions for the strobe (1/4 → 1/16 of a beat). */
function fastDivision(x: number): number {
  const c = clamp01(x);
  return c < 0.25 ? 0.5 : c < 0.5 ? 0.25 : c < 0.75 ? 0.125 : 0.0625;
}

export function mapEffect(
  fx: FxName,
  x: number,
  y: number,
  beatLenSec: number | null,
): FxParams {
  const X = clamp01(x);
  const Y = clamp01(y);
  const beat = beatLenSec && beatLenSec > 0 ? beatLenSec : 0.5;
  switch (fx) {
    case "filter":
      return { filter: X * 2 - 1 }; // centre = open, ←LP  HP→
    case "echo":
      return {
        delayTime: beat * division(X),
        delayWet: Y * 1.4, // up to a fully-wet slap
        delayFeedback: 0.25 + Y * 0.6, // 0.25 → 0.85 repeats
      };
    case "reverb":
      return { reverbWet: Y * 1.7 }; // big wash at the top
    case "gate":
      return { gateRate: 1 / (beat * division(X)), gateDepth: Y };
    case "flanger":
      return {
        flangerWet: Y * 1.2,
        flangerRate: 0.1 + X * 5,
        flangerDepth: 0.0008 + Y * 0.005,
      };
    case "phaser":
      return { phaserWet: Y * 1.2, phaserRate: 0.1 + X * 4 };
    case "bitcrush":
      return { crushBits: Math.round(8 - X * 7), crushWet: Y * 1.1 };
    case "alarm":
      return { alarmLevel: Y, alarmPitch: 140 + X * 460 };
    case "strobe":
      return { strobeAmount: Y, strobeRate: 1 / (beat * fastDivision(X)) };
  }
}
