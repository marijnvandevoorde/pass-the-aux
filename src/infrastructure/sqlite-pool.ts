// Single place that imports `node:sqlite`. Same role as mysql-pool.ts
// for the mysql driver: hands out the shared DB handle and bootstraps
// the schema on first use.
//
// node:sqlite is stable in Node 24 but still emits an ExperimentalWarning
// on first import. We silence that one warning here — once, on import —
// so it doesn't spam stderr in production.
import { DatabaseSync } from "node:sqlite";

const origEmit = process.emitWarning.bind(process);
process.emitWarning = ((
  warning: string | Error,
  ...rest: unknown[]
): void => {
  const msg = typeof warning === "string" ? warning : warning.message;
  if (msg.includes("SQLite is an experimental feature")) return;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (origEmit as any)(warning, ...rest);
}) as typeof process.emitWarning;

export type Db = DatabaseSync;

/** Returns the configured DB handle, applying our pragmas the first
 *  time it's opened. Subsequent calls reuse the cached connection. */
const handles = new Map<string, Db>();
export function openDb(path: string): Db {
  const cached = handles.get(path);
  if (cached) return cached;
  const db = new DatabaseSync(path);
  // WAL = concurrent readers + a single writer without blocking, the
  // right default for a server. `synchronous = NORMAL` is safe with WAL
  // (no data loss; possible last-write loss on power cut). `foreign_keys`
  // we leave OFF (we don't model FKs).
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  handles.set(path, db);
  return db;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS analysis (
    user_id     TEXT    NOT NULL,
    track_id    TEXT    NOT NULL,
    bpm         REAL,
    size        INTEGER NOT NULL,
    mtime       INTEGER NOT NULL,
    analyzed_at INTEGER NOT NULL,
    key         TEXT,
    mode        TEXT,
    camelot     TEXT,
    energy      REAL,
    artist      TEXT,
    title       TEXT,
    PRIMARY KEY (user_id, track_id)
  );
  CREATE INDEX IF NOT EXISTS idx_analysis_user_title
    ON analysis (user_id, title);
  CREATE INDEX IF NOT EXISTS idx_analysis_user_bpm
    ON analysis (user_id, bpm);
  CREATE INDEX IF NOT EXISTS idx_analysis_user_energy
    ON analysis (user_id, energy);

  CREATE TABLE IF NOT EXISTS crates (
    user_id   TEXT NOT NULL,
    name      TEXT NOT NULL,
    track_ids TEXT NOT NULL,
    PRIMARY KEY (user_id, name)
  );

  CREATE TABLE IF NOT EXISTS beat_grids (
    user_id           TEXT    NOT NULL,
    track_id          TEXT    NOT NULL,
    duration_sec      REAL    NOT NULL,
    beat_count        INTEGER NOT NULL,
    downbeat_phase    INTEGER NOT NULL,
    first_solid_index INTEGER NOT NULL,
    confidence        REAL    NOT NULL,
    analyzer_version  INTEGER NOT NULL,
    analyzed_at       INTEGER NOT NULL,
    beats_blob        BLOB    NOT NULL,
    mix_out_index     INTEGER NOT NULL DEFAULT -1,
    bars_blob         BLOB,
    PRIMARY KEY (user_id, track_id)
  );

  CREATE TABLE IF NOT EXISTS waveforms (
    user_id      TEXT    NOT NULL,
    track_id     TEXT    NOT NULL,
    duration_sec REAL    NOT NULL,
    peaks_blob   BLOB    NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id             TEXT    PRIMARY KEY NOT NULL,
    username       TEXT    NOT NULL UNIQUE,
    pw_salt        TEXT    NOT NULL,
    pw_hash        TEXT    NOT NULL,
    totp_secret    TEXT,
    totp_enabled   INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT,
    plan           TEXT    NOT NULL DEFAULT 'free',
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS remote_libraries (
    id         TEXT    PRIMARY KEY NOT NULL,
    user_id    TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    base_url   TEXT,
    api_key    TEXT,
    is_active  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_remote_libraries_user
    ON remote_libraries (user_id, is_active);

  CREATE TABLE IF NOT EXISTS party_sessions (
    id             TEXT    PRIMARY KEY NOT NULL,
    owner_user_id  TEXT    NOT NULL,
    config         TEXT    NOT NULL,
    now_playing    TEXT,
    now_playing_at INTEGER,
    up_next        TEXT,
    rev            INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_party_sessions_updated
    ON party_sessions (updated_at);

  CREATE TABLE IF NOT EXISTS party_session_requests (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    bpm        REAL,
    by_name    TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_party_session_requests_session
    ON party_session_requests (session_id, seq);

  CREATE TABLE IF NOT EXISTS party_session_played (
    session_id TEXT    NOT NULL,
    path_key   TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, path_key)
  );

  CREATE TABLE IF NOT EXISTS party_session_votes (
    session_id TEXT    NOT NULL,
    path_key   TEXT    NOT NULL,
    guest      TEXT    NOT NULL,
    path       TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, path_key, guest)
  );
`;

const ready = new WeakSet<Db>();

/** Idempotent schema bootstrap. Mirrors mysql-pool.ts `ensureSchema`. */
export function ensureSchema(db: Db): void {
  if (ready.has(db)) return;
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS never alters an existing table, so columns
  // added after a DB was first created need an explicit, guarded ALTER.
  addColumnIfMissing(db, "users", "plan", "TEXT NOT NULL DEFAULT 'free'");
  // Mix-out point and per-bar downbeats (pass-the-beat analyzer v3).
  addColumnIfMissing(db, "beat_grids", "mix_out_index", "INTEGER NOT NULL DEFAULT -1");
  addColumnIfMissing(db, "beat_grids", "bars_blob", "BLOB");
  ready.add(db);
}

function addColumnIfMissing(
  db: Db,
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}
