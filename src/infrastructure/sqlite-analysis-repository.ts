import type {
  AnalysisRecord,
  AnalysisRepository,
  LibraryPage,
  LibraryQuery,
} from "../domain/ports/analysis-repository.ts";
import { ensureSchema, type Db } from "./sqlite-pool.ts";

// Whitelisted sort expressions (never interpolate user input).
const SORT_SQL: Record<string, string> = {
  title: "COALESCE(NULLIF(title, ''), track_id)",
  bpm: "bpm",
  energy: "energy",
};

interface DbRow {
  track_id: string;
  bpm: number | null;
  size: number;
  mtime: number;
  analyzed_at: number;
  key: string | null;
  mode: string | null;
  camelot: string | null;
  energy: number | null;
  artist: string | null;
  title: string | null;
}

function rowToRecord(row: DbRow): AnalysisRecord {
  return {
    bpm: row.bpm === null ? null : Number(row.bpm),
    size: Number(row.size),
    mtime: Number(row.mtime),
    analyzedAt: Number(row.analyzed_at),
    key: row.key ?? null,
    mode: row.mode ?? null,
    camelot: row.camelot ?? null,
    energy: row.energy === null ? null : Number(row.energy),
    artist: row.artist ?? null,
    title: row.title ?? null,
  };
}

/** SQLite-backed BPM/feature cache. Same port as the JSON/MySQL ones. */
export class SqliteAnalysisRepository implements AnalysisRepository {
  readonly #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async all(userId: string): Promise<Record<string, AnalysisRecord>> {
    ensureSchema(this.#db);
    const rows = this.#db
      .prepare(
        "SELECT track_id, bpm, size, mtime, analyzed_at, key, mode, camelot, energy, artist, title FROM analysis WHERE user_id = :uid",
      )
      .all({ uid: userId }) as unknown as DbRow[];
    const out: Record<string, AnalysisRecord> = {};
    for (const r of rows) out[r.track_id] = rowToRecord(r);
    return out;
  }

  async put(
    userId: string,
    id: string,
    record: Omit<AnalysisRecord, "analyzedAt">,
  ): Promise<void> {
    ensureSchema(this.#db);
    this.#db
      .prepare(
        `INSERT INTO analysis
           (user_id, track_id, bpm, size, mtime, analyzed_at, key, mode, camelot, energy, artist, title)
         VALUES (:uid, :id, :bpm, :size, :mtime, :at, :key, :mode, :camelot, :energy, :artist, :title)
         ON CONFLICT (user_id, track_id) DO UPDATE SET
           bpm=excluded.bpm, size=excluded.size, mtime=excluded.mtime,
           analyzed_at=excluded.analyzed_at, key=excluded.key, mode=excluded.mode,
           camelot=excluded.camelot, energy=excluded.energy, artist=excluded.artist,
           title=excluded.title`,
      )
      .run({
        uid: userId,
        id,
        bpm: record.bpm,
        size: record.size,
        mtime: record.mtime,
        at: Date.now(),
        key: record.key ?? null,
        mode: record.mode ?? null,
        camelot: record.camelot ?? null,
        energy: record.energy ?? null,
        artist: record.artist ?? null,
        title: record.title ?? null,
      });
  }

  async page(userId: string, q: LibraryQuery): Promise<LibraryPage> {
    ensureSchema(this.#db);
    const sortExpr = SORT_SQL[q.sort] ?? SORT_SQL.title!;
    const dir = q.dir === "desc" ? "DESC" : "ASC";
    const search = q.q.trim();
    const where =
      "WHERE user_id = :uid" +
      (search
        ? " AND (title LIKE :like OR artist LIKE :like OR track_id LIKE :like)"
        : "");
    const params: Record<string, string | number> = { uid: userId };
    if (search) params.like = `%${search}%`;

    const cntRow = this.#db
      .prepare(`SELECT COUNT(*) AS n FROM analysis ${where}`)
      .get(params) as { n: number } | undefined;
    const total = Number(cntRow?.n ?? 0);

    // NULLs last; track_id is the stable tiebreaker.
    const lim = Math.max(1, Math.min(200, Math.trunc(q.limit) || 20));
    const off = Math.max(0, Math.trunc(q.offset) || 0);
    const rows = this.#db
      .prepare(
        `SELECT track_id, bpm, size, mtime, analyzed_at, key, mode,
                camelot, energy, artist, title
         FROM analysis ${where}
         ORDER BY (${sortExpr} IS NULL), ${sortExpr} ${dir}, track_id ASC
         LIMIT ${lim} OFFSET ${off}`,
      )
      .all(params) as unknown as DbRow[];
    return {
      items: rows.map((r) => ({ id: r.track_id, record: rowToRecord(r) })),
      total,
    };
  }
}
