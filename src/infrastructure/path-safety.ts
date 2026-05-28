import path from "node:path";

/**
 * Resolves `relPath` under `baseDir` and returns the absolute path only if
 * it stays inside `baseDir`; otherwise `null`. Defence-in-depth against
 * path traversal, complementing the `TrackId` invariant.
 */
export function safeResolve(baseDir: string, relPath: string): string | null {
  const resolved = path.resolve(baseDir, "." + path.sep + relPath);
  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    return null;
  }
  return resolved;
}
