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


test("gridBpm: a messy section doesn't drag the tempo off", () => {
  // 132 BPM, quantised to 20 ms frames like pass-the-beat, with a
  // stretch where the tracker found extra beats (~165 BPM).
  const beats: number[] = [];
  let t = 0.16;
  for (let i = 0; i < 25; i++) { beats.push(Math.round(t / 0.02) * 0.02); t += 60 / 132; }
  for (let i = 0; i < 40; i++) { beats.push(Math.round(t / 0.02) * 0.02); t += 60 / 165; }
  for (let i = 0; i < 200; i++) { beats.push(Math.round(t / 0.02) * 0.02); t += 60 / 132; }
  const bpm = gridBpm(beats)!;
  assert.ok(Math.abs(bpm - 132) < 0.5, `got ${bpm}`);
});
