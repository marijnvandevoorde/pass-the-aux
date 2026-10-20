import type { Waveform } from "../waveform.ts";

/** Computes a track's overview waveform from its audio. Null when the
 *  track can't be read. */
export interface WaveformSource {
  waveform(trackId: string): Promise<Waveform | null>;
}
