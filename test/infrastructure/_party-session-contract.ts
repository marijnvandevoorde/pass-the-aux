// One behaviour check for every PartySessionRepository (sqlite, mysql).
// Timestamps are tiny (1970), so the idle sweeps only ever touch the
// test's own sessions, even on a shared dev database.
import assert from "node:assert/strict";
import type { PartySessionRepository } from "../../src/domain/ports/party-session-repository.ts";

const cfg = { automix: true, autoFill: false, beatSync: true, fadeSeconds: 8, showUpNext: true };

export async function partySessionContract(repo: PartySessionRepository, prefix: string): Promise<void> {
  const id = `${prefix}a`;
  const other = `${prefix}b`;
  assert.equal(await repo.load(id), null);
  assert.equal(await repo.rev(id), null);

  assert.equal(await repo.create({ id, ownerUserId: "dj", config: cfg, at: 1000 }), true);
  assert.equal(await repo.create({ id, ownerUserId: "x", config: cfg, at: 2000 }), false, "id taken");
  await repo.create({ id: other, ownerUserId: "dj2", config: cfg, at: 1000 });

  let s = await repo.load(id);
  assert.ok(s);
  assert.equal(s.ownerUserId, "dj", "first create wins");
  assert.deepEqual(s.config, cfg);
  assert.equal(s.rev, 0);
  assert.equal(s.createdAt, 1000);
  assert.deepEqual([s.requests, s.played, s.votes, s.upNext, s.nowPlaying], [[], [], [], null, null]);

  // Each write bumps rev once.
  const longPath = `${"deep/".repeat(150)}track.mp3`; // > 512 chars
  const seqA = await repo.addRequest(id, { name: "A", path: "a.mp3", bpm: 120, by: "Ann" }, 1100);
  const seqB = await repo.addRequest(id, { name: "Long", path: longPath, bpm: null, by: null }, 1101);
  assert.ok(seqB > seqA);
  await repo.addPlayed(id, ["a.mp3", longPath, "a.mp3"], 1102);
  await repo.setVote(id, "a.mp3", "g1", true, 1103);
  await repo.setVote(id, "a.mp3", "g1", true, 1104); // again: still one
  await repo.setVote(id, "a.mp3", "g2", true, 1105);
  await repo.setVote(id, longPath, "g1", true, 1106);
  const np = { name: "A", artist: "X", bpm: 120, path: "a.mp3", by: null, positionSec: 12, durationSec: 200, playing: true };
  await repo.saveState(id, { nowPlaying: { track: np, at: 1107 } }, 1107);
  await repo.saveState(id, { upNext: [{ name: "A", path: "a.mp3", bpm: 120, by: "Ann" }] }, 1108);
  await repo.saveState(id, { config: { ...cfg, showUpNext: false } }, 1109);
  assert.equal(await repo.rev(id), 10);

  s = await repo.load(id);
  assert.ok(s);
  assert.equal(s.updatedAt, 1109);
  assert.deepEqual(
    s.requests.map((r) => [r.seq, r.name, r.path, r.bpm, r.by]),
    [[seqA, "A", "a.mp3", 120, "Ann"], [seqB, "Long", longPath, null, null]],
  );
  assert.deepEqual(s.played.sort(), ["a.mp3", longPath].sort());
  assert.deepEqual(s.votes, [
    { path: "a.mp3", guest: "g1" },
    { path: "a.mp3", guest: "g2" },
    { path: longPath, guest: "g1" },
  ]);
  assert.deepEqual(s.nowPlaying, np);
  assert.equal(s.nowPlayingAt, 1107);
  assert.deepEqual(s.upNext, [{ name: "A", path: "a.mp3", bpm: 120, by: "Ann" }]);
  assert.equal(s.config.showUpNext, false);

  // Scoped by session.
  const o = await repo.load(other);
  assert.ok(o);
  assert.deepEqual([o.requests, o.played, o.votes], [[], [], []]);

  await repo.removeRequests(id, [seqA], 1200);
  await repo.setVote(id, "a.mp3", "g1", false, 1201);
  await repo.dropVotes(id, longPath, 1202);
  await repo.saveState(id, { nowPlaying: { track: null, at: null } }, 1203);
  s = await repo.load(id);
  assert.ok(s);
  assert.deepEqual(s.requests.map((r) => r.seq), [seqB]);
  assert.deepEqual(s.votes, [{ path: "a.mp3", guest: "g2" }]);
  assert.equal(s.nowPlaying, null);
  assert.equal(s.nowPlayingAt, null);
  await repo.clearPlayed(id, 1204);
  assert.deepEqual((await repo.load(id))?.played, []);

  // touch moves updatedAt (never back) without a rev bump.
  const rev = await repo.rev(id);
  await repo.touch(id, 5000);
  await repo.touch(id, 4000);
  assert.equal((await repo.load(id))?.updatedAt, 5000);
  assert.equal(await repo.rev(id), rev);

  // Idle sweep: `other` (updated at 1000) goes, with its rows; `id` stays.
  await repo.addRequest(other, { name: "B", path: "b.mp3", bpm: null, by: null }, 900);
  await repo.setVote(other, "b.mp3", "g1", true, 900);
  await repo.saveState(other, {}, 1000); // updatedAt back to 1000
  assert.equal(await repo.deleteIdleSince(3000), 1);
  assert.equal(await repo.load(other), null);
  assert.ok(await repo.load(id));
  // A re-created id starts empty (no rows left behind).
  await repo.create({ id: other, ownerUserId: "dj2", config: cfg, at: 6000 });
  const fresh = await repo.load(other);
  assert.deepEqual([fresh?.requests, fresh?.votes], [[], []]);
  // Test timestamps are tiny, so this only removes the test's sessions.
  await repo.deleteIdleSince(10_000);
  assert.equal(await repo.load(id), null);
  assert.equal(await repo.load(other), null);
}
