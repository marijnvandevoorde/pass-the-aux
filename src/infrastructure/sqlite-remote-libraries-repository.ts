import { randomUUID } from "node:crypto";
import {
  isRemoteLibraryKind,
  type NewRemoteLibrary,
  type RemoteLibrariesRepository,
  type RemoteLibraryKind,
  type RemoteLibraryRow,
} from "../domain/ports/remote-libraries-repository.ts";
import { ensureSchema, type Db } from "./sqlite-pool.ts";

interface DbRow {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  base_url: string | null;
  api_key: string | null;
  is_active: number;
  created_at: number;
}

function rowToDomain(r: DbRow): RemoteLibraryRow {
  return {
    id: r.id,
    userId: r.user_id,
    kind: isRemoteLibraryKind(r.kind) ? r.kind : ("pta" as RemoteLibraryKind),
    name: r.name,
    baseUrl: r.base_url ?? null,
    apiKey: r.api_key ?? null,
    isActive: Boolean(r.is_active),
    createdAt: Number(r.created_at),
  };
}

const COLS =
  "id, user_id, kind, name, base_url, api_key, is_active, created_at";

/** SQLite-backed remote-libraries store. */
export class SqliteRemoteLibrariesRepository
  implements RemoteLibrariesRepository
{
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async listForUser(uid: string): Promise<RemoteLibraryRow[]> {
    ensureSchema(this.#db);
    const rows = this.#db
      .prepare(
        `SELECT ${COLS} FROM remote_libraries WHERE user_id = :uid ORDER BY created_at ASC`,
      )
      .all({ uid }) as unknown as DbRow[];
    return rows.map(rowToDomain);
  }

  async getActive(uid: string): Promise<RemoteLibraryRow | null> {
    ensureSchema(this.#db);
    const row = this.#db
      .prepare(
        `SELECT ${COLS} FROM remote_libraries
         WHERE user_id = :uid AND is_active = 1
         LIMIT 1`,
      )
      .get({ uid }) as unknown as DbRow | undefined;
    return row ? rowToDomain(row) : null;
  }

  async create(
    uid: string,
    input: NewRemoteLibrary,
  ): Promise<RemoteLibraryRow> {
    ensureSchema(this.#db);
    const id = randomUUID();
    return this.#tx(() => {
      const cnt = this.#db
        .prepare(
          "SELECT COUNT(*) AS n FROM remote_libraries WHERE user_id = :uid",
        )
        .get({ uid }) as { n: number } | undefined;
      const isActive = Number(cnt?.n ?? 0) === 0;
      const createdAt = Date.now();
      this.#db
        .prepare(
          `INSERT INTO remote_libraries (${COLS})
           VALUES (:id, :uid, :kind, :name, :baseUrl, :apiKey, :isActive, :createdAt)`,
        )
        .run({
          id,
          uid,
          kind: input.kind,
          name: input.name,
          baseUrl: input.baseUrl ?? null,
          apiKey: input.apiKey ?? null,
          isActive: isActive ? 1 : 0,
          createdAt,
        });
      return {
        id,
        userId: uid,
        kind: input.kind,
        name: input.name,
        baseUrl: input.baseUrl ?? null,
        apiKey: input.apiKey ?? null,
        isActive,
        createdAt,
      };
    });
  }

  async update(
    uid: string,
    id: string,
    patch: Partial<NewRemoteLibrary>,
  ): Promise<RemoteLibraryRow | null> {
    ensureSchema(this.#db);
    const fields: string[] = [];
    const params: Record<string, string | number | null> = { uid, id };
    if (patch.kind !== undefined) {
      fields.push("kind = :kind");
      params.kind = patch.kind;
    }
    if (patch.name !== undefined) {
      fields.push("name = :name");
      params.name = patch.name;
    }
    if (patch.baseUrl !== undefined) {
      fields.push("base_url = :baseUrl");
      params.baseUrl = patch.baseUrl ?? null;
    }
    if (patch.apiKey !== undefined) {
      fields.push("api_key = :apiKey");
      params.apiKey = patch.apiKey ?? null;
    }
    if (fields.length === 0) {
      const row = this.#db
        .prepare(
          `SELECT ${COLS} FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1`,
        )
        .get({ uid, id }) as unknown as DbRow | undefined;
      return row ? rowToDomain(row) : null;
    }
    const result = this.#db
      .prepare(
        `UPDATE remote_libraries SET ${fields.join(", ")} WHERE user_id = :uid AND id = :id`,
      )
      .run(params);
    if (Number(result.changes) === 0) return null;
    // node:sqlite rejects extra named params, so the SELECT after the
    // UPDATE binds only the two it actually references.
    const row = this.#db
      .prepare(
        `SELECT ${COLS} FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1`,
      )
      .get({ uid, id }) as unknown as DbRow | undefined;
    return row ? rowToDomain(row) : null;
  }

  async delete(uid: string, id: string): Promise<boolean> {
    ensureSchema(this.#db);
    return this.#tx(() => {
      const wasActiveRow = this.#db
        .prepare(
          "SELECT is_active FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1",
        )
        .get({ uid, id }) as { is_active: number } | undefined;
      const wasActive = Boolean(wasActiveRow?.is_active);
      const result = this.#db
        .prepare(
          "DELETE FROM remote_libraries WHERE user_id = :uid AND id = :id",
        )
        .run({ uid, id });
      if (Number(result.changes) === 0) return false;
      if (wasActive) {
        // Promote the oldest remaining row, if any.
        const next = this.#db
          .prepare(
            `SELECT id FROM remote_libraries
             WHERE user_id = :uid
             ORDER BY created_at ASC
             LIMIT 1`,
          )
          .get({ uid }) as { id: string } | undefined;
        if (next) {
          this.#db
            .prepare(
              "UPDATE remote_libraries SET is_active = 1 WHERE user_id = :uid AND id = :id",
            )
            .run({ uid, id: next.id });
        }
      }
      return true;
    });
  }

  async setActive(uid: string, id: string): Promise<boolean> {
    ensureSchema(this.#db);
    return this.#tx(() => {
      const exists = this.#db
        .prepare(
          "SELECT id FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1",
        )
        .get({ uid, id });
      if (exists === undefined) return false;
      this.#db
        .prepare(
          "UPDATE remote_libraries SET is_active = 0 WHERE user_id = :uid",
        )
        .run({ uid });
      this.#db
        .prepare(
          "UPDATE remote_libraries SET is_active = 1 WHERE user_id = :uid AND id = :id",
        )
        .run({ uid, id });
      return true;
    });
  }

  /** Run `fn` inside a SQLite transaction. Rolls back on throw. */
  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const out = fn();
      this.#db.exec("COMMIT");
      return out;
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
}
