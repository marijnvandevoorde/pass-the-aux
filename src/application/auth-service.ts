import { InvalidRequestError, UnauthorizedError } from "../domain/errors.ts";
import {
  FREE_PLAN,
  type UserRecord,
  type UserRepository,
} from "../domain/ports/user-repository.ts";
import {
  consumeRecoveryCode,
  generateRecoveryCodes,
  generateTotpSecret,
  hashPassword,
  hashRecoveryCodes,
  newUserId,
  otpauthUri,
  signSession,
  verifyPassword,
  verifySession,
  verifyTotp,
} from "../domain/security.ts";

const ISSUER = "Pass the Aux";
const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;

export interface Enrollment {
  username: string;
  otpauthUri: string;
  secret: string;
  recoveryCodes: string[]; // shown once, at registration
}

/** Registration / login / 2FA orchestration. Depends only on
 *  the UserRepository port and the domain security primitives. */
export class AuthService {
  readonly #users: UserRepository;
  readonly #secret: string;

  constructor(users: UserRepository, sessionSecret: string) {
    this.#users = users;
    this.#secret = sessionSecret;
  }

  get configured(): boolean {
    return this.#secret.length >= 16;
  }

  /** Create the account (2FA pending). Returns the authenticator
   *  provisioning data — the only time the secret/codes are exposed. */
  async register(username: string, password: string): Promise<Enrollment> {
    const name = String(username ?? "").trim();
    if (!USERNAME_RE.test(name)) {
      throw new InvalidRequestError(
        "username must be 3–32 chars: letters, digits, . _ -",
      );
    }
    if (typeof password !== "string" || password.length < 8) {
      throw new InvalidRequestError("password must be at least 8 characters");
    }
    if (await this.#users.findByUsername(name)) {
      throw new InvalidRequestError("that username is taken");
    }
    const { salt, hash } = await hashPassword(password);
    const secret = generateTotpSecret();
    const recovery = generateRecoveryCodes();
    const user: UserRecord = {
      id: newUserId(),
      username: name,
      pwSalt: salt,
      pwHash: hash,
      totpSecret: secret,
      totpEnabled: false,
      recoveryCodes: await hashRecoveryCodes(recovery),
      plan: FREE_PLAN,
      createdAt: Date.now(),
    };
    await this.#users.create(user);
    return {
      username: name,
      otpauthUri: otpauthUri(ISSUER, name, secret),
      secret,
      recoveryCodes: recovery,
    };
  }

  /** Finish enrollment: verify the first TOTP code, enable 2FA, and
   *  return a session token (auto-login). */
  async confirmTotp(
    username: string,
    password: string,
    code: string,
  ): Promise<string> {
    const user = await this.#authUser(username, password);
    if (!user.totpSecret || !verifyTotp(user.totpSecret, code)) {
      throw new UnauthorizedError("incorrect authenticator code");
    }
    if (!user.totpEnabled) {
      await this.#users.update({ ...user, totpEnabled: true });
    }
    return this.#issue(user.id);
  }

  /** Password + (TOTP code | recovery code) → session token. */
  async login(
    username: string,
    password: string,
    code: string,
  ): Promise<string> {
    const user = await this.#authUser(username, password);
    if (!user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedError("finish 2FA setup before logging in");
    }
    if (verifyTotp(user.totpSecret, code)) return this.#issue(user.id);

    // Fall back to a one-time recovery code.
    const remaining = await consumeRecoveryCode(
      code,
      user.recoveryCodes ?? [],
    );
    if (remaining) {
      await this.#users.update({ ...user, recoveryCodes: remaining });
      return this.#issue(user.id);
    }
    throw new UnauthorizedError("incorrect code");
  }

  /** Resolve a session-cookie token to the current user, or null. */
  async userFromToken(token: string | undefined): Promise<UserRecord | null> {
    if (!token) return null;
    const claims = verifySession(token, this.#secret);
    if (!claims) return null;
    return this.#users.findById(claims.uid);
  }

  async hasAnyUser(): Promise<boolean> {
    return (await this.#users.count()) > 0;
  }

  async #authUser(username: string, password: string): Promise<UserRecord> {
    const user = await this.#users.findByUsername(
      String(username ?? "").trim(),
    );
    if (
      !user ||
      !(await verifyPassword(String(password ?? ""), user.pwSalt, user.pwHash))
    ) {
      throw new UnauthorizedError("invalid username or password");
    }
    return user;
  }

  #issue(uid: string): string {
    return signSession(
      { uid, exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC },
      this.#secret,
    );
  }
}
