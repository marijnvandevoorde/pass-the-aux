import test from "node:test";
import assert from "node:assert/strict";
import {
  parseMobileState,
  restorableState,
  serializeMobileState,
  type MobileState,
  type MobileTrack,
} from "../../src/web/mobile-state.ts";

const t = (path: string, by = "you"): MobileTrack => ({
  path, name: path, artist: null, camelot: "8A", bpm: 124, by,
});

function state(over: Partial<MobileState> = {}): MobileState {
  return {
    sessionId: "party",
    nowPlaying: t("a.mp3"),
    positionSec: 93.5,
    playing: true,
    queue: [t("b.mp3", "Ann"), t("c.mp3")],
    pendingPlayed: ["z.mp3"],
    ...over,
  };
}

const LIB = new Set(["a.mp3", "b.mp3", "c.mp3"]);

test("serialize → parse round-trips the whole set", () => {
  const s = state();
  assert.deepEqual(parseMobileState(serializeMobileState(s)), s);
});

test("corrupt, empty or other-version payloads parse to null", () => {
  assert.equal(parseMobileState(null), null);
  assert.equal(parseMobileState(""), null);
  assert.equal(parseMobileState("{nope"), null);
  assert.equal(parseMobileState(JSON.stringify({ v: 99, s: state() })), null);
  assert.equal(parseMobileState(JSON.stringify({ v: 1, s: { queue: [] } })), null);
});

test("malformed tracks are dropped, not the whole set", () => {
  const raw = JSON.stringify({
    v: 1,
    s: { ...state(), queue: [t("b.mp3"), { name: "no path" }, null], positionSec: "x" },
  });
  const s = parseMobileState(raw);
  assert.ok(s);
  assert.deepEqual(s.queue.map((q) => q.path), ["b.mp3"]);
  assert.equal(s.positionSec, 0);
});

test("restores the set for the same session, crowd requester included", () => {
  const r = restorableState(state(), "party", LIB);
  assert.ok(r);
  assert.equal(r.nowPlaying?.path, "a.mp3");
  assert.equal(r.positionSec, 93.5);
  assert.equal(r.queue[0]?.by, "Ann");
});

test("a state from another session is ignored", () => {
  assert.equal(restorableState(state(), "other", LIB), null);
});

test("tracks gone from the library are dropped; a gone now-playing counts as played", () => {
  const r = restorableState(state(), "party", new Set(["c.mp3"]));
  assert.ok(r);
  assert.equal(r.nowPlaying, null);
  assert.equal(r.positionSec, 0);
  assert.deepEqual(r.queue.map((q) => q.path), ["c.mp3"]);
  assert.deepEqual(r.pendingPlayed, ["z.mp3", "a.mp3"]);
});

test("duplicates and a queued copy of now-playing are dropped", () => {
  const r = restorableState(state({ queue: [t("a.mp3"), t("b.mp3"), t("b.mp3")] }), "party", LIB);
  assert.deepEqual(r?.queue.map((q) => q.path), ["b.mp3"]);
});

test("an empty library (failed to load) keeps everything", () => {
  const r = restorableState(state(), "party", new Set());
  assert.equal(r?.nowPlaying?.path, "a.mp3");
  assert.equal(r?.queue.length, 2);
});

test("nothing to restore gives null", () => {
  assert.equal(restorableState(state({ nowPlaying: null, queue: [], pendingPlayed: [] }), "party", LIB), null);
});
