// the one place the sanctioned `mysql2` runtime dependency is
// imported. Everything else talks to MySQL through the Storage ports.
import { createPool } from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import type { Config } from "./config.ts";

export type Db = Pool;

export function createDbPool(db: Config["db"]): Db {
  return createPool({
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
    connectionLimit: 8,
    waitForConnections: true,
    enableKeepAlive: true,
    namedPlaceholders: true,
  });
}

const SCHEMA = [
  // scoped by a real user_id column; track_id is the bare
  // filename. Leading-user_id composite PK (we never query without it).
  `CREATE TABLE IF NOT EXISTS analysis (
     user_id     VARCHAR(32)  NOT NULL,
     track_id    VARCHAR(512) NOT NULL,
     bpm         DOUBLE       NULL,
     size        BIGINT       NOT NULL,
     mtime       BIGINT       NOT NULL,
     analyzed_at BIGINT       NOT NULL,
     \`key\`     VARCHAR(8)   NULL,
     \`mode\`    VARCHAR(16)  NULL,
     camelot     VARCHAR(8)   NULL,
     energy      DOUBLE       NULL,
     artist      VARCHAR(255) NULL,
     title       VARCHAR(512) NULL,
     PRIMARY KEY (user_id, track_id),
     -- every library query filters by user_id, so it leads
     -- every index; the second column makes ORDER BY … LIMIT
     -- index-ordered (no filesort) for each sort option.
     KEY idx_user_title (user_id, title(190)),
     KEY idx_user_bpm (user_id, bpm),
     KEY idx_user_energy (user_id, energy)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS crates (
     user_id   VARCHAR(32)  NOT NULL,
     name      VARCHAR(255) NOT NULL,
     track_ids JSON         NOT NULL,
     PRIMARY KEY (user_id, name)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // per-track beat grid for phase-aligned crossfades. Beats
  // are stored as a packed Float32 LE blob (4 bytes/beat) — opaque to
  // SQL, but we always read the whole grid at once anyway, so a
  // normalised child table would be ~770 rows of pure overhead per
  // track for nothing. Composite PK by (user_id, track_id) mirrors
  // the analysis table.
  `CREATE TABLE IF NOT EXISTS beat_grids (
     user_id              VARCHAR(32)  NOT NULL,
     track_id             VARCHAR(512) NOT NULL,
     duration_sec         DOUBLE       NOT NULL,
     beat_count           INT          NOT NULL,
     downbeat_phase       TINYINT      NOT NULL,
     first_solid_index    INT          NOT NULL,
     confidence           DOUBLE       NOT NULL,
     analyzer_version     SMALLINT     NOT NULL,
     analyzed_at          BIGINT       NOT NULL,
     beats_blob           MEDIUMBLOB   NOT NULL,
     PRIMARY KEY (user_id, track_id)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Created here so the schema is whole; populated by auth.
  `CREATE TABLE IF NOT EXISTS users (
     id             CHAR(32)     NOT NULL,
     username       VARCHAR(190) NOT NULL,
     pw_salt        VARCHAR(64)  NOT NULL,
     pw_hash        VARCHAR(255) NOT NULL,
     totp_secret    VARCHAR(255) NULL,
     totp_enabled   TINYINT(1)   NOT NULL DEFAULT 0,
     recovery_codes JSON         NULL,
     plan           VARCHAR(32)  NOT NULL DEFAULT 'free',
     created_at     BIGINT       NOT NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uniq_username (username)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // per-user remote record stores. Exactly one row per user
  // has is_active = 1; the use cases enforce that invariant.
  `CREATE TABLE IF NOT EXISTS remote_libraries (
     id         CHAR(36)     NOT NULL,
     user_id    VARCHAR(64)  NOT NULL,
     kind       VARCHAR(16)  NOT NULL,
     name       VARCHAR(120) NOT NULL,
     base_url   VARCHAR(500) NULL,
     api_key    VARCHAR(500) NULL,
     is_active  TINYINT(1)   NOT NULL DEFAULT 0,
     created_at BIGINT       NOT NULL,
     PRIMARY KEY (id),
     KEY idx_user (user_id, is_active)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

// Memoised per pool so concurrent first requests bootstrap once.
const ready = new WeakMap<Db, Promise<void>>();

export function ensureSchema(pool: Db): Promise<void> {
  let p = ready.get(pool);
  if (!p) {
    p = (async () => {
      for (const ddl of SCHEMA) await pool.query(ddl);
      // CREATE TABLE IF NOT EXISTS leaves an existing table untouched, so
      // columns added later need a guarded ALTER (MySQL has no portable
      // ADD COLUMN IF NOT EXISTS across versions).
      await addColumnIfMissing(
        pool,
        "users",
        "plan",
        "VARCHAR(32) NOT NULL DEFAULT 'free'",
      );
    })();
    ready.set(pool, p);
  }
  return p;
}

async function addColumnIfMissing(
  pool: Db,
  table: string,
  column: string,
  ddl: string,
): Promise<void> {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  const present = Number((rows as Array<{ n: number | bigint }>)[0]?.n ?? 0);
  if (present === 0) {
    await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${ddl}`);
  }
}
