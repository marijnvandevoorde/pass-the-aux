// Pure (DOM-free) musical-key + energy estimation, unit-tested under
// node:test like tempo-estimate. Cheap and deterministic — no ML.
//
// Key: a 12-bin chroma (Goertzel at each pitch class over octaves 2–6)
// correlated against the Krumhansl–Schmuckler major/minor profiles.
// Energy: scaled RMS, 0..1. Both inherit the BPM caveat — material
// without clear tonality/beat is approximate.

const NOTES = [
  "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
] as const;

// Camelot wheel codes indexed by pitch class (0 = C).
const CAMELOT_MAJOR = [
  "8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B",
];
const CAMELOT_MINOR = [
  "5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A",
];

const KS_MAJOR = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const KS_MINOR = [
  6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

export interface KeyResult {
  key: string;
  mode: "major" | "minor";
  camelot: string;
}

/** Scaled RMS loudness, 0..1. Silence → 0. */
export function estimateEnergy(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / samples.length) * 2.2);
}

/** Goertzel magnitude at frequency `freq` over a (decimated) signal. */
function goertzel(
  x: Float32Array,
  step: number,
  rate: number,
  freq: number,
): number {
  const w = (2 * Math.PI * freq) / rate;
  const coeff = 2 * Math.cos(w);
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let n = 0;
  for (let i = 0; i < x.length; i += step) {
    s0 = x[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
    n++;
  }
  if (n === 0) return 0;
  const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return power > 0 ? Math.sqrt(power) / n : 0;
}

export function estimateKey(
  samples: Float32Array,
  sampleRate: number,
): KeyResult | null {
  if (samples.length < sampleRate) return null; // < 1 s

  // Decimate to ~11 kHz and analyse a bounded central window.
  const step = Math.max(1, Math.floor(sampleRate / 11025));
  const win = Math.min(samples.length, sampleRate * 30);
  const lo = Math.floor((samples.length - win) / 2);
  const x = samples.subarray(lo, lo + win);
  const effRate = sampleRate;

  const chroma = new Float32Array(12);
  for (let pc = 0; pc < 12; pc++) {
    let mag = 0;
    // MIDI octaves 2..6 → midi note = 12*(oct+1)+pc.
    for (let oct = 2; oct <= 6; oct++) {
      const midi = 12 * (oct + 1) + pc;
      const freq = 440 * Math.pow(2, (midi - 69) / 12);
      if (freq < effRate / (2 * step)) {
        mag += goertzel(x, step, effRate, freq);
      }
    }
    chroma[pc] = mag;
  }

  let total = 0;
  for (let i = 0; i < 12; i++) total += chroma[i]!;
  if (total <= 1e-9) return null; // no tonal content

  let best = -Infinity;
  let bestPc = 0;
  let bestMajor = true;
  for (let t = 0; t < 12; t++) {
    let maj = 0;
    let min = 0;
    for (let i = 0; i < 12; i++) {
      const c = chroma[(i + t) % 12]!;
      maj += c * KS_MAJOR[i]!;
      min += c * KS_MINOR[i]!;
    }
    if (maj > best) {
      best = maj;
      bestPc = t;
      bestMajor = true;
    }
    if (min > best) {
      best = min;
      bestPc = t;
      bestMajor = false;
    }
  }

  return {
    key: NOTES[bestPc]!,
    mode: bestMajor ? "major" : "minor",
    camelot: (bestMajor ? CAMELOT_MAJOR : CAMELOT_MINOR)[bestPc]!,
  };
}
