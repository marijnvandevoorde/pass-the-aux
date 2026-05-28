import { TrackId } from "../domain/track-id.ts";
import type { CoverArt, TagReader } from "../domain/ports/tag-reader.ts";
import type { CoverStore } from "../domain/ports/cover-art.ts";

/** Cover art for a track: the pre-stored JPG next to the mp3 (fast,
 *  written at analysis) wins; otherwise embedded art; else null. */
export class GetCover {
  readonly #tags: TagReader;
  readonly #store: CoverStore | null;

  constructor(tags: TagReader, store: CoverStore | null = null) {
    this.#tags = tags;
    this.#store = store;
  }

  async execute(rawPath: unknown): Promise<CoverArt | null> {
    const id = new TrackId(rawPath).value; // throws on traversal → 403
    const stored = await this.#store?.read(id).catch(() => null);
    if (stored && stored.byteLength > 0) {
      return { mime: "image/jpeg", data: stored };
    }
    return this.#tags.readCover(id);
  }
}
