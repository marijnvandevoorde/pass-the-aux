// Pure (DOM-free) tempo estimation so it can be unit-tested under node:test.
//
// Greedy kick-peak picking (the old approach) fails on rubato or beatless
// material: with no loud isolated transient there are too few peaks and it
// bails. Instead we build a broadband onset-strength envelope (log-energy
// flux) and pick the tempo by autocorrelation with harmonic summation —
// a robust, well-established method that also rejects truly beatless audio
// via a confidence gate instead of emitting a garbage number.

const HOP_SECONDS = 0.01161; // ~512 samples @ 44.1 kHz
const MIN_BPM = 70;
const MAX_BPM = 200;
const FOLD_LOW = 76;
const FOLD_HIGH = 180;
const CONFIDENCE_MIN = 0.12;
const MAX_WINDOW_SECONDS = 90; // analyse a bounded central window

/** Half-wave-rectified log-energy flux, one value per hop. */
export function onsetEnvelope(
  samples: Float32Array,
  sampleRate: number,
): { env: Float32Array; rate: number } {
  const hop = Math.max(1, Math.round(sampleRate * HOP_SECONDS));
  const frames = Math.floor(samples.length / hop);
  const env = new Float32Array(Math.max(0, frames - 1));
  let prev = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const start = f * hop;
    for (let i = 0; i < hop; i++) {
      const s = samples[start + i] ?? 0;
      sum += s * s;
    }
    // Log compression keeps soft/beatless dynamics from vanishing next to
    // loud sections.
    const e = Math.log1p(1000 * Math.sqrt(sum / hop));
    if (f > 0) env[f - 1] = Math.max(0, e - prev);
    prev = e;
  }
  return { env, rate: sampleRate / hop };
}

function autocorr(x: Float32Array, lag: number): number {
  if (lag <= 0) {
    let s = 0;
    for (let i = 0; i < x.length; i++) s += x[i]! * x[i]!;
    return s;
  }
  if (lag >= x.length) return 0;
  let s = 0;
  for (let i = 0; i + lag < x.length; i++) s += x[i]! * x[i + lag]!;
  return s;
}

/**
 * Estimate tempo in BPM, or null when there is no stable pulse (silence,
 * noise, or genuinely beatless material) — better than guessing.
 */
export function estimateTempo(
  samples: Float32Array,
  sampleRate: number,
): number | null {
  if (samples.length < sampleRate) return null; // < 1 s
  const { env, rate } = onsetEnvelope(samples, sampleRate);
  if (env.length < 16) return null;

  // Bound the analysis to a central window for speed and to limit how far
  // rubato tempo drift can smear the estimate.
  const maxWin = Math.round(rate * MAX_WINDOW_SECONDS);
  let lo = 0;
  let hi = env.length;
  if (env.length > maxWin) {
    lo = Math.floor((env.length - maxWin) / 2);
    hi = lo + maxWin;
  }

  let mean = 0;
  for (let i = lo; i < hi; i++) mean += env[i]!;
  mean /= hi - lo;

  const x = new Float32Array(hi - lo);
  let energy = 0;
  for (let i = lo; i < hi; i++) {
    const v = env[i]! - mean;
    x[i - lo] = v;
    energy += v * v;
  }
  if (energy <= 1e-9) return null; // flat / silent

  const minLag = Math.max(2, Math.floor((60 * rate) / MAX_BPM));
  const maxLag = Math.min(x.length - 1, Math.ceil((60 * rate) / MIN_BPM));
  if (maxLag <= minLag) return null;

  let bestLag = -1;
  let bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Harmonic summation pulls double/half-time octave errors back in.
    const score =
      autocorr(x, lag) +
      0.6 * autocorr(x, lag * 2) +
      0.3 * autocorr(x, lag * 3);
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag < 0) return null;

  const confidence = autocorr(x, bestLag) / energy;
  if (confidence < CONFIDENCE_MIN) return null; // no stable pulse

  let bpm = (60 * rate) / bestLag;
  while (bpm < FOLD_LOW) bpm *= 2;
  while (bpm > FOLD_HIGH) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}
