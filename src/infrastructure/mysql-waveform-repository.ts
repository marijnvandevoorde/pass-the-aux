import type { Waveform } from "../domain/waveform.ts";
import type { WaveformRepository } from "../domain/ports/waveform-repository.ts";
import { ensureSchema, type Db } from "./mysql-pool.ts";
import { packPeaks, unpackWaveform } from "./waveform-blob.ts";

/** MySQL-backed overview waveforms (one byte per level). */
export class MysqlWaveformRepository implements WaveformRepository {
  readonly #pool: Db;
  constructor(pool: Db) {
    this.#pool = pool;
  }

  async get(userId: string, trackId: string): Promise<Waveform | null> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      `SELECT duration_sec, peaks_blob FROM waveforms
        WHERE user_id = :uid AND track_id = :id LIMIT 1`,
      { uid: userId, id: trackId },
    );
    const r = (rows as Array<{ duration_sec: number; peaks_blob: Buffer }>)[0];
    return r ? unpackWaveform(r.duration_sec, r.peaks_blob) : null;
  }

  async put(userId: string, trackId: string, w: Waveform): Promise<void> {
    await ensureSchema(this.#pool);
    await this.#pool.execute(
      `INSERT INTO waveforms (user_id, track_id, duration_sec, peaks_blob, created_at)
       VALUES (:uid, :id, :duration, :peaks, :at)
       ON DUPLICATE KEY UPDATE
         duration_sec=VALUES(duration_sec),
         peaks_blob=VALUES(peaks_blob),
         created_at=VALUES(created_at)`,
      {
        uid: userId,
        id: trackId,
        duration: w.durationSec,
        peaks: packPeaks(w.peaks),
        at: Date.now(),
      },
    );
  }
}
