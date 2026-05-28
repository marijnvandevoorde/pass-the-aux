import test from "node:test";
import assert from "node:assert/strict";
import { bitcrushCurve } from "../../src/web/bitcrush.ts";

test("curve spans -1..1 and is non-decreasing", () => {
  const c = bitcrushCurve(4, 1024);
  assert.ok(Math.abs(c[0]! + 1) < 1e-6);
  assert.ok(Math.abs(c[c.length - 1]! - 1) < 1e-6);
  for (let i = 1; i < c.length; i++) assert.ok(c[i]! >= c[i - 1]!);
});

test("fewer bits → fewer distinct levels", () => {
  const lvl = (c: Float32Array): number => new Set(c).size;
  assert.ok(lvl(bitcrushCurve(2)) < lvl(bitcrushCurve(8)));
  assert.equal(lvl(bitcrushCurve(1)), 2); // 1 bit → 2 levels
});

test("bits are clamped to a sane range", () => {
  assert.equal(bitcrushCurve(0, 64).length, 64); // no throw / NaN
  assert.ok(bitcrushCurve(99, 64).every((v) => Number.isFinite(v)));
});
