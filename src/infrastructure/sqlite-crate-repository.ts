import type { CrateRepository } from "../domain/ports/crate-repository.ts";
import { ensureSchema, type Db } from "./sqlite-pool.ts";

/** SQLite-backed crates. Track ids are JSON-encoded in a TEXT column. */
export class SqliteCrateRepository implements CrateRepository {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async all(userId: string): Promise<Record<string, string[]>> {
    ensureSchema(this.#db);
    const rows = this.#db
      .prepare("SELECT name, track_ids FROM crates WHERE user_id = :uid")
      .all({ uid: userId }) as unknown as Array<{
      name: string;
      track_ids: string;
    }>;
    const out: Record<string, string[]> = {};
    for (const r of rows) out[r.name] = parseIds(r.track_ids);
    return out;
  }

  async put(
    userId: string,
    name: string,
    trackIds: string[],
  ): Promise<void> {
    ensureSchema(this.#db);
    this.#db
      .prepare(
        `INSERT INTO crates (user_id, name, track_ids) VALUES (:uid, :name, :ids)
         ON CONFLICT (user_id, name) DO UPDATE SET track_ids=excluded.track_ids`,
      )
      .run({ uid: userId, name, ids: JSON.stringify(trackIds) });
  }

  async remove(userId: string, name: string): Promise<void> {
    ensureSchema(this.#db);
    this.#db
      .prepare("DELETE FROM crates WHERE user_id = :uid AND name = :name")
      .run({ uid: userId, name });
  }
}

function parseIds(value: string): string[] {
  try {
    const v = JSON.parse(value);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}
