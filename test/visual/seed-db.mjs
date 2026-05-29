/**
 * Creates test/visual/test.sqlite — a minimal seed database for local
 * visual testing. Copies track data from the real DJSHNOOPSIES db so
 * the library shows real songs. No user rows are copied; the server
 * runs with auth disabled (no SESSION_SECRET), so no login is needed.
 *
 * Usage:  node test/visual/seed-db.mjs
 * Re-run any time to reset the db to a clean state.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const DIR  = dirname(fileURLToPath(import.meta.url));
const OUT  = join(DIR, 'test.sqlite');
const SRC  = join(homedir(), 'Sites/marijnvandevoorde/DJSHNOOPSIES/data/pass-the-aux.sqlite');

if (!existsSync(SRC)) {
  console.error(`Source db not found: ${SRC}`);
  process.exit(1);
}

// Nuke and recreate the output db
if (existsSync(OUT)) {
  const { unlinkSync } = await import('node:fs');
  unlinkSync(OUT);
}
mkdirSync(DIR, { recursive: true });

const src = new DatabaseSync(SRC);
const dst = new DatabaseSync(OUT);

// ── Schema ──────────────────────────────────────────────────────────────────
dst.exec(`
  CREATE TABLE analysis (
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
  CREATE INDEX idx_analysis_user_title  ON analysis (user_id, title);
  CREATE INDEX idx_analysis_user_bpm    ON analysis (user_id, bpm);
  CREATE INDEX idx_analysis_user_energy ON analysis (user_id, energy);

  CREATE TABLE beat_grids (
    user_id       TEXT    NOT NULL,
    track_id      TEXT    NOT NULL,
    duration_sec  REAL    NOT NULL,
    beats_json    TEXT    NOT NULL,
    downbeat_phase INTEGER NOT NULL DEFAULT 0,
    first_solid_cue_sec REAL,
    confidence    REAL    NOT NULL DEFAULT 0,
    analyzed_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id)
  );

  CREATE TABLE users (
    id             TEXT    PRIMARY KEY NOT NULL,
    username       TEXT    NOT NULL UNIQUE,
    pw_salt        TEXT    NOT NULL,
    pw_hash        TEXT    NOT NULL,
    totp_secret    TEXT,
    totp_enabled   INTEGER NOT NULL DEFAULT 0,
    recovery_codes TEXT,
    created_at     INTEGER NOT NULL,
    plan           TEXT    NOT NULL DEFAULT 'free'
  );

  CREATE TABLE crates (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    track_ids  TEXT    NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );

  CREATE TABLE remote_libraries (
    id         TEXT    PRIMARY KEY NOT NULL,
    user_id    TEXT    NOT NULL,
    kind       TEXT    NOT NULL DEFAULT 'pta',
    name       TEXT    NOT NULL,
    base_url   TEXT,
    secret     TEXT,
    api_key    TEXT,
    is_active  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
`);

// ── Copy analysis rows — remap to user_id "" (auth-disabled owner) ──────────
const rows = src.prepare('SELECT * FROM analysis').all();
const ins  = dst.prepare(`
  INSERT INTO analysis
    (user_id, track_id, bpm, size, mtime, analyzed_at, key, mode, camelot, energy, artist, title)
  VALUES
    ('', :track_id, :bpm, :size, :mtime, :analyzed_at, :key, :mode, :camelot, :energy, :artist, :title)
`);

dst.exec('BEGIN');
for (const r of rows) {
  ins.run({
    track_id: r.track_id, bpm: r.bpm, size: r.size, mtime: r.mtime,
    analyzed_at: r.analyzed_at, key: r.key, mode: r.mode,
    camelot: r.camelot, energy: r.energy, artist: r.artist, title: r.title,
  });
}
dst.exec('COMMIT');

src.close();
dst.close();

console.log(`Seeded ${rows.length} tracks into ${OUT}`);
console.log(`\nStart the server with:`);
console.log(`  MUSIC_DIR=./music SQLITE_PATH=test/visual/test.sqlite node server.ts`);
