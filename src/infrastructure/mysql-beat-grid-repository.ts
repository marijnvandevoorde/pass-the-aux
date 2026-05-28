import type { BeatGrid } from "../domain/beat-grid.ts";
import type { BeatGridRepository } from "../domain/ports/beat-grid-repository.ts";
import { ensureSchema, type Db } from "./mysql-pool.ts";

/** Pure mapper: MySQL row → BeatGrid. Unit-tested without a live DB. */
export function rowToBeatGrid(row: {
  track_id: string;
  duration_sec: number;
  beat_count: number | bigint;
  downbeat_phase: number;
  first_solid_index: number | bigint;
  confidence: number;
  analyzer_version: number;
  analyzed_at: number | bigint;
  beats_blob: Buffer;
}): BeatGrid | null {
  const count = Number(row.beat_count);
  if (count < 0) return null;
  if (row.beats_blob.byteLength !== count * 4) return null;
  // The blob is Float32 little-endian, packed beat_count times.
  // Copy out so callers don't share storage with the driver's buffer.
  const beats = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    beats[i] = row.beats_blob.readFloatLE(i * 4);
  }
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

/** Pure mapper: BeatGrid → row params for the insert/upsert statement. */
export function beatGridToRow(
  userId: string,
  grid: BeatGrid,
): {
  uid: string;
  id: string;
  duration: number;
  count: number;
  phase: number;
  firstSolid: number;
  conf: number;
  ver: number;
  at: number;
  beats: Buffer;
} {
  const buf = Buffer.allocUnsafe(grid.beats.length * 4);
  for (let i = 0; i < grid.beats.length; i++) {
    buf.writeFloatLE(grid.beats[i]!, i * 4);
  }
  return {
    uid: userId,
    id: grid.trackId,
    duration: grid.durationSec,
    count: grid.beats.length,
    phase: grid.downbeatPhase,
    firstSolid: grid.firstSolidBeatIndex,
    conf: grid.confidence,
    ver: grid.analyzerVersion,
    at: grid.analyzedAt,
    beats: buf,
  };
}

/** MySQL-backed beat grid storage. Same port as the JSON adapter. */
export class MysqlBeatGridRepository implements BeatGridRepository {
  readonly #pool: Db;

  constructor(pool: Db) {
    this.#pool = pool;
  }

  async get(userId: string, trackId: string): Promise<BeatGrid | null> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      `SELECT track_id, duration_sec, beat_count, downbeat_phase,
              first_solid_index, confidence, analyzer_version, analyzed_at,
              beats_blob
         FROM beat_grids
        WHERE user_id = :uid AND track_id = :id
        LIMIT 1`,
      { uid: userId, id: trackId },
    );
    const r = (rows as Array<Parameters<typeof rowToBeatGrid>[0]>)[0];
    return r ? rowToBeatGrid(r) : null;
  }

  async put(
    userId: string,
    grid: Omit<BeatGrid, "analyzedAt">,
  ): Promise<void> {
    await ensureSchema(this.#pool);
    const params = beatGridToRow(userId, {
      ...grid,
      analyzedAt: Date.now(),
    } as BeatGrid);
    await this.#pool.execute(
      `INSERT INTO beat_grids
         (user_id, track_id, duration_sec, beat_count, downbeat_phase,
          first_solid_index, confidence, analyzer_version, analyzed_at,
          beats_blob)
       VALUES (:uid, :id, :duration, :count, :phase, :firstSolid, :conf,
               :ver, :at, :beats)
       ON DUPLICATE KEY UPDATE
         duration_sec=VALUES(duration_sec),
         beat_count=VALUES(beat_count),
         downbeat_phase=VALUES(downbeat_phase),
         first_solid_index=VALUES(first_solid_index),
         confidence=VALUES(confidence),
         analyzer_version=VALUES(analyzer_version),
         analyzed_at=VALUES(analyzed_at),
         beats_blob=VALUES(beats_blob)`,
      params,
    );
  }

  async has(userId: string, trackId: string): Promise<boolean> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      `SELECT 1 AS one FROM beat_grids
        WHERE user_id = :uid AND track_id = :id
        LIMIT 1`,
      { uid: userId, id: trackId },
    );
    return (rows as Array<unknown>).length > 0;
  }
}
