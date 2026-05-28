import type { Track } from "../track.ts";

/** Read access to the track library. Implemented by infrastructure. */
export interface TrackRepository {
  /** All tracks currently in the library (unordered). */
  list(): Promise<Track[]>;

  /** A single track by its id, or `null` if it does not exist / is not audio. */
  findById(id: string): Promise<Track | null>;
}
