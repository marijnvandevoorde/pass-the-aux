import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { safeResolve } from "../../infrastructure/path-safety.ts";
import { contentType } from "../../infrastructure/mime.ts";
import { sendJson } from "./responder.ts";

/** Serves a file from the public directory (path-traversal safe). */
export async function serveStatic(
  res: ServerResponse,
  urlPath: string,
  publicDir: string,
): Promise<void> {
  const rel =
    urlPath === "/" ? "index.html" : decodeURIComponent(urlPath.slice(1));
  const file = safeResolve(publicDir, rel);
  if (file === null) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error("not a file");
    const ext = path.extname(file);
    const headers: Record<string, string | number> = {
      "Content-Type": contentType(ext),
      "Content-Length": stat.size,
    };
    // The browser bundle is dozens of ES modules, but only the entry
    // (app.js) is cache-busted via `?v=`. Its static imports (qr.js, …)
    // would otherwise be served stale from the browser cache after a
    // deploy — a fresh shell running old code. Force revalidation for
    // code assets so a normal reload always picks up the whole bundle.
    if (ext === ".js" || ext === ".mjs" || ext === ".css") {
      headers["Cache-Control"] = "no-cache";
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}

/** Serves an HTML file from the public directory with `{{KEY}}`
 *  placeholders substituted. Always sent as `text/html; charset=utf-8`
 *  with `Cache-Control: no-cache` so a new version is visible on every
 *  reload. Use for the DJ SPA entry where we bake an app-version stamp
 *  into the script URL (cache-busting) and the footer (visibility). */
export async function serveHtmlTemplate(
  res: ServerResponse,
  urlPath: string,
  publicDir: string,
  replacements: Record<string, string>,
): Promise<void> {
  const rel = urlPath === "/" ? "index.html" : urlPath.slice(1);
  const file = safeResolve(publicDir, rel);
  if (file === null) {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  try {
    let body = await fsp.readFile(file, "utf8");
    for (const [k, v] of Object.entries(replacements)) {
      body = body.split(`{{${k}}}`).join(v);
    }
    const buf = Buffer.from(body, "utf8");
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": buf.byteLength,
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch {
    sendJson(res, 404, { error: "not found" });
  }
}
