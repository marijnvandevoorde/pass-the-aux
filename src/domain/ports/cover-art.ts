/** Fetches album art for a track from an external source by metadata
 *  (DJ cover-fetch). Returns ~250px image bytes, or null when nothing
 *  is found / lookups are disabled. Implemented by infrastructure. */
export interface CoverArtSource {
  fetch(artist: string | null, title: string): Promise<Uint8Array | null>;
}

/** Stores/serves a cover JPG kept next to the mp3 so it's fetched
 *  once (at analysis) and never re-extracted. */
export interface CoverStore {
  has(trackId: string): Promise<boolean>;
  read(trackId: string): Promise<Uint8Array | null>;
  write(trackId: string, bytes: Uint8Array): Promise<void>;
}
