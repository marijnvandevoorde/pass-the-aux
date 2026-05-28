import test from "node:test";
import assert from "node:assert/strict";
import { FX_MACROS } from "../../src/web/fx-macros.ts";

test("every macro has a name and builds non-empty params", () => {
  assert.ok(FX_MACROS.length >= 6);
  for (const m of FX_MACROS) {
    assert.ok(m.name.length > 0);
    const p = m.build(0.5);
    assert.ok(Object.keys(p).length > 0, `${m.name} produced no params`);
  }
});

test("beat-synced macros scale with the beat", () => {
  const chop = FX_MACROS.find((m) => m.name === "Chop")!;
  assert.equal(chop.build(0.5).gateRate, 1 / (0.5 * 0.25));
  const echo = FX_MACROS.find((m) => m.name === "Echo Out")!;
  assert.equal(echo.build(0.5).delayTime, 0.25);
  assert.equal(echo.build(1).delayTime, 0.5);
});

test("Echo Out feedback stays under the runaway ceiling", () => {
  const fb = FX_MACROS.find((m) => m.name === "Echo Out")!.build(0.5)
    .delayFeedback;
  assert.ok(fb !== undefined && fb < 1);
});
