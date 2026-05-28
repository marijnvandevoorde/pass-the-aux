import test from "node:test";
import assert from "node:assert/strict";
import {
  base32Encode,
  base32Decode,
  totp,
  verifyTotp,
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
  generateRecoveryCodes,
  hashRecoveryCodes,
  consumeRecoveryCode,
  generateTotpSecret,
} from "../../src/domain/security.ts";

// RFC 4648 base32 of the RFC 6238 test key.
const RFC_KEY = Buffer.from("12345678901234567890");
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

test("base32 encodes the RFC key and round-trips", () => {
  assert.equal(base32Encode(RFC_KEY), RFC_SECRET);
  assert.deepEqual(base32Decode(RFC_SECRET), RFC_KEY);
  const r = Buffer.from("hello world");
  assert.deepEqual(base32Decode(base32Encode(r)), r);
});

test("TOTP matches RFC 6238 (SHA-1, 6 digits) vectors", () => {
  assert.equal(totp(RFC_SECRET, 59), "287082");
  assert.equal(totp(RFC_SECRET, 1234567890), "005924");
  assert.equal(totp(RFC_SECRET, 2000000000), "279037");
});

test("verifyTotp accepts current/skewed codes, rejects wrong", () => {
  const t = 1234567890;
  assert.equal(verifyTotp(RFC_SECRET, "005924", t), true);
  assert.equal(verifyTotp(RFC_SECRET, totp(RFC_SECRET, t - 30), t), true); // -1 step
  assert.equal(verifyTotp(RFC_SECRET, "000000", t), false);
  assert.equal(verifyTotp(RFC_SECRET, "12345", t), false); // wrong length
  assert.notEqual(generateTotpSecret(), generateTotpSecret());
});

test("password hashing verifies correct and rejects wrong", async () => {
  const { salt, hash } = await hashPassword("correct horse");
  assert.equal(await verifyPassword("correct horse", salt, hash), true);
  assert.equal(await verifyPassword("Correct Horse", salt, hash), false);
});

test("session token: valid, tamper-evident, expiry-checked", () => {
  const secret = "a".repeat(32);
  const tok = signSession(
    { uid: "u1", exp: Math.floor(Date.now() / 1000) + 60 },
    secret,
  );
  assert.equal(verifySession(tok, secret)?.uid, "u1");
  assert.equal(verifySession(tok, "wrong-secret"), null);
  assert.equal(verifySession(tok + "x", secret), null);
  const expired = signSession({ uid: "u1", exp: 1 }, secret);
  assert.equal(verifySession(expired, secret), null);
});

test("recovery codes hash, match once, then are consumed", async () => {
  const codes = generateRecoveryCodes(5);
  assert.equal(codes.length, 5);
  const hashes = await hashRecoveryCodes(codes);
  const remaining = await consumeRecoveryCode(codes[0]!, hashes);
  assert.ok(remaining);
  assert.equal(remaining!.length, 4);
  assert.equal(await consumeRecoveryCode(codes[0]!, remaining!), null);
  assert.equal(await consumeRecoveryCode("NOPE", hashes), null);
});
