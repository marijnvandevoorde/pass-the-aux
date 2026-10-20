import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ensureSchema } from "../../src/infrastructure/sqlite-pool.ts";
import { SqlitePartySessionRepository } from "../../src/infrastructure/sqlite-party-session-repository.ts";
import { partySessionContract } from "./_party-session-contract.ts";

test("sqlite: party sessions round-trip, rev, touch and idle sweep", async () => {
  const db = new DatabaseSync(":memory:");
  ensureSchema(db);
  await partySessionContract(new SqlitePartySessionRepository(db), "t");
});
