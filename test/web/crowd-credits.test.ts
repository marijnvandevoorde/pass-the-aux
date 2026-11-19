import test from "node:test";
import assert from "node:assert/strict";
import { CrowdCredits, MAX_CREDITS, creditedUpNext } from "../../src/web/crowd-credits.ts";

test("credits the guest who requested a track", () => {
  const c = new CrowdCredits();
  c.record("a.mp3", "Sarah");
  assert.equal(c.of("a.mp3"), "Sarah");
  assert.equal(c.of("b.mp3"), null);
  assert.equal(c.of(null), null);
});

test("ignores blank names and missing paths, trims and caps names", () => {
  const c = new CrowdCredits();
  c.record("a.mp3", "   ");
  c.record("b.mp3", null);
  c.record(null, "Sarah");
  c.record("c.mp3", "  " + "x".repeat(40) + "  ");
  assert.deepEqual(Object.keys(c.snapshot()), ["c.mp3"]);
  assert.equal(c.of("c.mp3"), "x".repeat(24));
});

test("a later request for the same track takes the credit", () => {
  const c = new CrowdCredits();
  c.record("a.mp3", "Sarah");
  c.record("a.mp3", "Tom");
  assert.equal(c.of("a.mp3"), "Tom");
});

test("keeps at most MAX_CREDITS, dropping the oldest", () => {
  const c = new CrowdCredits();
  for (let i = 0; i <= MAX_CREDITS; i++) c.record(`t${i}.mp3`, "g");
  assert.equal(Object.keys(c.snapshot()).length, MAX_CREDITS);
  assert.equal(c.of("t0.mp3"), null);
  assert.equal(c.of(`t${MAX_CREDITS}.mp3`), "g");
});

test("snapshot round-trips and restore skips junk", () => {
  const c = new CrowdCredits();
  c.record("a.mp3", "Sarah");
  const back = new CrowdCredits();
  back.restore(JSON.parse(JSON.stringify(c.snapshot())));
  assert.equal(back.of("a.mp3"), "Sarah");

  const junk = new CrowdCredits();
  junk.restore({ "a.mp3": 3, "b.mp3": "Tom" });
  junk.restore(null);
  junk.restore(["x"]);
  junk.restore("nope");
  assert.deepEqual(junk.snapshot(), { "b.mp3": "Tom" });
});

test("creditedUpNext drops path-less tracks and adds requesters", () => {
  const c = new CrowdCredits();
  c.record("a.mp3", "Sarah");
  assert.deepEqual(
    creditedUpNext(
      [
        { name: "A", path: "a.mp3", bpm: 120 },
        { name: "Dropped file", path: null, bpm: null },
        { name: "B", path: "b.mp3", bpm: null },
      ],
      c,
    ),
    [
      { name: "A", path: "a.mp3", bpm: 120, by: "Sarah" },
      { name: "B", path: "b.mp3", bpm: null, by: null },
    ],
  );
});
