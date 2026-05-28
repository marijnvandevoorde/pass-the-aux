import test from "node:test";
import assert from "node:assert/strict";
import { Tempo } from "../../src/domain/tempo.ts";
import { InvalidTempoError } from "../../src/domain/errors.ts";

test("Tempo rounds to one decimal place", () => {
  assert.equal(new Tempo(128.04).bpm, 128);
  assert.equal(new Tempo(128.06).bpm, 128.1);
  assert.equal(new Tempo("124.25").bpm, 124.3);
});

test("Tempo accepts the valid range", () => {
  assert.equal(new Tempo(1).bpm, 1);
  assert.equal(new Tempo(400).bpm, 400);
});

test("Tempo rejects invalid values", () => {
  for (const bad of [0, -5, 401, NaN, Infinity, "abc", null, undefined, {}]) {
    assert.throws(() => new Tempo(bad), InvalidTempoError, `should reject ${String(bad)}`);
  }
});

test("Tempo serialises to a number", () => {
  assert.equal(JSON.stringify({ bpm: new Tempo(120) }), '{"bpm":120}');
});
