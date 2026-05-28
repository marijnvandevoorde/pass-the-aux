// auth/2FA primitives. Pure computation over the Node crypto
// platform module only (no project layers, no third-party deps). Kept
// in the domain because it is policy, not I/O: password hashing,
// RFC-6238 TOTP, signed-token format, recovery codes.
import {
  createHmac,
  randomBytes,
  randomUUID,
  scrypt,
  timingSafeEqual,
} from "node:crypto";

// ── ids ──────────────────────────────────────────────────────────
export function newUserId(): string {
  return randomUUID().replace(/-/g, ""); // 32 hex chars, fits CHAR(32)
}

// ── password hashing (scrypt) ────────────────────────────────────
const SCRYPT_KEYLEN = 64;

function scryptAsync(pw: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pw, salt, SCRYPT_KEYLEN, (err, dk) =>
      err ? reject(err) : resolve(dk),
    );
  });
}

export async function hashPassword(
  plain: string,
): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(plain, salt)).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(
  plain: string,
  salt: string,
  hash: string,
): Promise<boolean> {
  const expected = Buffer.from(hash, "hex");
  const actual = await scryptAsync(plain, salt);
  return (
    expected.length === actual.length && timingSafeEqual(expected, actual)
  );
}

// ── base32 (RFC 4648, no padding — what authenticators expect) ────
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ───────────────────────
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  // counter is < 2^53; write as two 32-bit halves.
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const mac = createHmac("sha1", secret).update(buf).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);
  return (bin % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/** Code for a given base32 secret at `timeSec` (default: now). */
export function totp(
  secretBase32: string,
  timeSec: number = Date.now() / 1000,
): string {
  return hotp(
    base32Decode(secretBase32),
    Math.floor(timeSec / TOTP_PERIOD),
  );
}

/** Constant-ish verify across a ±`window` step skew (clock drift). */
export function verifyTotp(
  secretBase32: string,
  code: string,
  timeSec: number = Date.now() / 1000,
  window = 1,
): boolean {
  const clean = code.replace(/\D/g, "");
  if (clean.length !== TOTP_DIGITS) return false;
  const secret = base32Decode(secretBase32);
  const base = Math.floor(timeSec / TOTP_PERIOD);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, base + w) === clean) return true;
  }
  return false;
}

/** otpauth:// URI an authenticator app scans (issuer + account). */
export function otpauthUri(
  issuer: string,
  account: string,
  secretBase32: string,
): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}

// ── recovery codes ───────────────────────────────────────────────
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () =>
    randomBytes(5).toString("hex").toUpperCase(),
  );
}

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(
    codes.map(async (c) => {
      const dk = await scryptAsync(c, "recovery");
      return dk.toString("hex");
    }),
  );
}

/** If `code` matches one of the stored hashes, returns the remaining
 *  hashes (the matched one consumed); otherwise null. */
export async function consumeRecoveryCode(
  code: string,
  hashes: string[],
): Promise<string[] | null> {
  const dk = (await scryptAsync(code.trim().toUpperCase(), "recovery"))
    .toString("hex");
  const idx = hashes.indexOf(dk);
  if (idx === -1) return null;
  return hashes.filter((_, i) => i !== idx);
}

// ── signed session token (HMAC-SHA256, no deps) ──────────────────
interface SessionClaims {
  uid: string;
  exp: number; // epoch seconds
}

export function signSession(
  claims: SessionClaims,
  secret: string,
): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifySession(
  token: string,
  secret: string,
  nowSec: number = Date.now() / 1000,
): SessionClaims | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac("sha256", secret)
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as SessionClaims;
    if (
      typeof claims.uid !== "string" ||
      typeof claims.exp !== "number" ||
      claims.exp < nowSec
    ) {
      return null;
    }
    return claims;
  } catch {
    return null;
  }
}
