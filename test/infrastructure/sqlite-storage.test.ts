// End-to-end smoke for the SQLite storage adapters. Uses an in-memory
// DB so the test suite doesn't touch the filesystem; the schema +
// query shapes get exercised together.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema, type Db } from "../../src/infrastructure/sqlite-pool.ts";
import { SqliteAnalysisRepository } from "../../src/infrastructure/sqlite-analysis-repository.ts";
import { SqliteCrateRepository } from "../../src/infrastructure/sqlite-crate-repository.ts";
import { SqliteUserRepository } from "../../src/infrastructure/sqlite-user-repository.ts";
import { SqliteBeatGridRepository } from "../../src/infrastructure/sqlite-beat-grid-repository.ts";
import { SqliteRemoteLibrariesRepository } from "../../src/infrastructure/sqlite-remote-libraries-repository.ts";

// Skip the pool's path-keyed cache: it's a single in-memory DB per
// test, never reused. ":memory:" is the special path; passing it to
// openDb wouldn't help because the cache would tie all tests together.
function fresh(): Db {
  const db = new DatabaseSync(":memory:");
  ensureSchema(db);
  return db;
}

test("sqlite: analysis put/all/page round-trips and paginates", async () => {
  const repo = new SqliteAnalysisRepository(fresh());
  await repo.put("u1", "a.mp3", {
    bpm: 120, size: 1, mtime: 1,
    key: "C", mode: "maj", camelot: "8B", energy: 0.7,
    artist: "X", title: "A",
  });
  await repo.put("u1", "b.mp3", {
    bpm: 90, size: 1, mtime: 1,
    key: null, mode: null, camelot: null, energy: null,
    artist: null, title: "B",
  });
  // Scoped by user: u2 sees nothing.
  assert.deepEqual(await repo.all("u2"), {});

  const all = await repo.all("u1");
  assert.equal(Object.keys(all).length, 2);
  assert.equal(all["a.mp3"]?.bpm, 120);
  assert.equal(all["a.mp3"]?.camelot, "8B");

  const p = await repo.page("u1", {
    q: "", sort: "title", dir: "asc", limit: 10, offset: 0,
  });
  assert.equal(p.total, 2);
  assert.deepEqual(p.items.map((i) => i.id), ["a.mp3", "b.mp3"]);
});

test("sqlite: analysis search filters by title/artist/track_id", async () => {
  const repo = new SqliteAnalysisRepository(fresh());
  await repo.put("u", "track-one.mp3", {
    bpm: 100, size: 1, mtime: 1, artist: "Artist1", title: "Song One",
  });
  await repo.put("u", "track-two.mp3", {
    bpm: 100, size: 1, mtime: 1, artist: "Other", title: "Different",
  });
  const p = await repo.page("u", {
    q: "Song", sort: "title", dir: "asc", limit: 10, offset: 0,
  });
  assert.equal(p.total, 1);
  assert.equal(p.items[0]?.id, "track-one.mp3");
});

test("sqlite: crates round-trip and remove", async () => {
  const repo = new SqliteCrateRepository(fresh());
  await repo.put("u", "house", ["a", "b", "c"]);
  await repo.put("u", "techno", ["d"]);
  const all = await repo.all("u");
  assert.deepEqual(all.house, ["a", "b", "c"]);
  assert.deepEqual(all.techno, ["d"]);

  // Upsert overwrites
  await repo.put("u", "house", ["x"]);
  assert.deepEqual((await repo.all("u")).house, ["x"]);

  await repo.remove("u", "house");
  assert.equal((await repo.all("u")).house, undefined);
});

test("sqlite: users create/find/update/count/allIds", async () => {
  const repo = new SqliteUserRepository(fresh());
  await repo.create({
    id: "id1",
    username: "marijn",
    pwSalt: "salt",
    pwHash: "hash",
    totpSecret: "abcd",
    totpEnabled: true,
    recoveryCodes: ["c1", "c2"],
    plan: "pro",
    createdAt: 42,
  });
  assert.equal(await repo.count(), 1);

  const fetched = await repo.findByUsername("marijn");
  assert.equal(fetched?.id, "id1");
  assert.equal(fetched?.totpEnabled, true);
  assert.deepEqual(fetched?.recoveryCodes, ["c1", "c2"]);
  assert.equal(fetched?.plan, "pro");

  await repo.update({ ...fetched!, totpEnabled: false, recoveryCodes: null });
  const after = await repo.findById("id1");
  assert.equal(after?.totpEnabled, false);
  assert.equal(after?.recoveryCodes, null);

  assert.deepEqual(await repo.allIds(), ["id1"]);
});

test("sqlite: beat grids round-trip a Float32 BLOB", async () => {
  const repo = new SqliteBeatGridRepository(fresh());
  const beats = new Float32Array([0.5, 1.0, 1.5, 2.0]);
  await repo.put("u", {
    trackId: "x.mp3",
    durationSec: 2.5,
    beats,
    downbeatPhase: 2,
    firstSolidBeatIndex: 0,
    confidence: 0.92,
    analyzerVersion: 1,
  });

  assert.equal(await repo.has("u", "x.mp3"), true);
  assert.equal(await repo.has("u", "missing.mp3"), false);

  const got = await repo.get("u", "x.mp3");
  assert.equal(got?.durationSec, 2.5);
  assert.equal(got?.downbeatPhase, 2);
  assert.equal(got?.beats.length, 4);
  assert.equal(got?.beats[2], 1.5);
});

test("sqlite: remote libraries enforce single-active + promote on delete", async () => {
  const repo = new SqliteRemoteLibrariesRepository(fresh());

  const a = await repo.create("u", {
    kind: "pta", name: "NAS", baseUrl: "http://nas:3000", apiKey: "k1",
  });
  // Tiny pause so created_at orders strictly increase for the
  // "oldest remaining gets promoted" check.
  await new Promise((r) => setTimeout(r, 2));
  const b = await repo.create("u", {
    kind: "jamendo", name: "Jam", baseUrl: null, apiKey: "client",
  });
  await new Promise((r) => setTimeout(r, 2));
  const c = await repo.create("u", {
    kind: "pta", name: "Other", baseUrl: "http://o:3000", apiKey: "k2",
  });

  // First insert auto-actives; the rest don't.
  assert.equal(a.isActive, true);
  assert.equal(b.isActive, false);
  assert.equal(c.isActive, false);

  assert.equal((await repo.getActive("u"))?.id, a.id);

  // setActive flips exactly one row on at a time.
  assert.equal(await repo.setActive("u", c.id), true);
  assert.equal((await repo.getActive("u"))?.id, c.id);
  const list = await repo.listForUser("u");
  assert.equal(list.filter((r) => r.isActive).length, 1);

  // Update returns the patched row.
  const patched = await repo.update("u", b.id, { name: "Jamendo Renamed" });
  assert.equal(patched?.name, "Jamendo Renamed");
  // Unknown id → null.
  assert.equal(
    await repo.update("u", "nope", { name: "x" }),
    null,
  );

  // Deleting the active row promotes the oldest remaining one.
  assert.equal(await repo.delete("u", c.id), true);
  assert.equal((await repo.getActive("u"))?.id, a.id);

  // Deleting a non-existent row returns false.
  assert.equal(await repo.delete("u", "nope"), false);
});

test("sqlite: remote libraries scope by user", async () => {
  const repo = new SqliteRemoteLibrariesRepository(fresh());
  await repo.create("alice", {
    kind: "pta", name: "A", baseUrl: "http://a:3000", apiKey: "k",
  });
  await repo.create("bob", {
    kind: "pta", name: "B", baseUrl: "http://b:3000", apiKey: "k",
  });
  assert.equal((await repo.listForUser("alice")).length, 1);
  assert.equal((await repo.listForUser("bob")).length, 1);
  assert.equal((await repo.listForUser("carol")).length, 0);
});
