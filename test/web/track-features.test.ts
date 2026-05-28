import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateEnergy,
  estimateKey,
} from "../../src/web/track-features.ts";

const SR = 44100;

function sine(freq: number, secs: number, amp = 1): Float32Array {
  const n = Math.floor(SR * secs);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

test("estimateEnergy: silence 0, bounded, louder > quieter", () => {
  assert.equal(estimateEnergy(new Float32Array(SR)), 0);
  const quiet = estimateEnergy(sine(220, 1, 0.05));
  const loud = estimateEnergy(sine(220, 1, 1));
  assert.ok(loud > quiet);
  assert.ok(loud <= 1 && quiet >= 0);
});

test("estimateKey resolves a pure tone to its pitch class", () => {
  // A4 = 440 Hz → pitch class A.
  const a = estimateKey(sine(440, 3), SR);
  assert.ok(a !== null);
  assert.equal(a.key, "A");
  assert.match(a.camelot, /^\d{1,2}[AB]$/);

  // C4 ≈ 261.63 Hz → pitch class C.
  const c = estimateKey(sine(261.63, 3), SR);
  assert.equal(c?.key, "C");
});

test("estimateKey returns null for silence and sub-second clips", () => {
  assert.equal(estimateKey(new Float32Array(SR * 2), SR), null);
  assert.equal(estimateKey(new Float32Array(SR / 2), SR), null);
});
