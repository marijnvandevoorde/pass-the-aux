// Pure (DOM-free) beat-grid extraction: dynamic-programming beat tracker
// in the Ellis (2007) style on top of the broadband onset envelope, plus
// a low-band ("kick") onset envelope for downbeat-phase detection and a
// "first solid cuepoint" heuristic.
//
// Pipeline (samples → grid):
//   1. broadband onset envelope (reuse tempo-estimate.ts)
//   2. Hann-smooth the envelope (~70 ms) so DP locks onto beat clusters
//      rather than single-frame spikes
//   3. dynamic-programming pass with a log-square period penalty around
//      the seed BPM; backtrace gives beat frames
//   4. parabolic peak refinement at each beat for sub-hop precision
//   5. low-band onset envelope (≤150 Hz biquad LPF on the samples,
//      then the same flux); fold energy into 4 phases; argmax = downbeat
//   6. "first solid beat" = first beat where 8 consecutive beats all
//      clear a fraction of the top-quartile local onset energy; snap to
//      the nearest downbeat in that window
//
// Returns `null` when the result is not trustworthy (silence, no
// envelope variance, DP confidence below threshold).
//
// NB: the onset-envelope helper is duplicated from `tempo-estimate`
// rather than imported. This file is dual-target (Node server side via
// type-stripping AND the browser bundle via tsc) and the two toolchains
// disagree about how to spell a sibling import (`.ts` vs `.js`).
// Keeping the dependency zero side-steps the entire conflict — at the
// cost of ~25 lines of duplication that never need to drift.

const HOP_SECONDS = 0.01161; // matches tempo-estimate.ts

/** Half-wave-rectified log-energy flux, one value per hop. */
function onsetEnvelope(
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
    const e = Math.log1p(1000 * Math.sqrt(sum / hop));
    if (f > 0) env[f - 1] = Math.max(0, e - prev);
    prev = e;
  }
  return { env, rate: sampleRate / hop };
}

export interface BeatGridResult {
  /** Beat times in seconds, strictly ascending. */
  beats: Float32Array;
  /** Which of every-4 beats is the downbeat (0..3). */
  downbeatPhase: 0 | 1 | 2 | 3;
  /** Index into `beats` of the first "solid" downbeat; -1 = none found. */
  firstSolidBeatIndex: number;
  /** 0..1; DP backtrace score normalised by the number of beats. */
  confidence: number;
}

const SMOOTH_SEC = 0.07; // Hann window for envelope smoothing
const PRED_WIN_LO = 0.5; // predecessor search lower bound (× expected period τ)
const PRED_WIN_HI = 2.0; // predecessor search upper bound (× τ)
const LAMBDA = 250; // period-penalty weight (Ellis recommends 100–400)
const KICK_HZ = 150; // low-band cutoff for downbeat detection
const CONFIDENCE_MIN = 0.08; // gate; below this we return null
const FIRST_SOLID_RUN = 8; // require N consecutive strong beats
const FIRST_SOLID_FRAC = 0.35; // fraction of the top-quartile median

/** In-place Hann smoothing over a window of `2·radius + 1` samples. */
function hannSmooth(env: Float32Array, radius: number): Float32Array {
  if (radius <= 0) return env;
  const w = new Float32Array(radius * 2 + 1);
  let wsum = 0;
  for (let i = 0; i < w.length; i++) {
    const v = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (w.length - 1)));
    w[i] = v;
    wsum += v;
  }
  for (let i = 0; i < w.length; i++) w[i]! /= wsum;
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= env.length) continue;
      s += env[j]! * w[k + radius]!;
    }
    out[i] = s;
  }
  return out;
}

/** Parabolic vertex offset from the three samples around a peak.
 *  Returns the sub-sample correction δ in (-1, 1) to add to the peak index. */
function parabolicOffset(yL: number, y0: number, yR: number): number {
  const denom = yL - 2 * y0 + yR;
  if (denom === 0) return 0;
  const d = (0.5 * (yL - yR)) / denom;
  return d > 1 ? 1 : d < -1 ? -1 : d;
}

/** One-pass DP beat tracker. Returns beat frame indices (sub-frame
 *  resolution), or null when no beats can be tracked confidently. */
function dpBeats(
  env: Float32Array,
  envRate: number,
  seedBpm: number,
): { beatFrames: Float32Array; confidence: number } | null {
  const period = (60 * envRate) / seedBpm; // frames per beat
  const loLag = Math.max(2, Math.floor(period * PRED_WIN_LO));
  const hiLag = Math.max(loLag + 1, Math.ceil(period * PRED_WIN_HI));
  if (env.length <= hiLag + 2) return null;

  // Precompute penalty LUT: penalty[Δ] = λ · (log(period/Δ))²
  // Δ ranges over [loLag, hiLag]; we store it by index for cache-friendly access.
  const penalty = new Float32Array(hiLag + 1);
  for (let d = loLag; d <= hiLag; d++) {
    const r = Math.log(period / d);
    penalty[d] = LAMBDA * r * r;
  }

  const N = env.length;
  const C = new Float32Array(N); // cumulative DP score
  const P = new Int32Array(N); // backpointer
  P[0] = -1;
  C[0] = env[0]!;
  for (let t = 1; t < N; t++) {
    let bestScore = -Infinity;
    let bestPrev = -1;
    const lo = Math.max(0, t - hiLag);
    const hi = Math.max(0, t - loLag);
    for (let tp = lo; tp <= hi; tp++) {
      const s = C[tp]! - penalty[t - tp]!;
      if (s > bestScore) {
        bestScore = s;
        bestPrev = tp;
      }
    }
    // The "no predecessor" baseline allows DP to start anywhere in the track.
    if (bestPrev === -1 || bestScore < 0) {
      C[t] = env[t]!;
      P[t] = -1;
    } else {
      C[t] = env[t]! + bestScore;
      P[t] = bestPrev;
    }
  }

  // Pick the best tail frame as the end of the beat chain.
  let endIdx = N - 1;
  let endScore = C[N - 1]!;
  for (let t = N - 1; t >= Math.max(0, N - hiLag); t--) {
    if (C[t]! > endScore) {
      endScore = C[t]!;
      endIdx = t;
    }
  }
  if (endScore <= 0) return null;

  // Backtrack the chain.
  const chain: number[] = [];
  let cur = endIdx;
  while (cur >= 0) {
    chain.push(cur);
    cur = P[cur]!;
  }
  chain.reverse();
  if (chain.length < 4) return null;

  // Parabolic peak refinement for sub-frame precision.
  const beatFrames = new Float32Array(chain.length);
  for (let i = 0; i < chain.length; i++) {
    const k = chain[i]!;
    if (k > 0 && k < N - 1) {
      beatFrames[i] = k + parabolicOffset(env[k - 1]!, env[k]!, env[k + 1]!);
    } else {
      beatFrames[i] = k;
    }
  }

  // Confidence = mean DP score per beat, normalised by mean onset energy.
  let envMean = 0;
  for (let i = 0; i < N; i++) envMean += env[i]!;
  envMean /= N;
  const confidence =
    envMean > 0 ? Math.min(1, endScore / chain.length / envMean / 2) : 0;
  return { beatFrames, confidence };
}

/** RBJ biquad lowpass (Q=0.707) applied in-place. */
function biquadLowpass(
  samples: Float32Array,
  sampleRate: number,
  cutoffHz: number,
): Float32Array {
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate;
  const cosw = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * 0.707);
  const b0 = (1 - cosw) / 2;
  const b1 = 1 - cosw;
  const b2 = (1 - cosw) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosw;
  const a2 = 1 - alpha;
  const out = new Float32Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i]!;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** Sum the kick-band envelope at each of the 4 candidate downbeat phases;
 *  argmax wins. */
function pickDownbeatPhase(
  beatFrames: Float32Array,
  kickEnv: Float32Array,
): 0 | 1 | 2 | 3 {
  const sums: [number, number, number, number] = [0, 0, 0, 0];
  for (let i = 0; i < beatFrames.length; i++) {
    const k = Math.round(beatFrames[i]!);
    if (k < 0 || k >= kickEnv.length) continue;
    // Sample a tiny window around the beat to be robust to small frame drift.
    let e = 0;
    for (let d = -1; d <= 1; d++) {
      const j = k + d;
      if (j >= 0 && j < kickEnv.length) e += kickEnv[j]!;
    }
    const phase = (i % 4) as 0 | 1 | 2 | 3;
    sums[phase] = sums[phase] + e;
  }
  let bestPhase: 0 | 1 | 2 | 3 = 0;
  let bestSum = sums[0];
  for (let p = 1; p < 4; p++) {
    if (sums[p]! > bestSum) {
      bestSum = sums[p]!;
      bestPhase = p as 0 | 1 | 2 | 3;
    }
  }
  return bestPhase;
}

/** Find the first beat at which the next FIRST_SOLID_RUN beats all
 *  exceed a fraction of the median of the top quartile of local onset
 *  energy across the track. Snap to nearest downbeat in that window. */
function findFirstSolidBeat(
  beatFrames: Float32Array,
  env: Float32Array,
  downbeatPhase: 0 | 1 | 2 | 3,
): number {
  const localE = new Float32Array(beatFrames.length);
  for (let i = 0; i < beatFrames.length; i++) {
    const k = Math.round(beatFrames[i]!);
    let e = 0;
    for (let d = -2; d <= 2; d++) {
      const j = k + d;
      if (j >= 0 && j < env.length) e += env[j]!;
    }
    localE[i] = e;
  }
  // Median of the top quartile (cheap proxy: sort copy, pick 87.5th percentile).
  const sorted = Array.from(localE).sort((a, b) => a - b);
  if (sorted.length === 0) return -1;
  const refIdx = Math.floor(sorted.length * 0.875);
  const ref = sorted[Math.min(sorted.length - 1, refIdx)]!;
  if (ref <= 0) return -1;
  const threshold = FIRST_SOLID_FRAC * ref;

  for (let i = 0; i + FIRST_SOLID_RUN <= localE.length; i++) {
    let allOver = true;
    for (let k = 0; k < FIRST_SOLID_RUN; k++) {
      if (localE[i + k]! < threshold) {
        allOver = false;
        break;
      }
    }
    if (!allOver) continue;
    // Snap to the first downbeat at or after `i` within the next bar.
    for (let k = 0; k < 4 && i + k < localE.length; k++) {
      if (((i + k) % 4) === downbeatPhase) return i + k;
    }
    return i;
  }
  return -1;
}

/**
 * Compute a beat grid for an audio signal seeded with a BPM estimate.
 *
 * Returns `null` for signals without a trackable pulse (silence, noise,
 * free-time material). Callers should fall back to plain BPM math.
 */
export function trackBeats(
  samples: Float32Array,
  sampleRate: number,
  seedBpm: number,
): BeatGridResult | null {
  if (samples.length < sampleRate) return null;
  if (!Number.isFinite(seedBpm) || seedBpm <= 0) return null;

  const { env: rawEnv, rate: envRate } = onsetEnvelope(samples, sampleRate);
  if (rawEnv.length < 32) return null;

  // Variance gate: silent / flat signals get bounced.
  let mean = 0;
  for (let i = 0; i < rawEnv.length; i++) mean += rawEnv[i]!;
  mean /= rawEnv.length;
  let variance = 0;
  for (let i = 0; i < rawEnv.length; i++) {
    const d = rawEnv[i]! - mean;
    variance += d * d;
  }
  if (variance / rawEnv.length < 1e-6) return null;

  const env = hannSmooth(rawEnv, Math.max(1, Math.round(envRate * SMOOTH_SEC)));

  const dp = dpBeats(env, envRate, seedBpm);
  if (!dp || dp.confidence < CONFIDENCE_MIN) return null;

  // Tempo-doubled trap: if median inter-beat interval implies BPM > 180
  // *and* the every-other-beat energy is much stronger, halve the grid.
  // Use the RAW envelope here — the Hann smoother bleeds between adjacent
  // beats at high tempos, masking the even/odd skew the heuristic relies on.
  const halved = maybeHalveDouble(dp.beatFrames, rawEnv, envRate);
  const beatFrames = halved ?? dp.beatFrames;

  // Convert beat frames to seconds.
  const beats = new Float32Array(beatFrames.length);
  for (let i = 0; i < beatFrames.length; i++) {
    beats[i] = beatFrames[i]! / envRate;
  }

  // Downbeat phase from the kick-band onset envelope.
  const kickSamples = biquadLowpass(samples, sampleRate, KICK_HZ);
  const { env: kickEnv } = onsetEnvelope(kickSamples, sampleRate);
  const downbeatPhase = pickDownbeatPhase(beatFrames, kickEnv);

  const firstSolidBeatIndex = findFirstSolidBeat(beatFrames, env, downbeatPhase);

  return {
    beats,
    downbeatPhase,
    firstSolidBeatIndex,
    confidence: dp.confidence,
  };
}

/** If the median inter-beat interval implies BPM > 180 and even-index
 *  beats are notably stronger than odd-index ones, return a halved
 *  beat-frame array (every other beat dropped). Else null. */
function maybeHalveDouble(
  beatFrames: Float32Array,
  env: Float32Array,
  envRate: number,
): Float32Array | null {
  if (beatFrames.length < 8) return null;
  const intervals = new Float32Array(beatFrames.length - 1);
  for (let i = 0; i < intervals.length; i++) {
    intervals[i] = beatFrames[i + 1]! - beatFrames[i]!;
  }
  const sorted = Array.from(intervals).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  if (median <= 0) return null;
  const bpm = (60 * envRate) / median;
  if (bpm <= 180) return null;

  // Compare even vs odd beat energy.
  let evenE = 0;
  let oddE = 0;
  for (let i = 0; i < beatFrames.length; i++) {
    const k = Math.round(beatFrames[i]!);
    if (k < 0 || k >= env.length) continue;
    const e = env[k]!;
    if (i % 2 === 0) evenE += e;
    else oddE += e;
  }
  if (evenE <= 0 || oddE <= 0) return null;
  // The onset-envelope log-compression flattens raw amplitude differences,
  // so a 4x-louder beat only doubles env energy. 1.25x skew is a confident
  // tempo-double signature at this stage of the pipeline.
  if (evenE < oddE * 1.25 && oddE < evenE * 1.25) return null;

  // Keep the stronger half.
  const keepEven = evenE >= oddE;
  const halved = new Float32Array(Math.ceil(beatFrames.length / 2));
  let w = 0;
  for (let i = keepEven ? 0 : 1; i < beatFrames.length; i += 2) {
    halved[w++] = beatFrames[i]!;
  }
  return halved.subarray(0, w);
}
