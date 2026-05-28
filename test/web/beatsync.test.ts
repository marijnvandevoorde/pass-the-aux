import test from "node:test";
import assert from "node:assert/strict";
import {
  beatFraction,
  beatIndexAfter,
  gridBeatFraction,
  nextDownbeatAfter,
  octaveMatchedTarget,
  phaseBend,
  phaseError,
  signedMod,
  tempoPercentFor,
  withinRange,
} from "../../src/web/beatsync.ts";

const close = (a: number, b: number, eps = 1e-6): void =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

test("octaveMatchedTarget folds to the nearest power-of-two multiple", () => {
  assert.equal(octaveMatchedTarget(90, 178), 180); // 2× → 180
  assert.equal(octaveMatchedTarget(128, 64), 64); // ½×
  assert.equal(octaveMatchedTarget(128, 100), 128); // closest is 1×
  assert.equal(octaveMatchedTarget(120, 240), 240);
  assert.equal(octaveMatchedTarget(120, 0), 120); // guard
});

test("tempoPercentFor + withinRange gate musical changes", () => {
  close(tempoPercentFor(178, 180), (180 / 178 - 1) * 100);
  assert.ok(withinRange(tempoPercentFor(178, 180))); // ~1.1% → ok
  assert.equal(withinRange(tempoPercentFor(100, 128)), false); // +28% → no
  assert.equal(withinRange(NaN), false);
  assert.equal(withinRange(8), true);
  assert.equal(withinRange(8.01), false);
});

test("signedMod folds into [-m/2, m/2)", () => {
  close(signedMod(0.2, 1), 0.2);
  close(signedMod(0.7, 1), -0.3);
  close(signedMod(-0.2, 1), -0.2);
  assert.equal(signedMod(5, 0), 0);
});

test("beatFraction is position within a beat, [0,1)", () => {
  close(beatFraction(0, 0, 0.5), 0);
  close(beatFraction(0.25, 0, 0.5), 0.5);
  close(beatFraction(0.75, 0, 0.5), 0.5);
  assert.equal(beatFraction(1, 0, 0), 0); // guard
});

test("gridBeatFraction uses the actual grid as anchor (cueless tracks)", () => {
  // Grid offset from 0 (typical: a real track has pre-beat silence).
  // cuePoint=0 would make `beatFraction` return a wrong, non-zero
  // fraction at every beat; the grid-aware variant returns 0.
  // Values chosen to be float32-exact (multiples of 1/16) so the test
  // is not at the mercy of Float32Array rounding.
  const beats = new Float32Array([0.25, 0.75, 1.25, 1.75, 2.25]);
  close(gridBeatFraction(beats, 0.25, 0.5), 0);
  close(gridBeatFraction(beats, 1.25, 0.5), 0);
  // Off-beat by 25 % of a beat (0.125 s past beat 2) → fraction 0.25.
  close(gridBeatFraction(beats, 1.375, 0.5), 0.25);
  // Empty grid / zero beatLen guards.
  assert.equal(gridBeatFraction(new Float32Array(), 1, 0.5), 0);
  assert.equal(gridBeatFraction(beats, 1, 0), 0);
});

test("phaseError is signed beats between incoming and outgoing", () => {
  close(phaseError(0.2, 0.1), 0.1); // incoming slightly ahead
  close(phaseError(0.1, 0.9), 0.2); // wrap, incoming ahead by 0.2
  close(phaseError(0.6, 0.1), -0.5);
});

test("beatIndexAfter binary-searches for the first beat strictly past posSec", () => {
  const beats = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
  assert.equal(beatIndexAfter(beats, -1), 0);
  assert.equal(beatIndexAfter(beats, 0.5), 1); // strict — equal does not count
  assert.equal(beatIndexAfter(beats, 1.7), 3); // beats[3] = 2.0
  assert.equal(beatIndexAfter(beats, 4.0), -1); // none past the last
  assert.equal(beatIndexAfter([], 0), -1);
});

test("nextDownbeatAfter finds the next beat at the bar phase", () => {
  // Beats every 0.5s. Downbeat phase 0 ⇒ beats 0, 4, 8 are bar starts.
  const beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0];
  assert.equal(nextDownbeatAfter(beats, -0.1, 0), 0);   // next downbeat: index 0
  assert.equal(nextDownbeatAfter(beats, 0.0, 0), 2.0);  // skip to index 4
  assert.equal(nextDownbeatAfter(beats, 1.9, 0), 2.0);
  assert.equal(nextDownbeatAfter(beats, 3.9, 0), 4.0);  // index 8
  assert.equal(nextDownbeatAfter(beats, 4.0, 0), null); // none past
  // Phase 2 ⇒ bars start at indices 2, 6 ⇒ times 1.0, 3.0
  assert.equal(nextDownbeatAfter(beats, 0.0, 2), 1.0);
  assert.equal(nextDownbeatAfter(beats, 1.0, 2), 3.0);
});

test("phaseBend is a gentle, clamped, time-bounded ride", () => {
  const a = phaseBend(0.1, 0.5, 2);
  close(a.bend, 0.95);
  assert.equal(a.durationMs, 1000);

  const big = phaseBend(0.5, 0.5, 2); // would be 0.75 → clamped
  assert.equal(big.bend, 0.94);

  const behind = phaseBend(-1, 0.5, 2); // bend > 1 → clamped up
  assert.equal(behind.bend, 1.06);

  assert.ok(phaseBend(0, 0, 2).durationMs >= 50); // floor
});
