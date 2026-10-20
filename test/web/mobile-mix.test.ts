import test from "node:test";
import assert from "node:assert/strict";
import {
  autoMixDue,
  beatLengthNear,
  fitFade,
  MIX_OUT_LEAD_SEC,
  nextBarAfter,
  planMixOut,
  type MobileGrid,
} from "../../src/web/mobile-mix.ts";

// 120 BPM: a beat every 0.5 s, a bar every 2 s, 200 s of beats.
const beats = Array.from({ length: 400 }, (_, i) => i * 0.5);
const grid = (over: Partial<MobileGrid> = {}): MobileGrid => ({ beats, downbeatPhase: 0, ...over });

test("next bar from the phase, or from per-bar downbeats when present", () => {
  assert.equal(nextBarAfter(grid(), 10.1), 12);
  assert.equal(nextBarAfter(grid({ downbeatPhase: 1 }), 10.1), 10.5);
  // A 3-beat bar at beat 20 shifts the later bars: 20, 23, 27…
  assert.equal(nextBarAfter(grid({ barStarts: [16, 20, 23, 27] }), 10.1), 11.5);
  assert.equal(nextBarAfter(grid({ barStarts: [16] }), 10.1), null);
});

test("beat length is the median gap around a point", () => {
  assert.equal(beatLengthNear(beats, 100), 0.5);
  assert.equal(beatLengthNear([0, 1], 0), null);
});

test("fade fitted to whole bars closest to the wanted length, inside the outro", () => {
  assert.equal(fitFade(4, 100, 200, 0.5), 4); // 2 bars
  assert.equal(fitFade(7, 100, 200, 0.5), 8); // 4 bars
  assert.equal(fitFade(30, 100, 105, 0.5), 4); // only 2 bars fit
  assert.equal(fitFade(4, 100, 101.5, 0.5), null); // not one bar
});

test("plans the transition at the mix-out point", () => {
  assert.deepEqual(planMixOut(grid({ mixOutCueSec: 160 }), 200, 150, 4), { startSec: 160, fadeSec: 4 });
});

test("no plan without a point, once it has passed, or with no bar left after it", () => {
  assert.equal(planMixOut(null, 200, 150, 4), null);
  assert.equal(planMixOut(grid(), 200, 150, 4), null);
  assert.equal(planMixOut(grid({ mixOutCueSec: 160 }), 200, 165, 4), null);
  assert.equal(planMixOut(grid({ mixOutCueSec: 199 }), 200, 150, 4), null);
});

test("auto transition: shortly before the mix-out point, else near the end", () => {
  const plan = { startSec: 160, fadeSec: 4 };
  assert.equal(autoMixDue(plan, 200, 160 - MIX_OUT_LEAD_SEC - 0.1, 4), false);
  assert.equal(autoMixDue(plan, 200, 160 - MIX_OUT_LEAD_SEC, 4), true);
  assert.equal(autoMixDue(null, 200, 194, 4), false);
  assert.equal(autoMixDue(null, 200, 195.5, 4), true);
});
