import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateTempo,
  onsetEnvelope,
} from "../../src/web/tempo-estimate.ts";

const SR = 44100;

/** Deterministic LCG so the noise/jitter tests are reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** A click train at `bpm`, optional per-beat tempo jitter (fraction). */
function clickTrain(
  durSec: number,
  bpm: number,
  jitter = 0,
  rng: () => number = () => 0,
): Float32Array {
  const n = Math.floor(SR * durSec);
  const a = new Float32Array(n);
  const period = 60 / bpm;
  const clickLen = Math.floor(SR * 0.03);
  for (let t = 0.5; t < durSec; ) {
    const idx = Math.floor(t * SR);
    for (let k = 0; k < clickLen && idx + k < n; k++) {
      a[idx + k]! += Math.exp(-k / (SR * 0.004)) * Math.sin(k * 0.4);
    }
    t += period * (1 + (jitter ? (rng() * 2 - 1) * jitter : 0));
  }
  return a;
}

for (const bpm of [90, 120, 150]) {
  test(`locks a steady ${bpm} BPM click train`, () => {
    const got = estimateTempo(clickTrain(12, bpm), SR);
    assert.ok(got !== null, "expected a tempo");
    assert.ok(
      Math.abs(got - bpm) <= 4,
      `expected ~${bpm}, got ${got}`,
    );
  });
}

test("silence returns null (no pulse to find)", () => {
  assert.equal(estimateTempo(new Float32Array(SR * 4), SR), null);
});

test("white noise returns null rather than a garbage BPM", () => {
  const rng = lcg(42);
  const noise = new Float32Array(SR * 6);
  for (let i = 0; i < noise.length; i++) noise[i] = rng() * 2 - 1;
  assert.equal(estimateTempo(noise, SR), null);
});

test("clips shorter than 1 s return null", () => {
  assert.equal(estimateTempo(new Float32Array(SR / 2), SR), null);
});

test("resolves rubato (jittered) material the old greedy method would miss", () => {
  const got = estimateTempo(clickTrain(20, 128, 0.08, lcg(7)), SR);
  assert.ok(got !== null, "rubato should still resolve to an average tempo");
  assert.ok(Math.abs(got - 128) <= 12, `expected ~128, got ${got}`);
});

test("onsetEnvelope is one value per hop and non-negative", () => {
  const { env, rate } = onsetEnvelope(clickTrain(3, 120), SR);
  assert.ok(rate > 50 && rate < 200);
  assert.ok(env.length > 100);
  assert.ok(env.every((v) => v >= 0));
});
