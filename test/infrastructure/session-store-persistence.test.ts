// SessionStore with storage behind it: a restart (a new store on the
// same database) keeps the party, two processes (rolling deploy) stay
// in step, the playhead isn't written on every tick, idle sessions go.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../../src/infrastructure/sqlite-pool.ts";
import { SqlitePartySessionRepository } from "../../src/infrastructure/sqlite-party-session-repository.ts";
import { SessionStore } from "../../src/infrastructure/session-store.ts";
import type { PartySessionRepository } from "../../src/domain/ports/party-session-repository.ts";

const cfg = { automix: true, autoFill: false, beatSync: true, fadeSeconds: 8, showUpNext: true };
const item = (p: string, by: string | null = null) => ({ name: p, path: p, bpm: null, by });
const np = (path: string, positionSec: number, playing = true) => ({
  name: path, artist: null, bpm: 120, path, by: null, positionSec, durationSec: 240, playing,
});

function repo(): SqlitePartySessionRepository {
  const db = new DatabaseSync(":memory:");
  ensureSchema(db);
  return new SqlitePartySessionRepository(db);
}

const WRITES = new Set(["saveState", "addRequest", "removeRequests", "addPlayed", "clearPlayed", "setVote", "dropVotes", "touch"]);

/** Delegates to `inner` (its methods use private fields, so they're
 *  bound to it), with some methods replaced. */
function wrap(
  inner: PartySessionRepository,
  over: Partial<Record<keyof PartySessionRepository, (...a: unknown[]) => Promise<unknown>>> = {},
): PartySessionRepository {
  return new Proxy(inner, {
    get(target, prop) {
      const o = over[prop as keyof PartySessionRepository];
      if (o) return o;
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** Counts the writes that reach the repository. */
function counting(inner: PartySessionRepository): PartySessionRepository & { writes: string[] } {
  const writes: string[] = [];
  const over: Record<string, (...a: unknown[]) => Promise<unknown>> = {};
  for (const m of WRITES) {
    const fn = (inner as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!.bind(inner);
    over[m] = (...a) => {
      writes.push(m);
      return fn(...a);
    };
  }
  return Object.assign(wrap(inner, over), { writes });
}

test("a restart keeps requests, played, votes, Up Next, now playing and config", async () => {
  const r = repo();
  const before = new SessionStore({ repo: r });
  const id = await before.create(cfg, "Friday", "dj1");
  assert.equal(id, "friday");
  assert.equal(await before.enqueue(id, item("a.mp3", "Ann")), "ok");
  assert.equal(await before.enqueue(id, item("b.mp3")), "ok");
  await before.drain(id, ["x.mp3"]); // DJ took a + b, played x
  assert.equal(await before.enqueue(id, item("c.mp3", "Bo")), "ok"); // not yet picked up
  await before.vote(id, "c.mp3", "g1", true);
  await before.vote(id, "c.mp3", "g2", true);
  await before.vote(id, "d.mp3", "g1", true);
  await before.vote(id, "d.mp3", "g1", false);
  await before.setUpNext(id, [item("c.mp3", "Bo"), item("e.mp3")]);
  await before.setNowPlaying(id, np("x.mp3", 30));
  await before.patchConfig(id, { showUpNext: false });

  const after = new SessionStore({ repo: r }); // the new process
  const snap = await after.get(id);
  assert.ok(snap, "guests' QR link still finds the session");
  assert.deepEqual(snap.pending, [item("c.mp3", "Bo")]);
  assert.deepEqual(snap.played.sort(), ["a.mp3", "b.mp3", "c.mp3", "x.mp3"]);
  assert.deepEqual(snap.votes, { "c.mp3": 2 });
  assert.deepEqual(await after.votesOf(id, "g1"), ["c.mp3"]);
  assert.deepEqual(snap.upNext?.map((t) => t.path), ["c.mp3", "e.mp3"]);
  assert.equal(snap.nowPlaying?.path, "x.mp3");
  assert.equal(snap.config.showUpNext, false);
  assert.equal(await after.ownerOf(id), "dj1");
  assert.equal(await after.enqueue(id, item("a.mp3")), "played", "no replays after a restart");
  // The DJ picks up what was waiting, once.
  assert.deepEqual((await after.drain(id)).map((q) => q.path), ["c.mp3"]);
  assert.deepEqual(await new SessionStore({ repo: r }).drain(id), []);
  // Re-registering the same id (mobile after a 404) keeps it all.
  assert.equal(await new SessionStore({ repo: r }).create(cfg, "friday", "dj1"), "friday");
  assert.deepEqual((await new SessionStore({ repo: r }).get(id))?.votes, { "c.mp3": 2 });
});

test("unknown and malformed ids don't exist after a restart either", async () => {
  const s = new SessionStore({ repo: repo() });
  assert.equal(await s.get("nope"), null);
  assert.equal(await s.has("Bad Id!"), false);
  assert.equal(await s.vote("nope", "a.mp3", "g1", true), "not-found");
});

test("the playhead isn't written on every report; a new track or pause is", async () => {
  const r = counting(repo());
  const s = new SessionStore({ repo: r });
  const id = await s.create(cfg);
  await s.setNowPlaying(id, np("a.mp3", 1));
  assert.deepEqual(r.writes, ["saveState"]);
  for (let t = 2; t < 30; t++) await s.setNowPlaying(id, np("a.mp3", t));
  assert.deepEqual(r.writes, ["saveState"], "ticks stay in memory");
  assert.equal((await s.get(id))?.nowPlaying?.positionSec, 29, "but are served");
  await s.setNowPlaying(id, np("a.mp3", 30, false));
  await s.setNowPlaying(id, np("b.mp3", 0));
  assert.equal(r.writes.length, 3);
  // An unchanged Up Next or played list (the DJ re-sends both) isn't written.
  await s.setUpNext(id, [item("c.mp3")]);
  await s.setUpNext(id, [item("c.mp3")]);
  await s.drain(id, ["a.mp3"]);
  await s.drain(id, ["a.mp3"]);
  await s.vote(id, "c.mp3", "g1", true);
  await s.vote(id, "c.mp3", "g1", true);
  assert.deepEqual(r.writes.slice(3), ["saveState", "addPlayed", "setVote"]);
});

test("two processes on one database stay in step (rolling deploy)", async () => {
  const r = repo();
  let now = 1_000_000;
  const clock = () => now;
  const oldPod = new SessionStore({ repo: r, now: clock, revalidateMs: 5000 });
  const newPod = new SessionStore({ repo: r, now: clock, revalidateMs: 5000 });
  const id = await oldPod.create(cfg, "party");
  await oldPod.vote(id, "a.mp3", "g1", true);
  assert.deepEqual(await newPod.voteCounts(id), { "a.mp3": 1 }, "loaded on first use");

  // Votes land on both pods; neither undoes the other in storage.
  await newPod.vote(id, "a.mp3", "g2", true);
  await oldPod.vote(id, "a.mp3", "g3", true);
  now += 5000;
  assert.deepEqual(await oldPod.voteCounts(id), { "a.mp3": 3 });
  assert.deepEqual(await newPod.voteCounts(id), { "a.mp3": 3 });

  // A request queued on one pod is handed to the DJ once, whichever pod
  // the DJ's poll reaches, even before the cache would be re-checked.
  assert.equal(await oldPod.enqueue(id, item("b.mp3")), "ok");
  assert.equal(await newPod.enqueue(id, item("b.mp3")), "played", "checked before queueing");
  assert.deepEqual((await newPod.drain(id)).map((q) => q.path), ["b.mp3"]);
  assert.deepEqual(await oldPod.drain(id), [], "not delivered twice");
});

test("idle sessions are swept from memory and storage; active ones stay", async () => {
  const r = repo();
  let now = 10_000_000;
  const clock = () => now;
  const s = new SessionStore({ repo: r, now: clock, ttlMs: 3600_000 });
  const idle = await s.create(cfg, "idle");
  const busy = await s.create(cfg, "busy");
  await s.vote(idle, "a.mp3", "g1", true);
  now += 1800_000;
  await s.vote(busy, "a.mp3", "g1", true);
  now += 1900_000; // idle: 62 min since last use, busy: 32 min
  assert.equal(await s.sweep(), 1);
  assert.equal(await s.has(idle), false);
  assert.equal(await new SessionStore({ repo: r }).has(idle), false);
  assert.equal(await s.has(busy), true);
});

test("polls keep a session alive without counting as changes", async () => {
  const r = counting(repo());
  let now = 10_000_000;
  const s = new SessionStore({ repo: r, now: () => now, ttlMs: 3600_000 });
  const id = await s.create(cfg, "party");
  for (let i = 0; i < 12; i++) {
    now += 10 * 60_000;
    await s.get(id); // the crowd screen polling
  }
  assert.ok(r.writes.every((w) => w === "touch") && r.writes.length > 0);
  assert.equal(await s.sweep(), 0);
  assert.ok(await new SessionStore({ repo: r }).has(id));
});

test("storage trouble doesn't stop the party: memory carries on", async () => {
  const r = repo();
  const broken = wrap(r, {
    setVote: async () => {
      throw new Error("db down");
    },
  });
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const s = new SessionStore({ repo: broken });
    const id = await s.create(cfg, "party");
    assert.deepEqual(await s.vote(id, "a.mp3", "g1", true), { count: 1, voted: true });
    assert.deepEqual(await s.voteCounts(id), { "a.mp3": 1 });
    assert.equal(errors.length, 1);
  } finally {
    console.error = orig;
  }
});
