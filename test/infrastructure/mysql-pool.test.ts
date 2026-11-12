import test from "node:test";
import assert from "node:assert/strict";
import { ensureSchema, type Db } from "../../src/infrastructure/mysql-pool.ts";

test("mysql: a failed schema bootstrap is retried once the database is back", async () => {
  let down = true;
  let queries = 0;
  const pool = {
    query: async () => {
      if (down) throw new Error("connect ECONNREFUSED");
      queries++;
      return [[{ n: 1 }], []];
    },
  } as unknown as Db;

  await assert.rejects(ensureSchema(pool), /ECONNREFUSED/);
  down = false;
  await ensureSchema(pool); // would re-throw the memoised failure before
  assert.ok(queries > 0);
  const before = queries;
  await ensureSchema(pool); // success stays memoised
  assert.equal(queries, before);
});
