import fsp from "node:fs/promises";
import type { CoverStore } from "../domain/ports/cover-art.ts";
import { stripExtension } from "../domain/track-naming.ts";
import { safeResolve } from "./path-safety.ts";
import { resizeCover } from "./image-resize.ts";

/** Stores a cover JPG next to the mp3 (`<base>.jpg`), inside the
 *  user's music dir. Path-safe; missing/oversize → null. */
export class FsCoverStore implements CoverStore {
  readonly #musicDir: string;

  constructor(musicDir: string) {
    this.#musicDir = musicDir;
  }

  #path(trackId: string): string | null {
    return safeResolve(this.#musicDir, `${stripExtension(trackId)}.jpg`);
  }

  async has(trackId: string): Promise<boolean> {
    const p = this.#path(trackId);
    if (p === null) return false;
    try {
      await fsp.access(p);
      return true;
    } catch {
      return false;
    }
  }

  async read(trackId: string): Promise<Uint8Array | null> {
    const p = this.#path(trackId);
    if (p === null) return null;
    try {
      return new Uint8Array(await fsp.readFile(p));
    } catch {
      return null;
    }
  }

  async write(trackId: string, bytes: Uint8Array): Promise<void> {
    const p = this.#path(trackId);
    if (p === null) return;
    // Always shrink to a thumbnail before writing — embedded ID3 art
    // can be a multi-hundred-KB full-res scan; the UI shows it tiny.
    const small = await resizeCover(bytes);
    await fsp.mkdir(this.#musicDir, { recursive: true });
    await fsp.writeFile(p, small);
  }
}
