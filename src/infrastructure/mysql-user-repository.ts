import type {
  UserRecord,
  UserRepository,
} from "../domain/ports/user-repository.ts";
import { ensureSchema, type Db } from "./mysql-pool.ts";

/** Pure row → UserRecord mapper (unit-tested without a DB). */
export function rowToUser(row: {
  id: string;
  username: string;
  pw_salt: string;
  pw_hash: string;
  totp_secret: string | null;
  totp_enabled: number | boolean;
  recovery_codes: unknown;
  plan: string;
  created_at: number | bigint;
}): UserRecord {
  let codes: string[] | null = null;
  let rc = row.recovery_codes;
  if (typeof rc === "string") {
    try {
      rc = JSON.parse(rc);
    } catch {
      rc = null;
    }
  }
  if (Array.isArray(rc)) {
    codes = rc.filter((x): x is string => typeof x === "string");
  }
  return {
    id: row.id,
    username: row.username,
    pwSalt: row.pw_salt,
    pwHash: row.pw_hash,
    totpSecret: row.totp_secret ?? null,
    totpEnabled: Boolean(row.totp_enabled),
    recoveryCodes: codes,
    plan: row.plan,
    createdAt: Number(row.created_at),
  };
}

const COLS =
  "id, username, pw_salt, pw_hash, totp_secret, totp_enabled, recovery_codes, plan, created_at";

/** MySQL-backed user store — the store for STORAGE_DRIVER=mysql. */
export class MysqlUserRepository implements UserRepository {
  readonly #pool: Db;

  constructor(pool: Db) {
    this.#pool = pool;
  }

  async #one(where: string, value: string): Promise<UserRecord | null> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      `SELECT ${COLS} FROM users WHERE ${where} = :v LIMIT 1`,
      { v: value },
    );
    const list = rows as Array<Parameters<typeof rowToUser>[0]>;
    return list.length > 0 ? rowToUser(list[0]!) : null;
  }

  findById(id: string): Promise<UserRecord | null> {
    return this.#one("id", id);
  }

  findByUsername(username: string): Promise<UserRecord | null> {
    return this.#one("username", username);
  }

  async create(u: UserRecord): Promise<void> {
    await ensureSchema(this.#pool);
    await this.#pool.execute(
      `INSERT INTO users (${COLS})
       VALUES (:id, :username, :pwSalt, :pwHash, :totpSecret,
               :totpEnabled, :recoveryCodes, :plan, :createdAt)`,
      this.#params(u),
    );
  }

  async update(u: UserRecord): Promise<void> {
    await ensureSchema(this.#pool);
    await this.#pool.execute(
      `UPDATE users SET
         pw_salt=:pwSalt, pw_hash=:pwHash, totp_secret=:totpSecret,
         totp_enabled=:totpEnabled, recovery_codes=:recoveryCodes
       WHERE id=:id`,
      this.#params(u),
    );
  }

  async count(): Promise<number> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.query(
      "SELECT COUNT(*) AS n FROM users",
    );
    return Number((rows as Array<{ n: number | bigint }>)[0]?.n ?? 0);
  }

  async allIds(): Promise<string[]> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.query("SELECT id FROM users");
    return (rows as Array<{ id: string }>).map((r) => r.id);
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
      plan: u.plan,
      createdAt: u.createdAt,
    };
  }
}
