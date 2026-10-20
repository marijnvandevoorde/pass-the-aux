import test from "node:test";
import assert from "node:assert/strict";
import {
  SessionStore,
  sanitizeSessionId,
  parseNowPlaying,
  parseUpNext,
} from "../../src/infrastructure/session-store.ts";

const cfg = { automix: true, autoFill: false, beatSync: true, fadeSeconds: 8, showUpNext: true };
const item = (p: string) => ({ name: p, path: p, bpm: null, by: null });

test("create → get round-trips; ids short & unique", async () => {
  const s = new SessionStore();
  const a = await s.create(cfg);
  const b = await s.create(cfg);
  assert.notEqual(a, b);
  assert.match(a, /^[a-z0-9]{1,8}$/);
  assert.equal((await s.get(a))?.id, a);
  assert.deepEqual((await s.get(a))?.config, cfg);
  assert.equal(await s.has(a), true);
});

test("unknown id → null / not-found / false", async () => {
  const s = new SessionStore();
  assert.equal(await s.get("nope"), null);
  assert.equal(await s.has("nope"), false);
  assert.equal(await s.enqueue("nope", item("a.mp3")), "not-found");
});

test("enqueue appends to pending; replays rejected (SESSION·4)", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg);
  assert.equal(await s.enqueue(id, item("a.mp3")), "ok");
  assert.equal(await s.enqueue(id, item("a.mp3")), "played");
  assert.equal(await s.isPlayed(id, "a.mp3"), true);
  assert.equal(await s.isPlayed(id, "b.mp3"), false);
  assert.deepEqual((await s.get(id))?.pending.map((q) => q.path), ["a.mp3"]);
});

test("sanitizeSessionId is lowercase, url/QR-safe, ≤32, else empty", async () => {
  assert.equal(sanitizeSessionId("  My Party 2026! "), "myparty2026");
  assert.equal(sanitizeSessionId("keep-_underscores"), "keep-_underscores");
  assert.equal(sanitizeSessionId("x".repeat(50)).length, 32);
  assert.equal(sanitizeSessionId("***"), "");
  assert.equal(sanitizeSessionId(42), "");
  assert.equal(sanitizeSessionId(undefined), "");
});

test("create honours a DJ-chosen id (sanitised)", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg, "Friday Night!!");
  assert.equal(id, "fridaynight");
  assert.equal(await s.has("fridaynight"), true);
});

test("create with an existing id is idempotent — keeps the session", async () => {
  const s = new SessionStore();
  const a = await s.create(cfg, "party");
  await s.enqueue("party", item("a.mp3"));
  const b = await s.create(cfg, "party"); // reconnect (e.g. after refresh)
  assert.equal(b, a);
  assert.deepEqual(
    (await s.get("party"))?.pending.map((q) => q.path),
    ["a.mp3"],
  ); // history preserved, not reset
});

test("create with no/blank id falls back to a generated one", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg, "  ");
  assert.match(id, /^[a-z0-9]{1,8}$/);
});

test("ownerOf returns the owning account; idempotent keeps it", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg, "party", "user-abc");
  assert.equal(await s.ownerOf(id), "user-abc");
  await s.create(cfg, "party", "someone-else"); // idempotent reconnect
  assert.equal(await s.ownerOf("party"), "user-abc"); // owner unchanged
  assert.equal(await s.ownerOf("missing"), "");
  assert.equal(await s.ownerOf(await s.create(cfg)), ""); // no owner → ""
});

test("drain returns + clears pending and unions played", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg);
  await s.enqueue(id, item("a.mp3"));
  const first = await s.drain(id, ["x.mp3"]);
  assert.deepEqual(first.map((q) => q.path), ["a.mp3"]);
  assert.deepEqual(await s.drain(id), []); // cleared
  assert.equal(await s.isPlayed(id, "x.mp3"), true);
  assert.deepEqual(await s.drain("bad"), []);
});

test("clearPlayed wipes the dedup set; subsequent re-add of a played track is OK", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg);
  assert.equal(await s.enqueue(id, item("a.mp3")), "ok");
  assert.equal(await s.enqueue(id, item("a.mp3")), "played"); // blocked
  assert.equal(await s.clearPlayed(id), true);
  assert.equal(await s.isPlayed(id, "a.mp3"), false);
  assert.equal(await s.enqueue(id, item("a.mp3")), "ok"); // re-add succeeds
});

test("clearPlayed on a missing session returns false", async () => {
  const s = new SessionStore();
  assert.equal(await s.clearPlayed("nope"), false);
});

test("clearPlayed leaves the pending queue intact", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg);
  assert.equal(await s.enqueue(id, item("a.mp3")), "ok");
  assert.equal(await s.enqueue(id, item("b.mp3")), "ok");
  assert.equal(await s.clearPlayed(id), true);
  // pending still has both — clear only resets the dedup set.
  assert.deepEqual(
    (await s.get(id))?.pending.map((p) => p.path),
    ["a.mp3", "b.mp3"],
  );
});

test("parseNowPlaying: keeps a valid playhead, clamps it to the duration", async () => {
  const np = parseNowPlaying({ name: "A", path: "a.mp3", positionSec: 300, durationSec: 240, playing: true });
  assert.ok(np);
  assert.equal(np.positionSec, 240);
  assert.equal(np.durationSec, 240);
  assert.equal(np.playing, true);
});

test("parseNowPlaying: old clients and junk numbers give null playhead, not NaN", async () => {
  const np = parseNowPlaying({ name: "A", positionSec: -3, durationSec: "x" });
  assert.ok(np);
  assert.equal(np.positionSec, null);
  assert.equal(np.durationSec, null);
  assert.equal(np.playing, false);
});

test("parseNowPlaying: null clears, malformed means no change", async () => {
  assert.equal(parseNowPlaying(null), null);
  assert.equal(parseNowPlaying(undefined), undefined);
  assert.equal(parseNowPlaying({ artist: "no name" }), undefined);
  assert.equal(parseNowPlaying("A"), undefined);
});

test("the DJ's reported queue is kept and served; null until reported", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg);
  assert.equal((await s.get(id))?.upNext, null);
  await s.setUpNext(id, [item("a.mp3"), item("b.mp3")]);
  assert.deepEqual((await s.get(id))?.upNext?.map((t) => t.path), ["a.mp3", "b.mp3"]);
});

test("parseUpNext: drops malformed entries, caps the list, absent means no change", async () => {
  assert.equal(parseUpNext(undefined), undefined);
  assert.equal(parseUpNext("nope"), undefined);
  const out = parseUpNext([{ name: "A", path: "a.mp3", bpm: 120, by: "Ann" }, { name: "no path" }, null, { name: "B", path: "b.mp3", bpm: "x" }]);
  assert.deepEqual(out, [
    { name: "A", path: "a.mp3", bpm: 120, by: "Ann" },
    { name: "B", path: "b.mp3", bpm: null, by: null },
  ]);
  const many = Array.from({ length: 500 }, (_, i) => ({ name: `t${i}`, path: `t${i}.mp3` }));
  assert.equal(parseUpNext(many)?.length, 100);
});

test("votes: one per guest per track, toggle off, counts in the snapshot", async () => {
  const s = new SessionStore();
  const id = await s.create(cfg);
  assert.deepEqual(await s.vote(id, "a.mp3", "g1", true), { count: 1, voted: true });
  assert.deepEqual(await s.vote(id, "a.mp3", "g1", true), { count: 1, voted: true }); // again: still one
  assert.deepEqual(await s.vote(id, "a.mp3", "g2", true), { count: 2, voted: true });
  assert.deepEqual(await s.vote(id, "b.mp3", "g1", true), { count: 1, voted: true });
  assert.deepEqual((await s.get(id))?.votes, { "a.mp3": 2, "b.mp3": 1 });
  assert.deepEqual((await s.votesOf(id, "g1")).sort(), ["a.mp3", "b.mp3"]);
  assert.deepEqual(await s.vote(id, "b.mp3", "g1", false), { count: 0, voted: false });
  assert.deepEqual(await s.vote(id, "b.mp3", "g1", false), { count: 0, voted: false });
  assert.deepEqual(await s.voteCounts(id), { "a.mp3": 2 });
  assert.equal(await s.vote("nope", "a.mp3", "g1", true), "not-found");
  assert.equal(await s.vote(id, "", "g1", true), "invalid");
  assert.equal(await s.vote(id, "a.mp3", "", true), "invalid");
});

test("sanitizeGuestId keeps [a-z0-9], max 32", async () => {
  const { sanitizeGuestId } = await import("../../src/infrastructure/session-store.ts");
  assert.equal(sanitizeGuestId("AB-c_9!"), "abc9");
  assert.equal(sanitizeGuestId("x".repeat(40)).length, 32);
  assert.equal(sanitizeGuestId(5), "");
});
