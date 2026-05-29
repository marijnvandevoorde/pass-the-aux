import fsp from "node:fs/promises";
import path from "node:path";
import { parseId3 } from "./id3.ts";
import { parseOggVorbis, parseOggOpus, parseFlac } from "./vorbis.ts";
import { safeResolve } from "./path-safety.ts";
import type {
  CoverArt,
  TagReader,
  TrackTags,
} from "../domain/ports/tag-reader.ts";

const TEXT_CAP = 2_000_000;
const COVER_CAP = 8_000_000;

type Format = "mp3" | "ogg" | "opus" | "flac" | "unsupported";

function detectFormat(id: string): Format {
  switch (path.extname(id).toLowerCase()) {
    case ".mp3":
      return "mp3";
    case ".ogg":
      return "ogg";
    case ".opus":
      return "opus";
    case ".flac":
      return "flac";
    default:
      return "unsupported";
  }
}

export class Id3TagReader implements TagReader {
  readonly #musicDir: string;

  constructor(musicDir: string) {
    this.#musicDir = musicDir;
  }

  async #read(id: string, cap: number): Promise<Uint8Array | null> {
    const abs = safeResolve(this.#musicDir, id);
    if (abs === null) return null;
    let fh: fsp.FileHandle | undefined;
    try {
      fh = await fsp.open(abs, "r");
      const stat = await fh.stat();
      const size = Math.min(stat.size, cap);
      const buf = new Uint8Array(size);
      await fh.read(buf, 0, size, 0);
      return buf;
    } catch {
      return null;
    } finally {
      await fh?.close();
    }
  }

  async read(id: string): Promise<TrackTags | null> {
    const fmt = detectFormat(id);
    if (fmt === "unsupported") return null;

    const buf = await this.#read(id, TEXT_CAP);
    if (!buf) return null;

    let tags: { title?: string; artist?: string; bpm?: number; key?: string; picture?: unknown } | null = null;
    if (fmt === "mp3") tags = parseId3(buf);
    else if (fmt === "ogg") tags = parseOggVorbis(buf);
    else if (fmt === "opus") tags = parseOggOpus(buf);
    else if (fmt === "flac") tags = parseFlac(buf);

    if (!tags || (!tags.title && !tags.artist && !tags.bpm && !tags.key)) {
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
    const fmt = detectFormat(id);
    if (fmt === "unsupported") return null;

    const buf = await this.#read(id, COVER_CAP);
    if (!buf) return null;

    let tags: { picture?: { mime: string; data: Uint8Array } } | null = null;
    if (fmt === "mp3") tags = parseId3(buf);
    else if (fmt === "ogg") tags = parseOggVorbis(buf);
    else if (fmt === "opus") tags = parseOggOpus(buf);
    else if (fmt === "flac") tags = parseFlac(buf);

    const pic = tags?.picture;
    return pic && pic.data.byteLength > 0
      ? { mime: pic.mime, data: pic.data }
      : null;
  }
}
