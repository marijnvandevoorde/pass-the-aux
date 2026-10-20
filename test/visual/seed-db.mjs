/**
 * Creates/resets test/visual/test.sqlite — the seed database for the
 * visual test: the three CC0 demo OGGs in ./music with fixed metadata
 * (title, BPM, key, energy), so the library looks the same on every run
 * and the background analysis has nothing left to change.
 * No users — the server runs auth-disabled (no SESSION_SECRET).
 *
 * test/visual/visual.mjs calls seed() itself; standalone:
 *   npm run seed-db
 */

import { DatabaseSync } from 'node:sqlite';
import { statSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR       = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(DIR, '../..');
const MUSIC_DIR = join(ROOT, 'music');
export const OUT = join(DIR, 'test.sqlite');
export { MUSIC_DIR };

export const TRACKS = [
  { file: 'only-human-holiznacc0.ogg', title: 'ONLY HUMAN', artist: 'HoliznaCC0', bpm: 122, key: 'E', mode: 'minor', camelot: '9A', energy: 0.6 },
  { file: 'pantheon-holiznacc0.ogg',   title: 'Pantheon',   artist: 'HoliznaCC0', bpm: 105.5, key: 'G', mode: 'minor', camelot: '6A', energy: 0.63 },
  { file: 'phonk-ish-holiznacc0.ogg',  title: 'Phonk ish',  artist: 'HoliznaCC0', bpm: 128, key: 'A', mode: 'minor', camelot: '8A', energy: 0.44 },
];

export function seed() {
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
    INSERT INTO analysis (user_id, track_id, bpm, size, mtime, analyzed_at, key, mode, camelot, energy, artist, title)
    VALUES ('', :track_id, :bpm, :size, :mtime, :analyzed_at, :key, :mode, :camelot, :energy, :artist, :title)
  `);
  db.exec('BEGIN');
  for (const t of TRACKS) {
    const st = statSync(join(MUSIC_DIR, t.file));
    ins.run({
      track_id: t.file, bpm: t.bpm, size: st.size, mtime: Math.round(st.mtimeMs),
      analyzed_at: 1_700_000_000_000, key: t.key, mode: t.mode, camelot: t.camelot,
      energy: t.energy, artist: t.artist, title: t.title,
    });
  }
  db.exec('COMMIT');
  db.close();
  return OUT;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`Seeded ${TRACKS.length} tracks into ${seed()}`);
}
