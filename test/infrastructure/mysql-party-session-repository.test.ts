import test from "node:test";
import { loadEnv, loadConfig } from "../../src/infrastructure/config.ts";
import { createDbPool, type Db } from "../../src/infrastructure/mysql-pool.ts";
import { MysqlPartySessionRepository } from "../../src/infrastructure/mysql-party-session-repository.ts";
import { partySessionContract } from "./_party-session-contract.ts";

// Against the dev MySQL (docker-compose.mysql.yml) or a throwaway
// `mysql:8.4` (DB_HOST/DB_PORT/...); skips when none is reachable.
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

test("MySQL: party sessions round-trip, rev, touch and idle sweep (skips without a DB)", async (t) => {
  const pool = await reachable();
  if (!pool) {
    t.skip("no MySQL reachable (start docker-compose.mysql.yml)");
    return;
  }
  try {
    await partySessionContract(new MysqlPartySessionRepository(pool), `it${Date.now().toString(36)}`);
  } finally {
    await pool.end();
  }
});
