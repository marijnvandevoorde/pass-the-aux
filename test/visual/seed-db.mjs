/**
 * Creates/resets test/visual/test.sqlite — a minimal seed database for
 * visual testing. Inserts analysis rows from the OGG files in ./music
 * so the library shows real tracks without needing a production database.
 * No users — the server runs auth-disabled (no SESSION_SECRET).
 *
 * Usage:  node test/visual/seed-db.mjs
 * Or:     npm run seed-db
 *
 * Then start the server with:
 *   npm run visual-server
 */

import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR       = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(DIR, '../..');
const MUSIC_DIR = join(ROOT, 'music');
const OUT       = join(DIR, 'test.sqlite');

// Wipe any leftover WAL files alongside the main db.
for (const f of [OUT, OUT + '-shm', OUT + '-wal']) {
  if (existsSync(f)) unlinkSync(f);
}
mkdirSync(DIR, { recursive: true });

const db = new DatabaseSync(OUT);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = NORMAL');

db.exec(`
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

  CREATE TABLE crates (
    user_id   TEXT NOT NULL,
    name      TEXT NOT NULL,
    track_ids TEXT NOT NULL,
    PRIMARY KEY (user_id, name)
  );

  CREATE TABLE beat_grids (
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
    plan           TEXT    NOT NULL DEFAULT 'free',
    created_at     INTEGER NOT NULL
  );

  CREATE TABLE remote_libraries (
    id         TEXT    PRIMARY KEY NOT NULL,
    user_id    TEXT    NOT NULL,
    kind       TEXT    NOT NULL,
    name       TEXT    NOT NULL,
    base_url   TEXT,
    api_key    TEXT,
    is_active  INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_remote_libraries_user ON remote_libraries (user_id, is_active);
`);

const ins = db.prepare(`
  INSERT INTO analysis (user_id, track_id, bpm, size, mtime, analyzed_at)
  VALUES ('', :track_id, NULL, :size, :mtime, :analyzed_at)
`);

const oggs = readdirSync(MUSIC_DIR)
  .filter(f => f.toLowerCase().endsWith('.ogg'))
  .sort();

const now = Date.now();

db.exec('BEGIN');
for (const f of oggs) {
  const st = statSync(join(MUSIC_DIR, f));
  ins.run({ track_id: f, size: st.size, mtime: Math.round(st.mtimeMs), analyzed_at: now });
}
db.exec('COMMIT');
db.close();

console.log(`Seeded ${oggs.length} track(s) into ${OUT}`);
console.log('  ' + oggs.join('\n  '));
console.log('\nStart the server with:');
console.log('  npm run visual-server');
