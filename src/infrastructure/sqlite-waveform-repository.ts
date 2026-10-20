import type { Waveform } from "../domain/waveform.ts";
import type { WaveformRepository } from "../domain/ports/waveform-repository.ts";
import { ensureSchema, type Db } from "./sqlite-pool.ts";
import { packPeaks, unpackWaveform } from "./waveform-blob.ts";

/** SQLite-backed overview waveforms (one byte per level). */
export class SqliteWaveformRepository implements WaveformRepository {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async get(userId: string, trackId: string): Promise<Waveform | null> {
    ensureSchema(this.#db);
    const row = this.#db
      .prepare(
        `SELECT duration_sec, peaks_blob FROM waveforms
          WHERE user_id = :uid AND track_id = :id LIMIT 1`,
      )
      .get({ uid: userId, id: trackId }) as
      | { duration_sec: number; peaks_blob: Uint8Array }
      | undefined;
    return row ? unpackWaveform(row.duration_sec, row.peaks_blob) : null;
  }

  async put(userId: string, trackId: string, w: Waveform): Promise<void> {
    ensureSchema(this.#db);
    this.#db
      .prepare(
        `INSERT INTO waveforms (user_id, track_id, duration_sec, peaks_blob, created_at)
         VALUES (:uid, :id, :duration, :peaks, :at)
         ON CONFLICT (user_id, track_id) DO UPDATE SET
           duration_sec=excluded.duration_sec,
           peaks_blob=excluded.peaks_blob,
           created_at=excluded.created_at`,
      )
      .run({
        uid: userId,
        id: trackId,
        duration: w.durationSec,
        peaks: packPeaks(w.peaks),
        at: Date.now(),
      });
  }
}
