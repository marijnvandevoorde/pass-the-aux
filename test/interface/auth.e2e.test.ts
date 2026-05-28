import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/main.ts";
import type { Config } from "../../src/infrastructure/config.ts";
import { totp } from "../../src/domain/security.ts";

async function startAuthServer(registrationOpen = true): Promise<{
  base: string;
  close: () => Promise<void>;
}> {
  const musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), "djm-auth-"));
  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    musicDir,
    bodyLimitBytes: 1_000_000,
    publicBaseUrl: "http://localhost:5174",
    storageDriver: "sqlite",
    db: { host: "", port: 0, user: "", password: "", database: "" },
    sqlitePath: path.join(musicDir, ".pass-the-aux.sqlite"),
    sessionSecret: "this-is-a-strong-enough-secret-key",
    coverLookup: false,
    registrationOpen,
    beatAnalyzer: "local",
    passTheBeatUrl: "http://pass-the-beat:8000",
  };
  const server = createApp(config);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("auth gate: register → confirm → access; public stays open", async () => {
  const s = await startAuthServer();
  try {
    // Unauthenticated: SPA redirects, API is 401, crowd is public.
    const spa = await fetch(`${s.base}/`, { redirect: "manual" });
    assert.equal(spa.status, 302);
    assert.equal(spa.headers.get("location"), "/login");

    assert.equal((await fetch(`${s.base}/api/crates`)).status, 401);
    assert.equal((await fetch(`${s.base}/crowd?s=x`)).status, 200);
    assert.equal((await fetch(`${s.base}/login`)).status, 200);

    // Register.
    const reg = await fetch(`${s.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dj_test", password: "supersecret" }),
    });
    assert.equal(reg.status, 200);
    const { secret, recoveryCodes } = (await reg.json()) as {
      secret: string;
      recoveryCodes: string[];
    };
    assert.equal(recoveryCodes.length, 10);

    // Confirm 2FA with a real code → sets the session cookie.
    const conf = await fetch(`${s.base}/api/auth/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "dj_test",
        password: "supersecret",
        code: totp(secret),
      }),
    });
    assert.equal(conf.status, 200);
    const cookie = (conf.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(cookie, /^dj_sess=/);

    // Authenticated calls now pass.
    const me = await fetch(`${s.base}/api/auth/me`, {
      headers: { cookie },
    });
    assert.deepEqual(await me.json(), {
      authenticated: true,
      username: "dj_test",
    });
    const crates = await fetch(`${s.base}/api/crates`, {
      headers: { cookie },
    });
    assert.equal(crates.status, 200);

    // Wrong password is rejected at login.
    const bad = await fetch(`${s.base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "dj_test",
        password: "nope",
        code: totp(secret),
      }),
    });
    assert.equal(bad.status, 401);

    // Logout clears the cookie.
    const out = await fetch(`${s.base}/logout`, { redirect: "manual" });
    assert.equal(out.status, 302);
    assert.match(out.headers.get("set-cookie") ?? "", /dj_sess=;/);
  } finally {
    await s.close();
  }
});

test("registration closed (default): status=false, register 403s", async () => {
  const s = await startAuthServer(false);
  try {
    // Public probe the login page uses to hide the link.
    const st = await fetch(`${s.base}/api/auth/status`);
    assert.equal(st.status, 200);
    assert.deepEqual(await st.json(), { registrationOpen: false });

    // The endpoint refuses to create an account.
    const reg = await fetch(`${s.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "intruder", password: "longenough" }),
    });
    assert.equal(reg.status, 403);

    // And no account was created — login for it can't exist.
    const me = await fetch(`${s.base}/api/auth/me`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), { authenticated: false });
  } finally {
    await s.close();
  }
});

test("registration open: status=true, register works", async () => {
  const s = await startAuthServer(true);
  try {
    const st = await fetch(`${s.base}/api/auth/status`);
    assert.deepEqual(await st.json(), { registrationOpen: true });
    const reg = await fetch(`${s.base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "dj_ok", password: "longenough" }),
    });
    assert.equal(reg.status, 200);
  } finally {
    await s.close();
  }
});
