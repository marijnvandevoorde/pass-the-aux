export interface TrackTags {
  title?: string;
  artist?: string;
  /** Embedded BPM (ID3 TBPM), if present. */
  bpm?: number;
  /** Embedded musical key (ID3 TKEY), if present. */
  key?: string;
}

export interface CoverArt {
  mime: string;
  data: Uint8Array;
}

/** Reads embedded metadata for a track id. Implemented by infrastructure. */
export interface TagReader {
  read(id: string): Promise<TrackTags | null>;
  readCover(id: string): Promise<CoverArt | null>;
}
