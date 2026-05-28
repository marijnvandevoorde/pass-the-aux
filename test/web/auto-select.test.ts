import test from "node:test";
import assert from "node:assert/strict";
import {
  pickNext,
  scoreCandidate,
  type FeatureTrack,
} from "../../src/web/auto-select.ts";

const cur: FeatureTrack = { id: "cur", bpm: 128, camelot: "8A", energy: 0.5 };
const perfect: FeatureTrack = { id: "p", bpm: 128, camelot: "8A", energy: 0.5 };
const clash: FeatureTrack = { id: "c", bpm: 90, camelot: "3B", energy: 0.95 };
const ok: FeatureTrack = { id: "o", bpm: 126, camelot: "9A", energy: 0.55 };

test("a same-tempo, same-key, same-energy track scores highest", () => {
  assert.ok(scoreCandidate(cur, perfect) > scoreCandidate(cur, ok));
  assert.ok(scoreCandidate(cur, ok) > scoreCandidate(cur, clash));
});

test("double-time tempo is treated as compatible", () => {
  const dbl: FeatureTrack = { id: "d", bpm: 256, camelot: "8A", energy: 0.5 };
  assert.ok(scoreCandidate(cur, dbl) > scoreCandidate(cur, clash));
});

test("pickNext excludes the current track and seen history", () => {
  const seen = new Set(["c"]);
  const pick = pickNext(
    cur,
    [cur, perfect, clash, ok],
    (id) => seen.has(id),
    () => 0, // deterministic → top of ranking
  );
  assert.equal(pick?.id, "p");
});

test("returns null when everything is excluded", () => {
  assert.equal(
    pickNext(cur, [cur, perfect], (id) => id === "p", () => 0),
    null,
  );
});

test("with no current track, falls back to an unseen track", () => {
  const pick = pickNext(null, [perfect, clash], () => false, () => 0);
  assert.ok(pick !== null);
});

test("unanalysed candidates are still selectable (set never dies)", () => {
  const blank: FeatureTrack = {
    id: "b",
    bpm: null,
    camelot: null,
    energy: null,
  };
  const pick = pickNext(cur, [blank], () => false, () => 0);
  assert.equal(pick?.id, "b");
});
