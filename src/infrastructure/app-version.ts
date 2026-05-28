import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * Stamp the running build with a version string. Resolved once at boot
 * so every HTML response carries the same value until the process is
 * restarted. Priority:
 *
 *   1. `APP_VERSION` env var (the Dockerfile bakes this in via a build
 *      arg, so prod images carry the git SHA they were built from).
 *   2. `git rev-parse --short HEAD` in the working tree (dev runs).
 *   3. `package.json` version + boot timestamp (a Docker image with no
 *      `.git` and no APP_VERSION arg still gets a unique stamp on each
 *      container start, so a hard refresh is visibly different).
 */
function compute(): string {
  const env = process.env["APP_VERSION"]?.trim();
  if (env) return env;

  try {
    const sha = execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    // not a git checkout (e.g. Docker image without .git) — fall through
  }

  let pkgVersion = "dev";
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(here, "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    if (pkg.version) pkgVersion = pkg.version;
  } catch {
    // ignore; fall through to "dev"
  }
  // Stamp to the minute so a restart shows up on the page without
  // adding visual noise per second.
  const t = new Date().toISOString().slice(0, 16).replace("T", " ");
  return `${pkgVersion}+${t}`;
}

export const APP_VERSION = compute();
