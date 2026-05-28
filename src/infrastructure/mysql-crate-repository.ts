import type { CrateRepository } from "../domain/ports/crate-repository.ts";
import { ensureSchema, type Db } from "./mysql-pool.ts";

/** Coerce a JSON column into a clean string[] (unit-tested). mysql2
 *  may hand JSON back already-parsed or as a string. */
export function asTrackIds(value: unknown): string[] {
  let v = value;
  if (typeof v === "string") {
    try {
      v = JSON.parse(v);
    } catch {
      return [];
    }
  }
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** MySQL-backed crates. Same port as the JSON one. */
export class MysqlCrateRepository implements CrateRepository {
  readonly #pool: Db;

  constructor(pool: Db) {
    this.#pool = pool;
  }

  async all(userId: string): Promise<Record<string, string[]>> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      "SELECT name, track_ids FROM crates WHERE user_id = :uid",
      { uid: userId },
    );
    const out: Record<string, string[]> = {};
    for (const r of rows as Array<{ name: string; track_ids: unknown }>) {
      out[r.name] = asTrackIds(r.track_ids);
    }
    return out;
  }

  async put(
    userId: string,
    name: string,
    trackIds: string[],
  ): Promise<void> {
    await ensureSchema(this.#pool);
    await this.#pool.execute(
      `INSERT INTO crates (user_id, name, track_ids) VALUES (:uid, :name, :ids)
       ON DUPLICATE KEY UPDATE track_ids=VALUES(track_ids)`,
      { uid: userId, name, ids: JSON.stringify(trackIds) },
    );
  }

  async remove(userId: string, name: string): Promise<void> {
    await ensureSchema(this.#pool);
    await this.#pool.execute(
      "DELETE FROM crates WHERE user_id = :uid AND name = :name",
      { uid: userId, name },
    );
  }
}
