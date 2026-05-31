/**
 * E2E harness: spawns the real server against the seeded fixtures DB
 * (auth-disabled), launches Playwright Chromium, and provides a tiny
 * test registry + assertions. Specs import { test, ... } and register
 * cases; run.mjs drives them against one shared server.
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { seed, DB_PATH } from "./seed.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, "../..");
const PORT = Number(process.env.E2E_PORT ?? 5188);
export const BASE_URL = `http://localhost:${PORT}`;

// ── Test registry ──
export const registry = [];
/** Register an E2E case. `fn` receives a context: { page, request, browser }. */
export function test(name, fn) {
  registry.push({ name, fn });
}
export { assert };

// ── Server lifecycle ──
export async function startServer() {
  seed(); // fresh deterministic DB
  const child = spawn("node", ["server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ENV_FILE: "/dev/null", // ignore repo .env → no SESSION_SECRET → auth off
      HOST: "127.0.0.1",
      PORT: String(PORT),
      MUSIC_DIR: join(DIR, "fixtures", "music"),
      SQLITE_PATH: DB_PATH,
      PUBLIC_BASE_URL: BASE_URL,
      STORAGE_DRIVER: "sqlite",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  child.stderr.on("data", (d) => { log += d; });

  // wait until it answers
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE_URL}/api/version`);
      if (r.ok) return { child, log: () => log };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill("SIGKILL");
  throw new Error("server did not start:\n" + log);
}

export async function stopServer(server) {
  if (!server) return;
  server.child.kill("SIGKILL");
}

// ── Browser ──
export async function launchBrowser() {
  return chromium.launch({ headless: true });
}

/** Reset a session created by a prior mobile-dj page so each spec is
 *  isolated (the DJ page persists its session id in localStorage). */
export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 800 };
export const LANDSCAPE = { width: 844, height: 390 };
