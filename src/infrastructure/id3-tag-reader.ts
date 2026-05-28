import fsp from "node:fs/promises";
import path from "node:path";
import { parseId3 } from "./id3.ts";
import { safeResolve } from "./path-safety.ts";
import type {
  CoverArt,
  TagReader,
  TrackTags,
} from "../domain/ports/tag-reader.ts";

const TEXT_CAP = 2_000_000; // text frames are tiny
const COVER_CAP = 8_000_000; // embedded art can be larger

/** ID3v2-backed tag reader (MP3 only; other formats fall back to file). */
export class Id3TagReader implements TagReader {
  readonly #musicDir: string;

  constructor(musicDir: string) {
    this.#musicDir = musicDir;
  }

  /** Read the ID3v2 tag region (up to `cap` bytes), or null if absent. */
  async #readTag(id: string, cap: number): Promise<Uint8Array | null> {
    if (path.extname(id).toLowerCase() !== ".mp3") return null;
    const abs = safeResolve(this.#musicDir, id);
    if (abs === null) return null;

    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(abs, "r");
      const head = new Uint8Array(10);
      await fh.read(head, 0, 10, 0);
      if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) {
        return null; // no ID3v2 tag
      }
      const size =
        ((head[6]! & 0x7f) << 21) |
        ((head[7]! & 0x7f) << 14) |
        ((head[8]! & 0x7f) << 7) |
        (head[9]! & 0x7f);
      const total = Math.min(10 + size, cap);
      const buf = new Uint8Array(total);
      await fh.read(buf, 0, total, 0);
      return buf;
    } catch {
      return null;
    } finally {
      await fh?.close();
    }
  }

  async read(id: string): Promise<TrackTags | null> {
    const buf = await this.#readTag(id, TEXT_CAP);
    const tags = buf && parseId3(buf);
    if (
      !tags ||
      (!tags.title && !tags.artist && !tags.bpm && !tags.key)
    ) {
      return null;
    }
    return {
      title: tags.title,
      artist: tags.artist,
      bpm: tags.bpm,
      key: tags.key,
    };
  }

  async readCover(id: string): Promise<CoverArt | null> {
    const buf = await this.#readTag(id, COVER_CAP);
    const pic = buf && parseId3(buf)?.picture;
    return pic ? { mime: pic.mime, data: pic.data } : null;
  }
}
