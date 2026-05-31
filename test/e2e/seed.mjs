/**
 * Builds test/e2e/.tmp/e2e.sqlite — a deterministic library for the E2E
 * suite, seeded from the committed fixtures in test/e2e/fixtures/music.
 * Fixed bpm/camelot/artist/title so the suite can pin key chips, the
 * mix-flow badges, and the requester flow exactly. Auth-disabled (no
 * users). Called by run.mjs before the server starts.
 */
import { DatabaseSync } from "node:sqlite";
import { statSync, existsSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const MUSIC_DIR = join(DIR, "fixtures", "music");
export const DB_PATH = join(DIR, ".tmp", "e2e.sqlite");

// The fixed library. track_id is the on-disk filename (also the API path).
export const TRACKS = [
  { file: "Aero - Glass Heart.mp3",     artist: "Aero",     title: "Glass Heart",   bpm: 131, camelot: "12B", key: "E",  mode: "major" },
  { file: "Kavinsky - Nightcall.mp3",   artist: "Kavinsky", title: "Nightcall",     bpm: 124, camelot: "1B",  key: "B",  mode: "major" },
  { file: "M83 - Midnight City.mp3",    artist: "M83",      title: "Midnight City", bpm: 105, camelot: "6A",  key: "G#", mode: "minor" },
  { file: "Sleeper - Saturn.mp3",       artist: "Sleeper",  title: "Saturn",        bpm: 122, camelot: "8B",  key: "A",  mode: "major" },
];

export function seed() {
  mkdirSync(dirname(DB_PATH), { recursive: true });
  for (const f of [DB_PATH, DB_PATH + "-shm", DB_PATH + "-wal"]) {
    if (existsSync(f)) unlinkSync(f);
  }

  const db = new DatabaseSync(DB_PATH);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE analysis (
      user_id TEXT NOT NULL, track_id TEXT NOT NULL, bpm REAL,
      size INTEGER NOT NULL, mtime INTEGER NOT NULL, analyzed_at INTEGER NOT NULL,
      key TEXT, mode TEXT, camelot TEXT, energy REAL, artist TEXT, title TEXT,
      PRIMARY KEY (user_id, track_id)
    );
    CREATE INDEX idx_analysis_user_title ON analysis (user_id, title);
    CREATE INDEX idx_analysis_user_bpm   ON analysis (user_id, bpm);
    CREATE TABLE crates (user_id TEXT NOT NULL, name TEXT NOT NULL, track_ids TEXT NOT NULL, PRIMARY KEY (user_id, name));
    CREATE TABLE beat_grids (
      user_id TEXT NOT NULL, track_id TEXT NOT NULL, duration_sec REAL NOT NULL,
      beat_count INTEGER NOT NULL, downbeat_phase INTEGER NOT NULL, first_solid_index INTEGER NOT NULL,
      confidence REAL NOT NULL, analyzer_version INTEGER NOT NULL, analyzed_at INTEGER NOT NULL,
      beats_blob BLOB NOT NULL, PRIMARY KEY (user_id, track_id)
    );
    CREATE TABLE users (
      id TEXT PRIMARY KEY NOT NULL, username TEXT NOT NULL UNIQUE, pw_salt TEXT NOT NULL,
      pw_hash TEXT NOT NULL, totp_secret TEXT, totp_enabled INTEGER NOT NULL DEFAULT 0,
      recovery_codes TEXT, plan TEXT NOT NULL DEFAULT 'free', created_at INTEGER NOT NULL
    );
    CREATE TABLE remote_libraries (
      id TEXT PRIMARY KEY NOT NULL, user_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL,
      base_url TEXT, api_key TEXT, is_active INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
  `);

  const ins = db.prepare(`
    INSERT INTO analysis (user_id, track_id, bpm, size, mtime, analyzed_at, key, mode, camelot, energy, artist, title)
    VALUES ('', :track_id, :bpm, :size, :mtime, :analyzed_at, :key, :mode, :camelot, 0.6, :artist, :title)
  `);
  const now = 1_700_000_000_000; // fixed timestamp → deterministic
  db.exec("BEGIN");
  for (const t of TRACKS) {
    const st = statSync(join(MUSIC_DIR, t.file));
    ins.run({
      track_id: t.file, bpm: t.bpm, size: st.size, mtime: Math.round(st.mtimeMs),
      analyzed_at: now, key: t.key, mode: t.mode, camelot: t.camelot,
      artist: t.artist, title: t.title,
    });
  }
  db.exec("COMMIT");
  db.close();
  return { dbPath: DB_PATH, musicDir: MUSIC_DIR, tracks: TRACKS };
}

// Allow standalone: `node test/e2e/seed.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const { dbPath, tracks } = seed();
  console.log(`Seeded ${tracks.length} tracks → ${resolve(dbPath)}`);
}
