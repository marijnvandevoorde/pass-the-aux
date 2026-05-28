import test from "node:test";
import assert from "node:assert/strict";
import { GrainShifter } from "../../src/web/grain-shifter.ts";

const SR = 44100;

function sine(freq: number, n: number): Float32Array {
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return a;
}

/** Crude dominant-frequency estimate via zero-crossing rate. */
function approxFreq(x: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < x.length; i++) {
    if ((x[i - 1]! <= 0 && x[i]! > 0) || (x[i - 1]! >= 0 && x[i]! < 0)) {
      crossings++;
    }
  }
  return (crossings / 2 / (x.length / SR));
}

function run(shifter: GrainShifter, input: Float32Array): Float32Array {
  const out = new Float32Array(input.length);
  const block = 128;
  for (let i = 0; i < input.length; i += block) {
    const chunk = input.subarray(i, Math.min(i + block, input.length));
    out.set(shifter.process(chunk), i);
  }
  return out;
}

test("shift = 1 preserves the fundamental frequency", () => {
  const input = sine(440, SR);
  const out = run(new GrainShifter(1), input);
  const tail = out.subarray(SR / 2); // skip startup latency
  assert.ok(
    Math.abs(approxFreq(tail) - 440) < 30,
    `expected ~440 Hz, got ${approxFreq(tail)}`,
  );
});

test("shift = 2 raises pitch roughly an octave", () => {
  const input = sine(300, SR);
  const out = run(new GrainShifter(2), input);
  const f = approxFreq(out.subarray(SR / 2));
  assert.ok(f > 480 && f < 720, `expected ~600 Hz, got ${f}`);
});

test("output length always equals input length (no time change)", () => {
  const s = new GrainShifter(1.5);
  assert.equal(s.process(new Float32Array(256)).length, 256);
  assert.equal(s.process(new Float32Array(64)).length, 64);
});

test("setShift clamps to a sane musical range", () => {
  const s = new GrainShifter(1);
  s.setShift(99);
  // Absurd shift must not blow up or return NaN.
  const out = s.process(sine(440, 2048));
  assert.ok(out.every((v) => Number.isFinite(v)));
});
