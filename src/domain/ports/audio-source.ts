import type { Readable } from "node:stream";

export interface AudioStat {
  id: string;
  size: number;
  contentType: string;
}

export interface ByteRange {
  start: number;
  end: number;
}

/** Provides audio bytes for a track. Implemented by infrastructure. */
export interface AudioSource {
  /** Metadata for a track, or throws a domain error if it is not a valid track. */
  stat(id: string): Promise<AudioStat>;

  /** A readable stream of the whole file, or the given inclusive byte range. */
  createStream(id: string, range?: ByteRange | null): Readable;
}
