import test from "node:test";
import assert from "node:assert/strict";
import { gridBpm } from "../../src/web/beatsync.ts";

test("gridBpm: average tempo over the whole grid", () => {
  const beats = Array.from({ length: 33 }, (_, i) => 1 + i * 0.5); // 120 BPM
  assert.equal(gridBpm(beats), 120);
});

test("gridBpm: too short or degenerate grids give null", () => {
  assert.equal(gridBpm([0, 0.5, 1]), null);
  assert.equal(gridBpm(new Array(10).fill(3)), null);
});

