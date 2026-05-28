import type {
  UserRecord,
  UserRepository,
} from "../domain/ports/user-repository.ts";
import { ensureSchema, type Db } from "./sqlite-pool.ts";

interface DbRow {
  id: string;
  username: string;
  pw_salt: string;
  pw_hash: string;
  totp_secret: string | null;
  totp_enabled: number;
  recovery_codes: string | null;
  created_at: number;
}

function rowToUser(row: DbRow): UserRecord {
  let codes: string[] | null = null;
  if (row.recovery_codes !== null) {
    try {
      const parsed = JSON.parse(row.recovery_codes);
      if (Array.isArray(parsed)) {
        codes = parsed.filter((x): x is string => typeof x === "string");
      }
    } catch {
      codes = null;
    }
  }
  return {
    id: row.id,
    username: row.username,
    pwSalt: row.pw_salt,
    pwHash: row.pw_hash,
    totpSecret: row.totp_secret ?? null,
    totpEnabled: Boolean(row.totp_enabled),
    recoveryCodes: codes,
    createdAt: Number(row.created_at),
  };
}

const COLS =
  "id, username, pw_salt, pw_hash, totp_secret, totp_enabled, recovery_codes, created_at";

/** SQLite-backed user store. */
export class SqliteUserRepository implements UserRepository {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  #one(where: string, value: string): UserRecord | null {
    ensureSchema(this.#db);
    const row = this.#db
      .prepare(`SELECT ${COLS} FROM users WHERE ${where} = :v LIMIT 1`)
      .get({ v: value }) as unknown as DbRow | undefined;
    return row ? rowToUser(row) : null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.#one("id", id);
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    return this.#one("username", username);
  }

  async create(u: UserRecord): Promise<void> {
    ensureSchema(this.#db);
    this.#db
      .prepare(
        `INSERT INTO users (${COLS})
         VALUES (:id, :username, :pwSalt, :pwHash, :totpSecret,
                 :totpEnabled, :recoveryCodes, :createdAt)`,
      )
      .run(this.#params(u));
  }

  async update(u: UserRecord): Promise<void> {
    ensureSchema(this.#db);
    // node:sqlite errors on params not referenced by the query, so we
    // bind only the columns the UPDATE actually touches (no username/
    // createdAt — those are set-once at creation).
    this.#db
      .prepare(
        `UPDATE users SET
           pw_salt=:pwSalt, pw_hash=:pwHash, totp_secret=:totpSecret,
           totp_enabled=:totpEnabled, recovery_codes=:recoveryCodes
         WHERE id=:id`,
      )
      .run({
        id: u.id,
        pwSalt: u.pwSalt,
        pwHash: u.pwHash,
        totpSecret: u.totpSecret ?? null,
        totpEnabled: u.totpEnabled ? 1 : 0,
        recoveryCodes:
          u.recoveryCodes === null ? null : JSON.stringify(u.recoveryCodes),
      });
  }

  async count(): Promise<number> {
    ensureSchema(this.#db);
    const row = this.#db.prepare("SELECT COUNT(*) AS n FROM users").get() as
      | { n: number }
      | undefined;
    return Number(row?.n ?? 0);
  }

  async allIds(): Promise<string[]> {
    ensureSchema(this.#db);
    const rows = this.#db.prepare("SELECT id FROM users").all() as unknown as
      Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  #params(u: UserRecord): Record<string, string | number | null> {
    return {
      id: u.id,
      username: u.username,
      pwSalt: u.pwSalt,
      pwHash: u.pwHash,
      totpSecret: u.totpSecret ?? null,
      totpEnabled: u.totpEnabled ? 1 : 0,
      recoveryCodes:
        u.recoveryCodes === null ? null : JSON.stringify(u.recoveryCodes),
      createdAt: u.createdAt,
    };
  }
}
