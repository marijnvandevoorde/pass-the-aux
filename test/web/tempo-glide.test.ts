import test from "node:test";
import assert from "node:assert/strict";
import {
  GLIDE_MIN_BARS,
  TempoGlide,
  glideDurationSec,
  glidePercent,
  type GlideDeck,
} from "../../src/web/tempo-glide.ts";

class FakeDeck implements GlideDeck {
  isPlaying = true;
  buffer: unknown = {};
  tempoPercent = 0;
  beatLengthSec: number | null = 0.5; // 120 BPM, bar 2 s
  sets = 0;
  setTempo(p: number): void {
    this.tempoPercent = p;
    this.sets++;
  }
}

test("glide length: 0.25 % per bar, at least a phrase", () => {
  assert.equal(glideDurationSec(8, 0.5), 32 * 2); // 32 bars
  assert.equal(glideDurationSec(-4, 0.5), 16 * 2);
  assert.equal(glideDurationSec(1, 0.5), GLIDE_MIN_BARS * 2);
  assert.equal(glideDurationSec(8, null), 64); // no BPM: 120 assumed
});

test("glide curve eases out of the start and into 0 %", () => {
  assert.equal(glidePercent(6, 0, 60), 6);
  assert.equal(glidePercent(6, 30, 60), 3);
  assert.equal(glidePercent(6, 60, 60), 0);
  // Gentle at the edges: the first and last 5 % move under 1 % of the way.
  assert.ok(6 - glidePercent(6, 3, 60) < 0.06 * 1.1);
  assert.ok(glidePercent(6, 57, 60) < 0.06 * 1.1);
});

test("a glide walks the deck home and never adds up", () => {
  const d = new FakeDeck();
  d.tempoPercent = 8;
  const g = new TempoGlide();
  const dur = g.start(d, 0)!;
  let prev = d.tempoPercent;
  for (let t = 0.25; t <= dur + 1; t += 0.25) {
    g.step(t);
    assert.ok(d.tempoPercent <= prev, "monotonic");
    // Steepest at the middle: 1.5 × 8 % / 64 s ≈ 0.19 %/s, so steps of
    // at most 0.06 % per quarter second after rounding to the knob (about
    // a cent of pitch).
    assert.ok(prev - d.tempoPercent <= 0.06 + 1e-9, `${prev} → ${d.tempoPercent}`);
    prev = d.tempoPercent;
  }
  assert.equal(d.tempoPercent, 0);
  assert.equal(g.state, "idle");
});

test("nothing to glide below the knob's resolution", () => {
  const d = new FakeDeck();
  d.tempoPercent = 0.02;
  assert.equal(new TempoGlide().start(d, 0), null);
});

test("stops on a manual tempo change, a stop or an eject, keeping the tempo", () => {
  for (const interfere of [
    (d: FakeDeck) => (d.tempoPercent = 2),
    (d: FakeDeck) => (d.isPlaying = false),
    (d: FakeDeck) => (d.buffer = null),
  ]) {
    const d = new FakeDeck();
    d.tempoPercent = 5;
    const g = new TempoGlide();
    g.start(d, 0);
    g.step(10);
    interfere(d);
    const held = d.tempoPercent;
    assert.equal(g.step(11), "idle");
    assert.equal(d.tempoPercent, held);
  }
});
