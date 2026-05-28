import type { BeatGrid } from "../domain/beat-grid.ts";
import type { BeatGridRepository } from "../domain/ports/beat-grid-repository.ts";

/** Per-deck beat-grid lookup for the browser; null when the track
 *  hasn't been gridded yet (caller falls back to BPM-only math). */
export class GetBeatGrid {
  readonly #grids: BeatGridRepository;
  readonly #userId: string;

  constructor(grids: BeatGridRepository, userId = "") {
    this.#grids = grids;
    this.#userId = userId;
  }

  async execute(trackId: unknown): Promise<BeatGrid | null> {
    if (typeof trackId !== "string" || trackId.trim() === "") return null;
    return this.#grids.get(this.#userId, trackId);
  }
}
