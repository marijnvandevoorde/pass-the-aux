import type { BeatGrid } from "../beat-grid.ts";

/**
 * Persistence for per-track beat grids. Scoped by user — same id space
 * as {@link AnalysisRepository}. Per-track `get`, deliberately no `all`:
 * the library listing never needs to load every grid into memory.
 */
export interface BeatGridRepository {
  /** The grid for `(userId, trackId)`, or `null` when missing/corrupt. */
  get(userId: string, trackId: string): Promise<BeatGrid | null>;
  /** Upsert. `analyzedAt` is set by the adapter at write time. */
  put(
    userId: string,
    grid: Omit<BeatGrid, "analyzedAt">,
  ): Promise<void>;
  /** Cheap existence probe so the bulk job can skip done tracks. */
  has(userId: string, trackId: string): Promise<boolean>;
}
