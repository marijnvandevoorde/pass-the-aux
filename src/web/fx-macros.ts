// Pure (DOM-free) one-touch FX macros (the "FX list" tab). Each is a
// momentary preset: held = these params on the focused deck, released =
// fully dry. `build(beatSec)` so beat-synced ones (Chop/Echo Out) lock
// to the deck tempo. Unit-tested.

import type { FxParams } from "./xy-map.js";

export interface FxMacro {
  name: string;
  build(beatSec: number): FxParams;
}

export const FX_MACROS: readonly FxMacro[] = [
  { name: "Absorb", build: () => ({ filter: -0.82, reverbWet: 1.5 }) },
  {
    name: "Drift",
    build: () => ({
      flangerWet: 1.1,
      flangerRate: 0.25,
      flangerDepth: 0.005,
    }),
  },
  {
    name: "Chop",
    build: (beat) => ({ gateDepth: 1, gateRate: 1 / (beat * 0.25) }),
  },
  {
    name: "Echo Out",
    build: (beat) => ({
      delayTime: beat * 0.5,
      delayWet: 1.4,
      delayFeedback: 0.85,
    }),
  },
  { name: "Sweep Up", build: () => ({ filter: 0.85 }) },
  { name: "Crush", build: () => ({ crushWet: 1.1, crushBits: 3 }) },
  { name: "Phase", build: () => ({ phaserWet: 1.2, phaserRate: 0.4 }) },
  { name: "Siren", build: () => ({ alarmLevel: 0.5, alarmPitch: 330 }) },
  {
    name: "Strobe",
    build: (beat) => ({ strobeAmount: 1, strobeRate: 1 / (beat * 0.125) }),
  },
] as const;
