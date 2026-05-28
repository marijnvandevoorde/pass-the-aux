import fsp from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { TrackId } from "../domain/track-id.ts";
import { ForbiddenPathError } from "../domain/errors.ts";
import { safeResolve } from "./path-safety.ts";
import { AUDIO_EXTENSIONS } from "../domain/audio-formats.ts";
import type { Readable } from "node:stream";
import type { LibraryWriter } from "../domain/ports/library-writer.ts";

// Path separators + filesystem-illegal / control chars. Spaces, hyphens
// and parens are kept so "Artist - Title.flac" survives intact.
const ILLEGAL = /[\\/?%*:|"<>\x00-\x1f]/g;

function sanitiseBase(raw: string): string {
  const cleaned = raw
    .replace(ILLEGAL, "_")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+/, "") // no leading dots (hidden / traversal) or space
    .slice(0, 120)
    .replace(/[.\s]+$/, "")
    .trim();
  return cleaned === "" ? "track" : cleaned;
}

/** Streams a download into MUSIC_DIR via a temp file + atomic rename. */
export class FsLibraryWriter implements LibraryWriter {
  readonly #musicDir: string;

  constructor(musicDir: string) {
    this.#musicDir = musicDir;
  }

  async write(
    stream: Readable,
    desiredBaseName: string,
    ext: string,
  ): Promise<string> {
    const base = sanitiseBase(desiredBaseName);
    const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    await fsp.mkdir(this.#musicDir, { recursive: true });

    const id = await this.#freeName(base, safeExt);
    // Defence in depth: a valid library id that resolves inside MUSIC_DIR.
    const checked = new TrackId(id).value;
    const abs = safeResolve(this.#musicDir, checked);
    if (abs === null) throw new ForbiddenPathError(id);

    const tmp = path.join(
      this.#musicDir,
      `.import-${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`,
    );
    try {
      await pipeline(stream, createWriteStream(tmp));
      await fsp.rename(tmp, abs);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
    return checked;
  }

  /** an already-present file for this base (any audio ext), so
   *  a redundant remote download can be skipped. */
  async existing(desiredBaseName: string): Promise<string | null> {
    const base = sanitiseBase(desiredBaseName);
    for (const ext of AUDIO_EXTENSIONS) {
      const name = `${base}${ext}`;
      const abs = safeResolve(this.#musicDir, name);
      if (abs === null) continue;
      try {
        await fsp.access(abs);
        return new TrackId(name).value;
      } catch {
        /* not this ext */
      }
    }
    return null;
  }

  /** First non-colliding `base.ext`, then `base (1).ext`, `base (2).ext`… */
  async #freeName(base: string, ext: string): Promise<string> {
    for (let i = 0; i < 1000; i++) {
      const name = i === 0 ? `${base}.${ext}` : `${base} (${i}).${ext}`;
      const abs = safeResolve(this.#musicDir, name);
      if (abs === null) continue;
      try {
        await fsp.access(abs);
      } catch {
        return name; // does not exist yet — free
      }
    }
    return `${base} ${Date.now()}.${ext}`;
  }
}
