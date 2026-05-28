import { TrackId } from "../domain/track-id.ts";
import type {
  AudioSource,
  AudioStat,
  ByteRange,
} from "../domain/ports/audio-source.ts";
import type { Readable } from "node:stream";

/** Resolves and streams a track's audio bytes. */
export class StreamAudio {
  readonly #source: AudioSource;

  constructor(source: AudioSource) {
    this.#source = source;
  }

  /** Validates the requested path and returns stream metadata. */
  stat(rawPath: unknown): Promise<AudioStat> {
    const id = new TrackId(rawPath).value;
    return this.#source.stat(id);
  }

  open(id: string, range?: ByteRange | null): Readable {
    return this.#source.createStream(id, range);
  }
}
