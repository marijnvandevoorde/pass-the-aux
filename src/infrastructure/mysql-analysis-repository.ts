import type {
  AnalysisRecord,
  AnalysisRepository,
  LibraryPage,
  LibraryQuery,
} from "../domain/ports/analysis-repository.ts";

// Whitelisted sort expressions (never interpolate user input).
const SORT_SQL: Record<string, string> = {
  title: "COALESCE(NULLIF(title, ''), track_id)",
  bpm: "bpm",
  energy: "energy",
};
import { ensureSchema, type Db } from "./mysql-pool.ts";

/** Pure row → record mapper (unit-tested without a DB). MySQL hands
 *  numeric columns back as JS numbers; nullable extras stay null. */
export function rowToAnalysisRecord(row: {
  bpm: number | null;
  size: number | bigint;
  mtime: number | bigint;
  analyzed_at: number | bigint;
  key: string | null;
  mode: string | null;
  camelot: string | null;
  energy: number | null;
  artist?: string | null;
  title?: string | null;
}): AnalysisRecord {
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

/** MySQL-backed BPM/feature cache. Same port as the JSON one. */
export class MysqlAnalysisRepository implements AnalysisRepository {
  readonly #pool: Db;

  constructor(pool: Db) {
    this.#pool = pool;
  }

  async all(userId: string): Promise<Record<string, AnalysisRecord>> {
    await ensureSchema(this.#pool);
    const [rows] = await this.#pool.execute(
      "SELECT track_id, bpm, size, mtime, analyzed_at, `key`, `mode`, camelot, energy, artist, title FROM analysis WHERE user_id = :uid",
      { uid: userId },
    );
    const out: Record<string, AnalysisRecord> = {};
    for (const r of rows as Array<{ track_id: string } & Parameters<
      typeof rowToAnalysisRecord
    >[0]>) {
      out[r.track_id] = rowToAnalysisRecord(r);
    }
    return out;
  }

  async put(
    userId: string,
    id: string,
    record: Omit<AnalysisRecord, "analyzedAt">,
  ): Promise<void> {
    await ensureSchema(this.#pool);
    await this.#pool.execute(
      `INSERT INTO analysis
         (user_id, track_id, bpm, size, mtime, analyzed_at, \`key\`, \`mode\`, camelot, energy, artist, title)
       VALUES (:uid, :id, :bpm, :size, :mtime, :at, :key, :mode, :camelot, :energy, :artist, :title)
       ON DUPLICATE KEY UPDATE
         bpm=VALUES(bpm), size=VALUES(size), mtime=VALUES(mtime),
         analyzed_at=VALUES(analyzed_at), \`key\`=VALUES(\`key\`),
         \`mode\`=VALUES(\`mode\`), camelot=VALUES(camelot), energy=VALUES(energy),
         artist=VALUES(artist), title=VALUES(title)`,
      {
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
      },
    );
  }

  async page(userId: string, q: LibraryQuery): Promise<LibraryPage> {
    await ensureSchema(this.#pool);
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

    const [cnt] = await this.#pool.execute(
      `SELECT COUNT(*) AS n FROM analysis ${where}`,
      params,
    );
    const total = Number(
      (cnt as Array<{ n: number | bigint }>)[0]?.n ?? 0,
    );

    // NULLs (e.g. unknown bpm/energy) always sort last; track_id is
    // the stable tiebreaker for keyset-safe paging.
    // LIMIT/OFFSET are bounded integers (never user strings) and are
    // inlined: mysql2 prepared statements reject `LIMIT ?` bindings.
    const lim = Math.max(1, Math.min(200, Math.trunc(q.limit) || 20));
    const off = Math.max(0, Math.trunc(q.offset) || 0);
    const [rows] = await this.#pool.execute(
      `SELECT track_id, bpm, size, mtime, analyzed_at, \`key\`, \`mode\`,
              camelot, energy, artist, title
       FROM analysis ${where}
       ORDER BY (${sortExpr} IS NULL), ${sortExpr} ${dir}, track_id ASC
       LIMIT ${lim} OFFSET ${off}`,
      params,
    );
    const items = (
      rows as Array<{ track_id: string } & Parameters<
        typeof rowToAnalysisRecord
      >[0]>
    ).map((r) => ({ id: r.track_id, record: rowToAnalysisRecord(r) }));
    return { items, total };
  }
}
