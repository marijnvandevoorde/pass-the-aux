import test from "node:test";
import assert from "node:assert/strict";
import { energyLabel } from "../../src/web/energy-label.ts";

test("buckets map to the expected keywords", () => {
  assert.equal(energyLabel(0).label, "Chill");
  assert.equal(energyLabel(0.1).label, "Chill");
  assert.equal(energyLabel(0.25).label, "Groovy");
  assert.equal(energyLabel(0.49).label, "Groovy");
  assert.equal(energyLabel(0.5).label, "Energetic");
  assert.equal(energyLabel(0.74).label, "Energetic");
  assert.equal(energyLabel(0.75).label, "Peak");
  assert.equal(energyLabel(1).label, "Peak");
});

test("unknown / invalid energy is neutral '—'", () => {
  for (const v of [null, undefined, NaN]) {
    const l = energyLabel(v as number | null);
    assert.equal(l.label, "—");
    assert.match(l.color, /^#[0-9a-f]{6}$/i);
  }
});

test("out-of-range values are clamped", () => {
  assert.equal(energyLabel(2).label, "Peak");
  assert.equal(energyLabel(-1).label, "Chill");
});

test("every bucket returns a hex colour", () => {
  for (const v of [0.1, 0.3, 0.6, 0.9]) {
    assert.match(energyLabel(v).color, /^#[0-9a-f]{6}$/i);
  }
});
