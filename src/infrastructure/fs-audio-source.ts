import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { TrackId } from "../domain/track-id.ts";
import { isAudioExtension } from "../domain/audio-formats.ts";
import {
  ForbiddenPathError,
  NotAudioError,
  TrackNotFoundError,
} from "../domain/errors.ts";
import { contentType } from "./mime.ts";
import { safeResolve } from "./path-safety.ts";
import type {
  AudioSource,
  AudioStat,
  ByteRange,
} from "../domain/ports/audio-source.ts";
import type { Readable } from "node:stream";

/** Streams audio bytes from the filesystem. */
export class FsAudioSource implements AudioSource {
  readonly #musicDir: string;

  constructor(musicDir: string) {
    this.#musicDir = musicDir;
  }

  #resolve(id: string): string {
    const abs = safeResolve(this.#musicDir, new TrackId(id).value);
    if (abs === null) throw new ForbiddenPathError(id);
    return abs;
  }

  async stat(id: string): Promise<AudioStat> {
    const abs = this.#resolve(id);
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      throw new TrackNotFoundError(id);
    }
    if (!stat.isFile()) throw new TrackNotFoundError(id);
    const ext = path.extname(abs).toLowerCase();
    if (!isAudioExtension(ext)) throw new NotAudioError(id);
    return { id, size: stat.size, contentType: contentType(ext) };
  }

  createStream(id: string, range?: ByteRange | null): Readable {
    const abs = this.#resolve(id);
    return range
      ? fs.createReadStream(abs, { start: range.start, end: range.end })
      : fs.createReadStream(abs);
  }
}
