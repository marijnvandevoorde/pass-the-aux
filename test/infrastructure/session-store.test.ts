import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionStore,
  sanitizeSessionId,
} from "../../src/infrastructure/session-store.ts";

const cfg = { automix: true, autoFill: false, beatSync: true, fadeSeconds: 8, showUpNext: true };
const item = (p: string) => ({ name: p, path: p, bpm: null, by: null });

test("create → get round-trips; ids short & unique", () => {
  const s = new SessionStore();
  const a = s.create(cfg);
  const b = s.create(cfg);
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9]{1,8}$/);
  assert.equal(s.get(a)?.id, a);
  assert.deepEqual(s.get(a)?.config, cfg);
  assert.equal(s.has(a), true);
});

test("unknown id → null / not-found / false", () => {
  const s = new SessionStore();
  assert.equal(s.get("nope"), null);
  assert.equal(s.has("nope"), false);
  assert.equal(s.enqueue("nope", item("a.mp3")), "not-found");
});

test("enqueue appends to pending; replays rejected (SESSION·4)", () => {
  const s = new SessionStore();
  const id = s.create(cfg);
  assert.equal(s.enqueue(id, item("a.mp3")), "ok");
  assert.equal(s.enqueue(id, item("a.mp3")), "played");
  assert.equal(s.isPlayed(id, "a.mp3"), true);
  assert.equal(s.isPlayed(id, "b.mp3"), false);
  assert.deepEqual(s.get(id)?.pending.map((q) => q.path), ["a.mp3"]);
});

test("sanitizeSessionId is lowercase, url/QR-safe, ≤32, else empty", () => {
  assert.equal(sanitizeSessionId("  My Party 2026! "), "myparty2026");
  assert.equal(sanitizeSessionId("keep-_underscores"), "keep-_underscores");
  assert.equal(sanitizeSessionId("x".repeat(50)).length, 32);
  assert.equal(sanitizeSessionId("***"), "");
  assert.equal(sanitizeSessionId(42), "");
  assert.equal(sanitizeSessionId(undefined), "");
});

test("create honours a DJ-chosen id (sanitised)", () => {
  const s = new SessionStore();
  const id = s.create(cfg, "Friday Night!!");
  assert.equal(id, "fridaynight");
  assert.equal(s.has("fridaynight"), true);
});

test("create with an existing id is idempotent — keeps the session", () => {
  const s = new SessionStore();
  const a = s.create(cfg, "party");
  s.enqueue("party", item("a.mp3"));
  const b = s.create(cfg, "party"); // reconnect (e.g. after refresh)
  assert.equal(b, a);
  assert.deepEqual(
    s.get("party")?.pending.map((q) => q.path),
    ["a.mp3"],
  ); // history preserved, not reset
});

test("create with no/blank id falls back to a generated one", () => {
  const s = new SessionStore();
  const id = s.create(cfg, "  ");
  assert.match(id, /^[a-z0-9]{1,8}$/);
});

test("ownerOf returns the owning account; idempotent keeps it", () => {
  const s = new SessionStore();
  const id = s.create(cfg, "party", "user-abc");
  assert.equal(s.ownerOf(id), "user-abc");
  s.create(cfg, "party", "someone-else"); // idempotent reconnect
  assert.equal(s.ownerOf("party"), "user-abc"); // owner unchanged
  assert.equal(s.ownerOf("missing"), "");
  assert.equal(s.ownerOf(s.create(cfg)), ""); // no owner → ""
});

test("drain returns + clears pending and unions played", () => {
  const s = new SessionStore();
  const id = s.create(cfg);
  s.enqueue(id, item("a.mp3"));
  const first = s.drain(id, ["x.mp3"]);
  assert.deepEqual(first.map((q) => q.path), ["a.mp3"]);
  assert.deepEqual(s.drain(id), []); // cleared
  assert.equal(s.isPlayed(id, "x.mp3"), true);
  assert.deepEqual(s.drain("bad"), []);
});

test("clearPlayed wipes the dedup set; subsequent re-add of a played track is OK", () => {
  const s = new SessionStore();
  const id = s.create(cfg);
  assert.equal(s.enqueue(id, item("a.mp3")), "ok");
  assert.equal(s.enqueue(id, item("a.mp3")), "played"); // blocked
  assert.equal(s.clearPlayed(id), true);
  assert.equal(s.isPlayed(id, "a.mp3"), false);
  assert.equal(s.enqueue(id, item("a.mp3")), "ok"); // re-add succeeds
});

test("clearPlayed on a missing session returns false", () => {
  const s = new SessionStore();
  assert.equal(s.clearPlayed("nope"), false);
});

test("clearPlayed leaves the pending queue intact", () => {
  const s = new SessionStore();
  const id = s.create(cfg);
  assert.equal(s.enqueue(id, item("a.mp3")), "ok");
  assert.equal(s.enqueue(id, item("b.mp3")), "ok");
  assert.equal(s.clearPlayed(id), true);
  // pending still has both — clear only resets the dedup set.
  assert.deepEqual(
    s.get(id)?.pending.map((p) => p.path),
    ["a.mp3", "b.mp3"],
  );
});
