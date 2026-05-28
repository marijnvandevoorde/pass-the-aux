import test from "node:test";
import assert from "node:assert/strict";
import { AuthService } from "../../src/application/auth-service.ts";
import { totp } from "../../src/domain/security.ts";
import type {
  UserRecord,
  UserRepository,
} from "../../src/domain/ports/user-repository.ts";

class FakeUsers implements UserRepository {
  readonly m = new Map<string, UserRecord>();
  async findById(id: string) {
    return this.m.get(id) ?? null;
  }
  async findByUsername(u: string) {
    for (const r of this.m.values())
      if (r.username.toLowerCase() === u.toLowerCase()) return r;
    return null;
  }
  async create(u: UserRecord) {
    this.m.set(u.id, u);
  }
  async update(u: UserRecord) {
    this.m.set(u.id, u);
  }
  async count() {
    return this.m.size;
  }
  async allIds() {
    return [...this.m.keys()];
  }
}

const SECRET = "x".repeat(32);

test("register validates input and rejects duplicates", async () => {
  const a = new AuthService(new FakeUsers(), SECRET);
  await assert.rejects(() => a.register("ab", "longenough"), /3–32/);
  await assert.rejects(() => a.register("valid", "short"), /8 characters/);
  const e = await a.register("DJ_Marijn", "supersecret");
  assert.equal(e.username, "DJ_Marijn");
  assert.match(e.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(e.recoveryCodes.length, 10);
  await assert.rejects(() => a.register("DJ_Marijn", "supersecret"), /taken/);
});

test("cannot log in until 2FA enrollment is confirmed", async () => {
  const a = new AuthService(new FakeUsers(), SECRET);
  const e = await a.register("deejay", "supersecret");
  await assert.rejects(
    () => a.login("deejay", "supersecret", totp(e.secret)),
    /finish 2FA setup/,
  );
  // wrong first code
  await assert.rejects(
    () => a.confirmTotp("deejay", "supersecret", "000000"),
    /authenticator code/,
  );
  const token = await a.confirmTotp("deejay", "supersecret", totp(e.secret));
  assert.equal((await a.userFromToken(token))?.username, "deejay");
});

test("login: password + TOTP, wrong password/code rejected", async () => {
  const a = new AuthService(new FakeUsers(), SECRET);
  const e = await a.register("deejay", "supersecret");
  await a.confirmTotp("deejay", "supersecret", totp(e.secret));

  const token = await a.login("deejay", "supersecret", totp(e.secret));
  assert.ok(await a.userFromToken(token));
  await assert.rejects(
    () => a.login("deejay", "WRONG", totp(e.secret)),
    /invalid username or password/,
  );
  await assert.rejects(() => a.login("deejay", "supersecret", "000000"), /code/);
});

test("a recovery code logs in once then is spent", async () => {
  const a = new AuthService(new FakeUsers(), SECRET);
  const e = await a.register("deejay", "supersecret");
  await a.confirmTotp("deejay", "supersecret", totp(e.secret));
  const rc = e.recoveryCodes[0]!;
  assert.ok(await a.login("deejay", "supersecret", rc));
  await assert.rejects(() => a.login("deejay", "supersecret", rc), /code/);
});

test("skipMfa allows password-only login; re-skip is idempotent", async () => {
  const a = new AuthService(new FakeUsers(), SECRET);
  const e = await a.register("deejay", "supersecret");

  // Still in pre-enrollment state — skip is allowed.
  const token = await a.skipMfa("deejay", "supersecret");
  assert.ok(await a.userFromToken(token));

  // Now login works with empty code.
  const t2 = await a.login("deejay", "supersecret", "");
  assert.ok(await a.userFromToken(t2));

  // Calling skip again is fine (totpSecret already null).
  const t3 = await a.skipMfa("deejay", "supersecret");
  assert.ok(await a.userFromToken(t3));

  // Cannot skip once MFA is fully enrolled.
  const b = new AuthService(new FakeUsers(), SECRET);
  const eb = await b.register("dj2", "supersecret");
  await b.confirmTotp("dj2", "supersecret", totp(eb.secret));
  await assert.rejects(
    () => b.skipMfa("dj2", "supersecret"),
    /already active/,
  );
  void e; // suppress unused-var warning (secret not used here)
});

test("login with MFA skipped ignores any code value", async () => {
  const a = new AuthService(new FakeUsers(), SECRET);
  await a.register("deejay", "supersecret");
  await a.skipMfa("deejay", "supersecret");

  // Any code value (including garbage) is accepted when MFA is skipped.
  assert.ok(await a.userFromToken(await a.login("deejay", "supersecret", "")));
  assert.ok(await a.userFromToken(await a.login("deejay", "supersecret", "999999")));
});

test("userFromToken rejects junk / unconfigured", async () => {
  const a = new AuthService(new FakeUsers(), SECRET);
  assert.equal(await a.userFromToken(undefined), null);
  assert.equal(await a.userFromToken("not.a.token"), null);
  assert.equal(new AuthService(new FakeUsers(), "short").configured, false);
});
