import fsp from "node:fs/promises";
import path from "node:path";
import { Track } from "../domain/track.ts";
import { isAudioExtension } from "../domain/audio-formats.ts";
import { safeResolve } from "./path-safety.ts";
import type { TrackRepository } from "../domain/ports/track-repository.ts";

/** Filesystem-backed track library: recursively scans a music directory. */
export class FsTrackRepository implements TrackRepository {
  readonly #musicDir: string;

  constructor(musicDir: string) {
    this.#musicDir = musicDir;
  }

  list(): Promise<Track[]> {
    return this.#scan(this.#musicDir);
  }

  async #scan(dir: string): Promise<Track[]> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: Track[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...(await this.#scan(full)));
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!isAudioExtension(ext)) continue;
      const stat = await fsp.stat(full);
      out.push(this.#toTrack(full, ext, stat.size, stat.mtimeMs));
    }
    return out;
  }

  async findById(id: string): Promise<Track | null> {
    const abs = safeResolve(this.#musicDir, id);
    if (abs === null) return null;
    try {
      const stat = await fsp.stat(abs);
      const ext = path.extname(abs).toLowerCase();
      if (!stat.isFile() || !isAudioExtension(ext)) return null;
      return this.#toTrack(abs, ext, stat.size, stat.mtimeMs);
    } catch {
      return null;
    }
  }

  #toTrack(abs: string, ext: string, size: number, mtime: number): Track {
    const rel = path.relative(this.#musicDir, abs);
    const dir = path.dirname(rel);
    return new Track({
      id: rel,
      name: path.basename(abs),
      dir: dir === "." ? "" : dir,
      ext,
      size,
      mtime,
      bpm: null,
    });
  }
}
