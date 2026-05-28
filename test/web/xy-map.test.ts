import test from "node:test";
import assert from "node:assert/strict";
import { FX_ORDER, mapEffect } from "../../src/web/xy-map.ts";

test("filter maps X to a bipolar -1..1 (centre = open)", () => {
  assert.equal(mapEffect("filter", 0.5, 0, 0.5).filter, 0);
  assert.equal(mapEffect("filter", 0, 0, 0.5).filter, -1);
  assert.equal(mapEffect("filter", 1, 0, 0.5).filter, 1);
});

test("echo: X picks a beat-synced delay time; Y drives wet + feedback", () => {
  const beat = 0.5; // 120 BPM
  assert.equal(mapEffect("echo", 0.1, 1, beat).delayTime, beat * 1);
  assert.equal(mapEffect("echo", 0.5, 1, beat).delayTime, beat * 0.5);
  assert.equal(mapEffect("echo", 0.9, 1, beat).delayTime, beat * 0.25);
  const full = mapEffect("echo", 0, 1, beat);
  assert.equal(full.delayWet, 1.4);
  assert.ok(Math.abs((full.delayFeedback ?? 0) - 0.85) < 1e-9);
  assert.equal(mapEffect("echo", 0, 0, beat).delayWet, 0); // bottom = dry
});

test("gate: rate is 1 / (beat × division), depth is Y", () => {
  const g = mapEffect("gate", 0.1, 0.7, 0.5);
  assert.equal(g.gateRate, 1 / (0.5 * 1));
  assert.equal(g.gateDepth, 0.7);
});

test("reverb: Y is a strong wet wash, dry at the bottom", () => {
  assert.ok(
    Math.abs((mapEffect("reverb", 0, 1, 0.5).reverbWet ?? 0) - 1.7) < 1e-9,
  );
  assert.equal(mapEffect("reverb", 0, 0, 0.5).reverbWet, 0);
});

test("no/zero BPM falls back to a 0.5 s beat; inputs are clamped", () => {
  assert.equal(mapEffect("echo", 0.1, 2, null).delayTime, 0.5);
  assert.equal(mapEffect("echo", 0.1, 2, null).delayWet, 1.4); // y clamped to 1
  assert.equal(mapEffect("filter", -3, 0, 0.5).filter, -1); // x clamped
});

test("FX_ORDER is core + phase-2 effects (incl. strobe)", () => {
  assert.deepEqual(
    [...FX_ORDER],
    [
      "filter",
      "echo",
      "reverb",
      "gate",
      "strobe",
      "flanger",
      "phaser",
      "bitcrush",
      "alarm",
    ],
  );
});

test("strobe: X = beat-synced rate, Y = amount", () => {
  const s = mapEffect("strobe", 0.9, 0.8, 0.5);
  assert.equal(s.strobeAmount, 0.8);
  assert.ok((s.strobeRate ?? 0) > 1 / 0.5); // finer than one per beat
});

test("phase-2 effects map X→rate/pitch/bits, Y→wet/level", () => {
  assert.ok((mapEffect("flanger", 1, 1, 0.5).flangerRate ?? 0) > 4);
  assert.equal(mapEffect("flanger", 0, 0, 0.5).flangerWet, 0);
  assert.ok((mapEffect("phaser", 1, 1, 0.5).phaserWet ?? 0) > 1);
  // bitcrush: X left = fewer bits (grittier) than X right
  assert.ok(
    (mapEffect("bitcrush", 0, 1, 0.5).crushBits ?? 0) >
      (mapEffect("bitcrush", 1, 1, 0.5).crushBits ?? 0),
  );
  assert.equal(mapEffect("alarm", 0.5, 0.8, 0.5).alarmLevel, 0.8);
});
