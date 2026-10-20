import type { BeatGrid } from "../domain/beat-grid.ts";
import type { BeatGridRepository } from "../domain/ports/beat-grid-repository.ts";
import type { GridDemand } from "./grid-demand.ts";

/** Per-deck beat-grid lookup for the browser; null when the track
 *  hasn't been gridded yet (caller falls back to BPM-only math). A
 *  deck asking for a grid that doesn't exist yet puts the track first
 *  in line for the grid builder. */
export class GetBeatGrid {
  readonly #grids: BeatGridRepository;
  readonly #userId: string;
  readonly #demand: GridDemand | null;

  constructor(grids: BeatGridRepository, userId = "", demand: GridDemand | null = null) {
    this.#grids = grids;
    this.#userId = userId;
    this.#demand = demand;
  }

  async execute(trackId: unknown): Promise<BeatGrid | null> {
    if (typeof trackId !== "string" || trackId.trim() === "") return null;
    const grid = await this.#grids.get(this.#userId, trackId);
    if (grid === null) this.#demand?.want(this.#userId, [trackId]);
    // An empty grid only records "analysed, no pulse" for the backfill.
    return grid && grid.beats.length > 0 ? grid : null;
  }
}
