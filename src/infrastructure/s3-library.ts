import fsp from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { Track } from "../domain/track.ts";
import { TrackId } from "../domain/track-id.ts";
import { AUDIO_EXTENSIONS, isAudioExtension } from "../domain/audio-formats.ts";
import { NotAudioError, TrackNotFoundError } from "../domain/errors.ts";
import { stripExtension } from "../domain/track-naming.ts";
import type { TrackRepository } from "../domain/ports/track-repository.ts";
import type {
  AudioSource,
  AudioStat,
  ByteRange,
} from "../domain/ports/audio-source.ts";
import type { CoverStore } from "../domain/ports/cover-art.ts";
import type { LibraryWriter } from "../domain/ports/library-writer.ts";
import { contentType } from "./mime.ts";
import { resizeCover } from "./image-resize.ts";
import { sanitiseBase } from "./fs-library-writer.ts";
import type { PrefixReader } from "./id3-tag-reader.ts";
import type { LocalFiles } from "./ffmpeg-audio-analyzer.ts";
import type { S3Bucket } from "./s3-bucket.ts";

/*
 * The music library in an S3-compatible bucket. Object keys mirror the
 * old folder layout: `<uid>/<file>` per account (or `<file>` when auth
 * is off), with the cover sidecar `<base>.jpg` next to the audio. Each
 * adapter here is the bucket twin of an `Fs*` adapter and takes the
 * account's key prefix (`"<uid>/"`, or `""`).
 */

function keyOf(prefix: string, id: string): string {
  return prefix + new TrackId(id).value;
}

function hidden(rel: string): boolean {
  return rel.split("/").some((seg) => seg.startsWith("."));
}

export class S3TrackRepository implements TrackRepository {
  readonly #bucket: S3Bucket;
  readonly #prefix: string;

  constructor(bucket: S3Bucket, prefix: string) {
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  async list(): Promise<Track[]> {
    const out: Track[] = [];
    for (const o of await this.#bucket.list(this.#prefix)) {
      const rel = o.key.slice(this.#prefix.length);
      if (rel === "" || hidden(rel)) continue;
      const ext = path.posix.extname(rel).toLowerCase();
      if (!isAudioExtension(ext)) continue;
      out.push(toTrack(rel, ext, o.size, o.lastModified));
    }
    return out;
  }

  async findById(id: string): Promise<Track | null> {
    let key: string;
    try {
      key = keyOf(this.#prefix, id);
    } catch {
      return null;
    }
    const ext = path.posix.extname(key).toLowerCase();
    if (!isAudioExtension(ext)) return null;
    const o = await this.#bucket.head(key);
    return o ? toTrack(key.slice(this.#prefix.length), ext, o.size, o.lastModified) : null;
  }
}

function toTrack(rel: string, ext: string, size: number, mtime: number): Track {
  const dir = path.posix.dirname(rel);
  return new Track({
    id: rel,
    name: path.posix.basename(rel),
    dir: dir === "." ? "" : dir,
    ext,
    size,
    mtime,
    bpm: null,
  });
}

/** Streams audio out of the bucket (ranged GETs, so seeking works). */
export class S3AudioSource implements AudioSource {
  readonly #bucket: S3Bucket;
  readonly #prefix: string;

  constructor(bucket: S3Bucket, prefix: string) {
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  async stat(id: string): Promise<AudioStat> {
    const key = keyOf(this.#prefix, id); // throws ForbiddenPathError
    const ext = path.posix.extname(key).toLowerCase();
    if (!isAudioExtension(ext)) throw new NotAudioError(id);
    const o = await this.#bucket.head(key);
    if (o === null) throw new TrackNotFoundError(id);
    return { id, size: o.size, contentType: contentType(ext) };
  }

  createStream(id: string, range?: ByteRange | null): Readable {
    const out = new PassThrough();
    const key = keyOf(this.#prefix, id);
    void (async () => {
      const res = await this.#bucket.get(key, range ?? null);
      if (res === null || res.body === null) {
        throw new TrackNotFoundError(id);
      }
      const body = Readable.fromWeb(res.body as never);
      // Client went away → stop pulling from the bucket.
      out.on("close", () => body.destroy());
      body.on("error", (e) => out.destroy(e));
      body.pipe(out);
    })().catch((e: unknown) => out.destroy(e as Error));
    return out;
  }
}

/** `<base>.jpg` cover sidecars stored next to the audio objects. */
export class S3CoverStore implements CoverStore {
  readonly #bucket: S3Bucket;
  readonly #prefix: string;

  constructor(bucket: S3Bucket, prefix: string) {
    this.#bucket = bucket;
    this.#prefix = prefix;
  }

  #key(trackId: string): string | null {
    try {
      return keyOf(this.#prefix, `${stripExtension(trackId)}.jpg`);
    } catch {
      return null;
    }
  }

  async has(trackId: string): Promise<boolean> {
    const k = this.#key(trackId);
    return k !== null && (await this.#bucket.head(k)) !== null;
  }

  async read(trackId: string): Promise<Uint8Array | null> {
    const k = this.#key(trackId);
    return k === null ? null : this.#bucket.getBytes(k);
  }

  async write(trackId: string, bytes: Uint8Array): Promise<void> {
    const k = this.#key(trackId);
    if (k === null) return;
    const small = await resizeCover(bytes);
    await this.#bucket.put(k, small, { contentType: "image/jpeg" });
  }
}

/** Imports a downloaded track into the bucket. The download is spooled
 *  to a temp file first: S3 needs the length up front, and a failed
 *  download must never leave a partial object in the library. */
export class S3LibraryWriter implements LibraryWriter {
  readonly #bucket: S3Bucket;
  readonly #prefix: string;
  readonly #onWritten: () => void;

  constructor(bucket: S3Bucket, prefix: string, onWritten: () => void = () => {}) {
    this.#bucket = bucket;
    this.#prefix = prefix;
    this.#onWritten = onWritten;
  }

  async write(stream: Readable, desiredBaseName: string, ext: string): Promise<string> {
    const base = sanitiseBase(desiredBaseName);
    const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
    const tmp = path.join(
      os.tmpdir(),
      `pta-import-${Date.now()}-${Math.random().toString(36).slice(2)}.${safeExt}`,
    );
    try {
      await pipeline(stream, createWriteStream(tmp));
      const { size } = await fsp.stat(tmp);
      const id = await this.#freeName(base, safeExt);
      await this.#bucket.put(this.#prefix + id, createReadStream(tmp), {
        size,
        contentType: contentType(`.${safeExt}`),
      });
      this.#onWritten();
      return id;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async existing(desiredBaseName: string): Promise<string | null> {
    const base = sanitiseBase(desiredBaseName);
    for (const ext of AUDIO_EXTENSIONS) {
      const name = new TrackId(`${base}${ext}`).value;
      if (await this.#bucket.head(this.#prefix + name)) return name;
    }
    return null;
  }

  /** First free `base.ext`, then `base (1).ext`, `base (2).ext`… */
  async #freeName(base: string, ext: string): Promise<string> {
    for (let i = 0; i < 1000; i++) {
      const name = new TrackId(i === 0 ? `${base}.${ext}` : `${base} (${i}).${ext}`).value;
      if ((await this.#bucket.head(this.#prefix + name)) === null) return name;
    }
    return new TrackId(`${base} ${Date.now()}.${ext}`).value;
  }
}

/** The first `cap` bytes of an object — what the tag parsers need. */
export function s3PrefixReader(bucket: S3Bucket, prefix: string): PrefixReader {
  return async (id, cap) => {
    try {
      const res = await bucket.get(keyOf(prefix, id), { start: 0, end: cap - 1 });
      return res ? new Uint8Array(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  };
}

/** ffmpeg needs a seekable local file (m4a may keep its index at the
 *  end), so the object is downloaded to a temp file for the duration of
 *  one analysis and deleted afterwards. */
export function s3LocalFiles(bucket: S3Bucket, prefix: string): LocalFiles {
  return {
    async withFile<T>(id: string, fn: (abs: string) => Promise<T>): Promise<T | null> {
      let key: string;
      try {
        key = keyOf(prefix, id);
      } catch {
        return null;
      }
      const res = await bucket.get(key).catch(() => null);
      if (res === null || res.body === null) return null;
      const ext = path.posix.extname(key).toLowerCase().replace(/[^.a-z0-9]/g, "");
      const tmp = path.join(
        os.tmpdir(),
        `pta-analyze-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`,
      );
      try {
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        return await fn(tmp);
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {});
      }
    },
  };
}
