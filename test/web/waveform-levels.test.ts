import test from "node:test";
import assert from "node:assert/strict";
import { resampleLevels } from "../../src/web/waveform-levels.ts";

test("server levels (0–100) are scaled to 0–1", () => {
  assert.deepEqual(resampleLevels([0, 50, 100], 3), [0, 0.5, 1]);
});

test("downsampling keeps the loudest slice under each bar (short drops survive)", () => {
  const levels = new Array(120).fill(10);
  levels[61] = 100;
  const bars = resampleLevels(levels, 58);
  assert.equal(bars.length, 58);
  assert.equal(Math.max(...bars), 1);
  assert.equal(bars.filter((b) => b === 1).length, 1);
});

test("upsampling repeats levels; empty input gives no bars", () => {
  assert.deepEqual(resampleLevels([0.2, 0.8], 4), [0.2, 0.2, 0.8, 0.8]);
  assert.deepEqual(resampleLevels([], 10), []);
});
