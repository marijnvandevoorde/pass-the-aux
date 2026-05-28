import type { BeatGrid } from "../domain/beat-grid.ts";
import type { BeatGridRepository } from "../domain/ports/beat-grid-repository.ts";
import { ensureSchema, type Db } from "./sqlite-pool.ts";

interface DbRow {
  track_id: string;
  duration_sec: number;
  beat_count: number;
  downbeat_phase: number;
  first_solid_index: number;
  confidence: number;
  analyzer_version: number;
  analyzed_at: number;
  beats_blob: Uint8Array;
}

function rowToBeatGrid(row: DbRow): BeatGrid | null {
  const count = Number(row.beat_count);
  if (count < 0) return null;
  const blob = Buffer.from(row.beats_blob);
  if (blob.byteLength !== count * 4) return null;
  const beats = new Float32Array(count);
  for (let i = 0; i < count; i++) beats[i] = blob.readFloatLE(i * 4);
  const phase = row.downbeat_phase;
  if (phase !== 0 && phase !== 1 && phase !== 2 && phase !== 3) return null;
  return {
    trackId: row.track_id,
    durationSec: Number(row.duration_sec),
    beats,
    downbeatPhase: phase,
    firstSolidBeatIndex: Number(row.first_solid_index),
    confidence: Number(row.confidence),
    analyzedAt: Number(row.analyzed_at),
    analyzerVersion: row.analyzer_version,
  };
}

/** SQLite-backed beat grids. Beats are a packed Float32-LE BLOB. */
export class SqliteBeatGridRepository implements BeatGridRepository {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async get(userId: string, trackId: string): Promise<BeatGrid | null> {
    ensureSchema(this.#db);
    const row = this.#db
      .prepare(
        `SELECT track_id, duration_sec, beat_count, downbeat_phase,
                first_solid_index, confidence, analyzer_version, analyzed_at,
                beats_blob
           FROM beat_grids
          WHERE user_id = :uid AND track_id = :id
          LIMIT 1`,
      )
      .get({ uid: userId, id: trackId }) as unknown as DbRow | undefined;
    return row ? rowToBeatGrid(row) : null;
  }

  async put(
    userId: string,
    grid: Omit<BeatGrid, "analyzedAt">,
  ): Promise<void> {
    ensureSchema(this.#db);
    const buf = Buffer.allocUnsafe(grid.beats.length * 4);
    for (let i = 0; i < grid.beats.length; i++) {
      buf.writeFloatLE(grid.beats[i]!, i * 4);
    }
    this.#db
      .prepare(
        `INSERT INTO beat_grids
           (user_id, track_id, duration_sec, beat_count, downbeat_phase,
            first_solid_index, confidence, analyzer_version, analyzed_at,
            beats_blob)
         VALUES (:uid, :id, :duration, :count, :phase, :firstSolid, :conf,
                 :ver, :at, :beats)
         ON CONFLICT (user_id, track_id) DO UPDATE SET
           duration_sec=excluded.duration_sec,
           beat_count=excluded.beat_count,
           downbeat_phase=excluded.downbeat_phase,
           first_solid_index=excluded.first_solid_index,
           confidence=excluded.confidence,
           analyzer_version=excluded.analyzer_version,
           analyzed_at=excluded.analyzed_at,
           beats_blob=excluded.beats_blob`,
      )
      .run({
        uid: userId,
        id: grid.trackId,
        duration: grid.durationSec,
        count: grid.beats.length,
        phase: grid.downbeatPhase,
        firstSolid: grid.firstSolidBeatIndex,
        conf: grid.confidence,
        ver: grid.analyzerVersion,
        at: Date.now(),
        beats: buf,
      });
  }

  async has(userId: string, trackId: string): Promise<boolean> {
    ensureSchema(this.#db);
    const row = this.#db
      .prepare(
        "SELECT 1 AS one FROM beat_grids WHERE user_id = :uid AND track_id = :id LIMIT 1",
      )
      .get({ uid: userId, id: trackId });
    return row !== undefined;
  }
}
