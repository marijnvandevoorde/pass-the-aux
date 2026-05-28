/** A registered DJ account. Secrets are stored hashed; the
 *  TOTP secret is kept as base32 (enrollment needs it back). */
export interface UserRecord {
  id: string;
  username: string;
  pwSalt: string;
  pwHash: string;
  totpSecret: string | null;
  totpEnabled: boolean;
  /** scrypt hashes of one-time recovery codes (consumed on use). */
  recoveryCodes: string[] | null;
  createdAt: number;
}

/** Persistence for user accounts. One adapter per STORAGE_DRIVER. */
export interface UserRepository {
  findByUsername(username: string): Promise<UserRecord | null>;
  findById(id: string): Promise<UserRecord | null>;
  create(user: UserRecord): Promise<void>;
  update(user: UserRecord): Promise<void>;
  count(): Promise<number>;
  /** All user ids (for the background library watcher to sweep). */
  allIds(): Promise<string[]>;
}
