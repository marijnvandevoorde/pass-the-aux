import type { ResultSetHeader } from "mysql2/promise";
import type { NowPlaying, SessionConfigDTO, SessionQueueItem } from "../domain/party-session.ts";
import type {
  PartySessionRepository,
  StoredPartySession,
} from "../domain/ports/party-session-repository.ts";
import { ensureSchema, type Db } from "./mysql-pool.ts";
import { pathKey, statePatch, toStored, type RequestRow, type SessionRow } from "./party-session-rows.ts";

const CHILD_TABLES = ["party_session_requests", "party_session_played", "party_session_votes"];

/** MySQL-backed party sessions. */
export class MysqlPartySessionRepository implements PartySessionRepository {
  readonly #pool: Db;
  constructor(pool: Db) {
    this.#pool = pool;
  }

  async #ready(): Promise<Db> {
    await ensureSchema(this.#pool);
    return this.#pool;
  }

  async #bump(id: string, at: number): Promise<void> {
    await this.#pool.execute(
      "UPDATE party_sessions SET rev = rev + 1, updated_at = :at WHERE id = :id",
      { id, at },
    );
  }

  async load(id: string): Promise<StoredPartySession | null> {
    const db = await this.#ready();
    const [rows] = await db.execute("SELECT * FROM party_sessions WHERE id = :id", { id });
    const s = (rows as SessionRow[])[0];
    if (!s) return null;
    const [requests] = await db.execute(
      `SELECT seq, name, path, bpm, by_name FROM party_session_requests
        WHERE session_id = :id ORDER BY seq`,
      { id },
    );
    const [played] = await db.execute(
      "SELECT path FROM party_session_played WHERE session_id = :id ORDER BY created_at, path_key",
      { id },
    );
    const [votes] = await db.execute(
      `SELECT path, guest FROM party_session_votes
        WHERE session_id = :id ORDER BY created_at, path_key, guest`,
      { id },
    );
    return toStored(
      s,
      requests as RequestRow[],
      played as Array<{ path: string }>,
      votes as Array<{ path: string; guest: string }>,
    );
  }

  async rev(id: string): Promise<number | null> {
    const db = await this.#ready();
    const [rows] = await db.execute("SELECT rev FROM party_sessions WHERE id = :id", { id });
    const r = (rows as Array<{ rev: number | string }>)[0];
    return r ? Number(r.rev) : null;
  }

  async create(s: { id: string; ownerUserId: string; config: SessionConfigDTO; at: number }): Promise<boolean> {
    const db = await this.#ready();
    const [r] = await db.execute(
      `INSERT IGNORE INTO party_sessions (id, owner_user_id, config, rev, created_at, updated_at)
       VALUES (:id, :owner, :config, 0, :at, :at)`,
      { id: s.id, owner: s.ownerUserId, config: JSON.stringify(s.config), at: s.at },
    );
    return (r as ResultSetHeader).affectedRows > 0;
  }

  async saveState(
    id: string,
    patch: {
      config?: SessionConfigDTO;
      nowPlaying?: { track: NowPlaying | null; at: number | null };
      upNext?: SessionQueueItem[];
    },
    at: number,
  ): Promise<void> {
    const db = await this.#ready();
    const { sets, values } = statePatch(patch);
    await db.execute(
      `UPDATE party_sessions SET ${[...sets, "rev = rev + 1", "updated_at = :at"].join(", ")}
        WHERE id = :id`,
      { ...values, id, at },
    );
  }

  async addRequest(id: string, item: SessionQueueItem, at: number): Promise<number> {
    const db = await this.#ready();
    const [r] = await db.execute(
      `INSERT INTO party_session_requests (session_id, name, path, bpm, by_name, created_at)
       VALUES (:id, :name, :path, :bpm, :by, :at)`,
      { id, name: item.name, path: item.path, bpm: item.bpm, by: item.by, at },
    );
    await this.#bump(id, at);
    return Number((r as ResultSetHeader).insertId);
  }

  async removeRequests(id: string, seqs: number[], at: number): Promise<void> {
    const db = await this.#ready();
    for (const seq of seqs) {
      await db.execute(
        "DELETE FROM party_session_requests WHERE session_id = :id AND seq = :seq",
        { id, seq },
      );
    }
    await this.#bump(id, at);
  }

  async addPlayed(id: string, paths: string[], at: number): Promise<void> {
    const db = await this.#ready();
    for (const path of paths) {
      await db.execute(
        `INSERT IGNORE INTO party_session_played (session_id, path_key, path, created_at)
         VALUES (:id, :key, :path, :at)`,
        { id, key: pathKey(path), path, at },
      );
    }
    await this.#bump(id, at);
  }

  async clearPlayed(id: string, at: number): Promise<void> {
    const db = await this.#ready();
    await db.execute("DELETE FROM party_session_played WHERE session_id = :id", { id });
    await this.#bump(id, at);
  }

  async setVote(id: string, path: string, guest: string, on: boolean, at: number): Promise<void> {
    const db = await this.#ready();
    if (on) {
      await db.execute(
        `INSERT IGNORE INTO party_session_votes (session_id, path_key, guest, path, created_at)
         VALUES (:id, :key, :guest, :path, :at)`,
        { id, key: pathKey(path), guest, path, at },
      );
    } else {
      await db.execute(
        "DELETE FROM party_session_votes WHERE session_id = :id AND path_key = :key AND guest = :guest",
        { id, key: pathKey(path), guest },
      );
    }
    await this.#bump(id, at);
  }

  async dropVotes(id: string, path: string, at: number): Promise<void> {
    const db = await this.#ready();
    await db.execute(
      "DELETE FROM party_session_votes WHERE session_id = :id AND path_key = :key",
      { id, key: pathKey(path) },
    );
    await this.#bump(id, at);
  }

  async touch(id: string, at: number): Promise<void> {
    const db = await this.#ready();
    await db.execute(
      "UPDATE party_sessions SET updated_at = GREATEST(updated_at, :at) WHERE id = :id",
      { id, at },
    );
  }

  async deleteIdleSince(cutoff: number): Promise<number> {
    const db = await this.#ready();
    const [r] = await db.execute("DELETE FROM party_sessions WHERE updated_at < :cutoff", { cutoff });
    // Also catches rows left behind by a session deleted mid-write.
    for (const t of CHILD_TABLES) {
      await db.query(`DELETE FROM ${t} WHERE session_id NOT IN (SELECT id FROM party_sessions)`);
    }
    return (r as ResultSetHeader).affectedRows;
  }
}
