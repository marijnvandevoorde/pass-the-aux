import type { Waveform } from "../waveform.ts";

/** Stored overview waveforms, so a restart doesn't decode every track
 *  again. Scoped by user, same id space as the beat grids. */
export interface WaveformRepository {
  /** The stored waveform, or `null` when missing/corrupt. */
  get(userId: string, trackId: string): Promise<Waveform | null>;
  /** Upsert. */
  put(userId: string, trackId: string, waveform: Waveform): Promise<void>;
}
