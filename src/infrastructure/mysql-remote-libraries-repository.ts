import { randomUUID } from "node:crypto";
import {
  isRemoteLibraryKind,
  type NewRemoteLibrary,
  type RemoteLibrariesRepository,
  type RemoteLibraryKind,
  type RemoteLibraryRow,
} from "../domain/ports/remote-libraries-repository.ts";
import { ensureSchema, type Db } from "./mysql-pool.ts";

interface DbRow {
  id: string;
  user_id: string;
  kind: string;
  name: string;
  base_url: string | null;
  api_key: string | null;
  is_active: number | boolean;
  created_at: number | bigint;
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

/** MySQL-backed remote-libraries store. */
export class MysqlRemoteLibrariesRepository
  implements RemoteLibrariesRepository
{
  readonly #pool: Db;

  constructor(pool: Db) {
    this.#pool = pool;
  }

  async listForUser(uid: string): Promise<RemoteLibraryRow[]> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      `SELECT ${COLS} FROM remote_libraries WHERE user_id = :uid ORDER BY created_at ASC`,
      { uid },
    );
    return (rows as DbRow[]).map(rowToDomain);
  }

  async getActive(uid: string): Promise<RemoteLibraryRow | null> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      `SELECT ${COLS} FROM remote_libraries
       WHERE user_id = :uid AND is_active = 1
       LIMIT 1`,
      { uid },
    );
    const list = rows as DbRow[];
    return list.length > 0 ? rowToDomain(list[0]!) : null;
  }

  async create(
    uid: string,
    input: NewRemoteLibrary,
  ): Promise<RemoteLibraryRow> {
    await ensureSchema(this.#pool);
    const id = randomUUID();
    const conn = await this.#pool.getConnection();
    try {
      await conn.beginTransaction();
      const [countRows] = await conn.execute(
        "SELECT COUNT(*) AS n FROM remote_libraries WHERE user_id = :uid",
        { uid },
      );
      const n = Number((countRows as Array<{ n: number | bigint }>)[0]?.n ?? 0);
      const isActive = n === 0;
      const createdAt = Date.now();
      await conn.execute(
        `INSERT INTO remote_libraries (${COLS})
         VALUES (:id, :uid, :kind, :name, :baseUrl, :apiKey, :isActive, :createdAt)`,
        {
          id,
          uid,
          kind: input.kind,
          name: input.name,
          baseUrl: input.baseUrl ?? null,
          apiKey: input.apiKey ?? null,
          isActive: isActive ? 1 : 0,
          createdAt,
        },
      );
      await conn.commit();
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
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async update(
    uid: string,
    id: string,
    patch: Partial<NewRemoteLibrary>,
  ): Promise<RemoteLibraryRow | null> {
    await ensureSchema(this.#pool);
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
      // No-op update — return current row.
      const [rows] = await this.#pool.execute(
        `SELECT ${COLS} FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1`,
        params,
      );
      const list = rows as DbRow[];
      return list.length > 0 ? rowToDomain(list[0]!) : null;
    }
    const [result] = await this.#pool.execute(
      `UPDATE remote_libraries SET ${fields.join(", ")} WHERE user_id = :uid AND id = :id`,
      params,
    );
    const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
    if (affected === 0) return null;
    const [rows] = await this.#pool.execute(
      `SELECT ${COLS} FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1`,
      params,
    );
    const list = rows as DbRow[];
    return list.length > 0 ? rowToDomain(list[0]!) : null;
  }

  async delete(uid: string, id: string): Promise<boolean> {
    await ensureSchema(this.#pool);
    const conn = await this.#pool.getConnection();
    try {
      await conn.beginTransaction();
      const [wasActiveRows] = await conn.execute(
        `SELECT is_active FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1`,
        { uid, id },
      );
      const wasActive =
        Boolean(
          (wasActiveRows as Array<{ is_active: number | boolean }>)[0]
            ?.is_active,
        );
      const [result] = await conn.execute(
        "DELETE FROM remote_libraries WHERE user_id = :uid AND id = :id",
        { uid, id },
      );
      const affected = (result as { affectedRows?: number }).affectedRows ?? 0;
      if (affected === 0) {
        await conn.rollback();
        return false;
      }
      if (wasActive) {
        await conn.execute(
          `UPDATE remote_libraries SET is_active = 1
           WHERE user_id = :uid
             AND id = (
               SELECT id FROM (
                 SELECT id FROM remote_libraries
                 WHERE user_id = :uid
                 ORDER BY created_at ASC
                 LIMIT 1
               ) AS t
             )`,
          { uid },
        );
      }
      await conn.commit();
      return true;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async setActive(uid: string, id: string): Promise<boolean> {
    await ensureSchema(this.#pool);
    const conn = await this.#pool.getConnection();
    try {
      await conn.beginTransaction();
      const [exists] = await conn.execute(
        "SELECT id FROM remote_libraries WHERE user_id = :uid AND id = :id LIMIT 1",
        { uid, id },
      );
      if ((exists as Array<unknown>).length === 0) {
        await conn.rollback();
        return false;
      }
      await conn.execute(
        "UPDATE remote_libraries SET is_active = 0 WHERE user_id = :uid",
        { uid },
      );
      await conn.execute(
        "UPDATE remote_libraries SET is_active = 1 WHERE user_id = :uid AND id = :id",
        { uid, id },
      );
      await conn.commit();
      return true;
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }
}
