/**
 * E2E runner. Seeds a deterministic library, starts the real server
 * (auth-disabled) against it, then runs every registered spec in its own
 * isolated browser context. Exits non-zero if any case fails.
 *
 *   npm run test:e2e
 */
import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, stopServer, launchBrowser, registry, BASE_URL } from "./harness.mjs";

// Auto-discover and import every *.spec.mjs (each registers its cases).
const DIR = dirname(fileURLToPath(import.meta.url));
for (const f of readdirSync(DIR).filter((f) => f.endsWith(".spec.mjs")).sort()) {
  await import(`./${f}`);
}

const server = await startServer();
const browser = await launchBrowser();

let pass = 0;
const failures = [];
console.log(`\nE2E — ${registry.length} cases @ ${BASE_URL}\n`);

for (const { name, fn } of registry) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  try {
    await fn({ page, context: ctx });
    if (pageErrors.length) throw new Error("page error: " + pageErrors.join(" | "));
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${(e && e.message) || e}`);
    failures.push(name);
  } finally {
    await ctx.close();
  }
}

await browser.close();
await stopServer(server);

console.log(`\n${pass} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
