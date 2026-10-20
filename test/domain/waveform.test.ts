import test from "node:test";
import assert from "node:assert/strict";
import { waveformFromPcm } from "../../src/domain/waveform.ts";

test("one level per bucket, duration from the sample count", () => {
  const pcm = new Float32Array(1000).fill(0.5);
  const w = waveformFromPcm(pcm, 100, 10);
  assert.equal(w.durationSec, 10);
  assert.equal(w.peaks.length, 10);
  assert.ok(w.peaks.every((p) => p === 1));
});

test("a quiet breakdown shows as low bars between loud parts", () => {
  const pcm = new Float32Array(300);
  for (let i = 0; i < 300; i++) pcm[i] = (i >= 100 && i < 200 ? 0.05 : 0.8) * (i % 2 ? 1 : -1);
  const w = waveformFromPcm(pcm, 100, 3);
  assert.equal(w.peaks[0], 1);
  assert.ok((w.peaks[1] ?? 1) < 0.1);
  assert.equal(w.peaks[2], 1);
});

test("one loud hit doesn't flatten the rest (95th percentile reference)", () => {
  const pcm = new Float32Array(10_000).fill(0.2);
  pcm[5] = 1; // a single spike in bucket 0
  const w = waveformFromPcm(pcm, 1000, 100);
  assert.ok(w.peaks.slice(1).every((p) => p === 1));
});

test("silence and empty input stay at zero, never NaN", () => {
  assert.deepEqual(waveformFromPcm(new Float32Array(50), 10, 5).peaks, [0, 0, 0, 0, 0]);
  assert.deepEqual(waveformFromPcm(new Float32Array(0), 10, 5).peaks, []);
  assert.equal(waveformFromPcm(new Float32Array(3), 10, 5).peaks.length, 3);
});
