import type { NowPlaying, SessionConfigDTO, SessionQueueItem } from "../domain/party-session.ts";
import type {
  PartySessionRepository,
  StoredPartySession,
} from "../domain/ports/party-session-repository.ts";
import { ensureSchema, type Db } from "./sqlite-pool.ts";
import { pathKey, statePatch, toStored, type RequestRow, type SessionRow } from "./party-session-rows.ts";

const CHILD_TABLES = ["party_session_requests", "party_session_played", "party_session_votes"];

/** SQLite-backed party sessions. */
export class SqlitePartySessionRepository implements PartySessionRepository {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  #ready(): Db {
    ensureSchema(this.#db);
    return this.#db;
  }

  #bump(id: string, at: number): void {
    this.#db
      .prepare("UPDATE party_sessions SET rev = rev + 1, updated_at = :at WHERE id = :id")
      .run({ id, at });
  }

  async load(id: string): Promise<StoredPartySession | null> {
    const db = this.#ready();
    const s = db.prepare("SELECT * FROM party_sessions WHERE id = :id").get({ id }) as
      | SessionRow
      | undefined;
    if (!s) return null;
    const requests = db
      .prepare(
        `SELECT seq, name, path, bpm, by_name FROM party_session_requests
          WHERE session_id = :id ORDER BY seq`,
      )
      .all({ id }) as unknown as RequestRow[];
    const played = db
      .prepare("SELECT path FROM party_session_played WHERE session_id = :id ORDER BY created_at, path_key")
      .all({ id }) as unknown as Array<{ path: string }>;
    const votes = db
      .prepare(
        `SELECT path, guest FROM party_session_votes
          WHERE session_id = :id ORDER BY created_at, path_key, guest`,
      )
      .all({ id }) as unknown as Array<{ path: string; guest: string }>;
    return toStored(s, requests, played, votes);
  }

  async rev(id: string): Promise<number | null> {
    const r = this.#ready().prepare("SELECT rev FROM party_sessions WHERE id = :id").get({ id }) as
      | { rev: number }
      | undefined;
    return r ? Number(r.rev) : null;
  }

  async create(s: { id: string; ownerUserId: string; config: SessionConfigDTO; at: number }): Promise<boolean> {
    const r = this.#ready()
      .prepare(
        `INSERT INTO party_sessions (id, owner_user_id, config, rev, created_at, updated_at)
         VALUES (:id, :owner, :config, 0, :at, :at)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run({ id: s.id, owner: s.ownerUserId, config: JSON.stringify(s.config), at: s.at });
    return Number(r.changes) > 0;
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
    const { sets, values } = statePatch(patch);
    this.#ready()
      .prepare(
        `UPDATE party_sessions SET ${[...sets, "rev = rev + 1", "updated_at = :at"].join(", ")}
          WHERE id = :id`,
      )
      .run({ ...values, id, at });
  }

  async addRequest(id: string, item: SessionQueueItem, at: number): Promise<number> {
    const r = this.#ready()
      .prepare(
        `INSERT INTO party_session_requests (session_id, name, path, bpm, by_name, created_at)
         VALUES (:id, :name, :path, :bpm, :by, :at)`,
      )
      .run({ id, name: item.name, path: item.path, bpm: item.bpm, by: item.by, at });
    this.#bump(id, at);
    return Number(r.lastInsertRowid);
  }

  async removeRequests(id: string, seqs: number[], at: number): Promise<void> {
    const del = this.#ready().prepare(
      "DELETE FROM party_session_requests WHERE session_id = :id AND seq = :seq",
    );
    for (const seq of seqs) del.run({ id, seq });
    this.#bump(id, at);
  }

  async addPlayed(id: string, paths: string[], at: number): Promise<void> {
    const ins = this.#ready().prepare(
      `INSERT INTO party_session_played (session_id, path_key, path, created_at)
       VALUES (:id, :key, :path, :at) ON CONFLICT DO NOTHING`,
    );
    for (const path of paths) ins.run({ id, key: pathKey(path), path, at });
    this.#bump(id, at);
  }

  async clearPlayed(id: string, at: number): Promise<void> {
    this.#ready().prepare("DELETE FROM party_session_played WHERE session_id = :id").run({ id });
    this.#bump(id, at);
  }

  async setVote(id: string, path: string, guest: string, on: boolean, at: number): Promise<void> {
    const db = this.#ready();
    if (on) {
      db.prepare(
        `INSERT INTO party_session_votes (session_id, path_key, guest, path, created_at)
         VALUES (:id, :key, :guest, :path, :at) ON CONFLICT DO NOTHING`,
      ).run({ id, key: pathKey(path), guest, path, at });
    } else {
      db.prepare(
        "DELETE FROM party_session_votes WHERE session_id = :id AND path_key = :key AND guest = :guest",
      ).run({ id, key: pathKey(path), guest });
    }
    this.#bump(id, at);
  }

  async dropVotes(id: string, path: string, at: number): Promise<void> {
    this.#ready()
      .prepare("DELETE FROM party_session_votes WHERE session_id = :id AND path_key = :key")
      .run({ id, key: pathKey(path) });
    this.#bump(id, at);
  }

  async touch(id: string, at: number): Promise<void> {
    this.#ready()
      .prepare("UPDATE party_sessions SET updated_at = MAX(updated_at, :at) WHERE id = :id")
      .run({ id, at });
  }

  async deleteIdleSince(cutoff: number): Promise<number> {
    const db = this.#ready();
    const r = db.prepare("DELETE FROM party_sessions WHERE updated_at < :cutoff").run({ cutoff });
    // Also catches rows left behind by a session deleted mid-write.
    for (const t of CHILD_TABLES) {
      db.exec(`DELETE FROM ${t} WHERE session_id NOT IN (SELECT id FROM party_sessions)`);
    }
    return Number(r.changes);
  }
}
