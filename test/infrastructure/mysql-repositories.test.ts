import test from "node:test";
import assert from "node:assert/strict";
import { loadEnv, loadConfig } from "../../src/infrastructure/config.ts";
import { createDbPool, type Db } from "../../src/infrastructure/mysql-pool.ts";
import { MysqlAnalysisRepository } from "../../src/infrastructure/mysql-analysis-repository.ts";
import { MysqlCrateRepository } from "../../src/infrastructure/mysql-crate-repository.ts";

// Integration test against the dev MySQL (docker-compose.mysql.yml).
// Skips cleanly when no DB is reachable so `npm test` stays green
// without Docker.
loadEnv();
const db = loadConfig().db;

async function reachable(): Promise<Db | null> {
  try {
    const pool = createDbPool({ ...db });
    await pool.query("SELECT 1");
    return pool;
  } catch {
    return null;
  }
}

test("MySQL repositories round-trip (skips without a DB)", async (t) => {
  const pool = await reachable();
  if (!pool) {
    t.skip("no MySQL reachable (start docker-compose.mysql.yml)");
    return;
  }
  try {
    const an = new MysqlAnalysisRepository(pool);
    const cr = new MysqlCrateRepository(pool);
    const u = `__itu__${Date.now()}`;
    const u2 = `${u}_other`;
    const id = `track-${Date.now()}.mp3`;
    const crate = `__it_crate__${Date.now()}`;

    await an.put(u, id, {
      bpm: 124.5,
      size: 999,
      mtime: 111,
      key: "9B",
      mode: "major",
      camelot: "9B",
      energy: 0.42,
    });
    await an.put(u2, id, { bpm: 1, size: 1, mtime: 1 }); // other user
    const all = await an.all(u);
    assert.ok(all[id], "analysis row persisted");
    assert.equal(all[id]!.bpm, 124.5);
    assert.equal(all[id]!.camelot, "9B");
    assert.ok(all[id]!.analyzedAt > 0);
    assert.equal((await an.all(u2))[id]!.bpm, 1, "scoped by user_id");

    // Cross-user isolation: SAME bare track_id, different user_id.
    // Neither user may ever see the other's row — filtering is by the
    // user_id column, NOT a track_id prefix.
    assert.equal(Object.keys(await an.all(u)).length, 1);
    assert.equal((await an.all(u))[id]!.bpm, 124.5); // u's value, not u2's
    const uPage = await an.page(u, {
      q: "",
      sort: "title",
      dir: "asc",
      limit: 100,
      offset: 0,
    });
    assert.equal(uPage.total, 1, "u sees only its own row");
    assert.ok(
      uPage.items.every((it) => !it.id.includes("/")),
      "track_id is a bare filename, never path-prefixed",
    );
    const u2Page = await an.page(u2, {
      q: id,
      sort: "title",
      dir: "asc",
      limit: 100,
      offset: 0,
    });
    assert.equal(u2Page.total, 1);
    assert.equal(u2Page.items[0]!.record.bpm, 1, "u2 sees only u2's row");

    // page() — search + sort + paginate, scoped by user_id
    await an.put(u, "Daft Punk - Aerodynamic.mp3", {
      bpm: 123,
      size: 2,
      mtime: 2,
      artist: "Daft Punk",
      title: "Aerodynamic",
    });
    const p = await an.page(u, {
      q: "aerodynamic",
      sort: "title",
      dir: "asc",
      limit: 10,
      offset: 0,
    });
    assert.equal(p.total, 1);
    assert.equal(p.items[0]!.id, "Daft Punk - Aerodynamic.mp3");
    assert.equal(p.items[0]!.record.bpm, 123);
    const firstPage = await an.page(u, {
      q: "",
      sort: "title",
      dir: "asc",
      limit: 1,
      offset: 0,
    });
    assert.equal(firstPage.items.length, 1);
    assert.ok(firstPage.total >= 2);
    await pool.execute(
      "DELETE FROM analysis WHERE user_id=? AND track_id=?",
      [u, "Daft Punk - Aerodynamic.mp3"],
    );

    // upsert (same user+id) must replace, not duplicate
    await an.put(u, id, { bpm: 130, size: 1, mtime: 2, energy: null });
    const all2 = await an.all(u);
    assert.equal(all2[id]!.bpm, 130);
    assert.equal(all2[id]!.energy, null);

    await cr.put(u, crate, ["a.mp3", "b.mp3"]);
    let crates = await cr.all(u);
    assert.deepEqual(crates[crate], ["a.mp3", "b.mp3"]);
    // columns must NOT be swapped — `name` holds the crate
    // name, `track_ids` holds the id array.
    const [raw] = await pool.execute(
      "SELECT name, track_ids FROM crates WHERE user_id=? AND name=?",
      [u, crate],
    );
    const row = (raw as Array<{ name: string; track_ids: unknown }>)[0]!;
    assert.equal(row.name, crate);
    assert.deepEqual(
      typeof row.track_ids === "string"
        ? JSON.parse(row.track_ids)
        : row.track_ids,
      ["a.mp3", "b.mp3"],
    );
    await cr.put(u, crate, ["only.mp3"]);
    crates = await cr.all(u);
    assert.deepEqual(crates[crate], ["only.mp3"]);
    await cr.remove(u, crate);
    crates = await cr.all(u);
    assert.equal(crates[crate], undefined);

    // cleanup the probe rows
    await pool.execute("DELETE FROM analysis WHERE user_id IN (?, ?)", [
      u,
      u2,
    ]);
  } finally {
    await pool.end();
  }
});
