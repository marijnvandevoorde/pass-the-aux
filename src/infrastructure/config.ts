import path from "node:path";
import { fileURLToPath } from "node:url";
import type { S3Settings } from "./s3-bucket.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface Config {
  host: string;
  port: number;
  musicDir: string;
  bodyLimitBytes: number;
  /** Public base URL for crowd-join links/QR. Default the app
   *  itself; override for LAN/tunnel. */
  publicBaseUrl: string;
  /** Which persistence backend to wire. Exactly one — no fallback.
   *  `sqlite` (default) = a single node:sqlite file, zero runtime deps;
   *  `mysql` = the mysql2 adapter. */
  storageDriver: "sqlite" | "mysql";
  /** MySQL connection (only meaningful when storageDriver === "mysql"). */
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** Filesystem path of the SQLite database (only meaningful when
   *  storageDriver === "sqlite"). Defaults to a `.pass-the-aux.sqlite`
   *  next to the music folder. */
  sqlitePath: string;
  /** HMAC key for signed session cookies + TOTP secret encryption
   * . Empty until SESSION_SECRET is set. */
  sessionSecret: string;
  /** Fetch missing covers from free external sources at analysis time
   *  (iTunes/Deezer/Cover Art Archive). Default on; COVER_LOOKUP=off
   *  to disable all network cover lookups. */
  coverLookup: boolean;
  /** Allow self-service account creation. Default OFF: the register
   *  endpoint 403s and the login page hides the "create account"
   *  link. REGISTRATION_OPEN=1|true|on|yes to open it. */
  registrationOpen: boolean;
  /** Which engine enriches `analysis` + `beat_grids`. `local`
   *  = the in-house ffmpeg + Ellis-DP DSP (zero-dep, default);
   *  `pass-the-beat` = the self-hosted pass-the-beat sidecar, which
   *  wraps the beat-this model (better beat-grid recall). */
  beatAnalyzer: "local" | "pass-the-beat";
  /** Base URL of the pass-the-beat sidecar (only used when
   *  beatAnalyzer === "pass-the-beat"). */
  passTheBeatUrl: string;
  /** Run pass-the-beat on demand: the Kubernetes Deployment this app
   *  scales to 1 when tracks need a grid and back to 0 when idle. Null
   *  (the default) = the sidecar is assumed to be running all the time. */
  passTheBeatScaling: {
    deployment: string;
    /** Empty = this pod's own namespace. */
    namespace: string;
    idleMs: number;
    readyTimeoutMs: number;
    backoffMs: number;
  } | null;
  /** Where the music library lives. Null = `musicDir` on disk; set =
   *  an S3-compatible bucket (keys `<uid>/<file>`, same layout). */
  s3: S3Settings | null;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function pickStorageDriver(raw: string | undefined): Config["storageDriver"] {
  return (raw ?? "").trim().toLowerCase() === "mysql" ? "mysql" : "sqlite";
}

/** Loads a .env file into process.env if present (optional). */
export function loadEnv(file: string = process.env.ENV_FILE ?? path.join(ROOT, ".env")): void {
  try {
    process.loadEnvFile(file);
  } catch {
    // .env is optional — real environments inject vars directly.
  }
}

/** Builds the validated, immutable runtime configuration from the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const musicDir = path.resolve(env.MUSIC_DIR ?? path.join(ROOT, "music"));
  return Object.freeze({
    host: env.HOST ?? "0.0.0.0",
    port: positiveInt(env.PORT, 5174),
    musicDir,
    bodyLimitBytes: positiveInt(env.BODY_LIMIT_BYTES, 1_000_000),
    publicBaseUrl:
      (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "") ||
      "http://localhost:5174",
    storageDriver: pickStorageDriver(env.STORAGE_DRIVER),
    db: {
      host: (env.DB_HOST ?? "").trim() || "127.0.0.1",
      port: positiveInt(env.DB_PORT, 3306),
      user: (env.DB_USER ?? "").trim() || "passtheaux",
      password: env.DB_PASSWORD ?? "",
      database: (env.DB_NAME ?? "").trim() || "passtheaux",
    },
    sqlitePath: path.resolve(
      (env.SQLITE_PATH ?? "").trim() ||
        path.join(musicDir, ".pass-the-aux.sqlite"),
    ),
    sessionSecret: env.SESSION_SECRET ?? "",
    coverLookup: !["0", "false", "off", "no"].includes(
      (env.COVER_LOOKUP ?? "").trim().toLowerCase(),
    ),
    registrationOpen: ["1", "true", "on", "yes"].includes(
      (env.REGISTRATION_OPEN ?? "").trim().toLowerCase(),
    ),
    beatAnalyzer:
      (env.BEAT_ANALYZER ?? "").trim().toLowerCase() === "pass-the-beat"
        ? "pass-the-beat"
        : "local",
    passTheBeatUrl:
      (env.PASS_THE_BEAT_URL ?? "").trim().replace(/\/+$/, "") ||
      "http://pass-the-beat:8000",
    passTheBeatScaling: (env.PASS_THE_BEAT_K8S_DEPLOYMENT ?? "").trim()
      ? {
          deployment: (env.PASS_THE_BEAT_K8S_DEPLOYMENT ?? "").trim(),
          namespace: (env.PASS_THE_BEAT_K8S_NAMESPACE ?? "").trim(),
          idleMs: positiveInt(env.PASS_THE_BEAT_IDLE_SECONDS, 120) * 1000,
          readyTimeoutMs:
            positiveInt(env.PASS_THE_BEAT_READY_TIMEOUT_SECONDS, 900) * 1000,
          backoffMs: positiveInt(env.PASS_THE_BEAT_BACKOFF_SECONDS, 1800) * 1000,
        }
      : null,
    s3: loadS3(env),
  });
}

/** S3 settings when S3_BUCKET is set; the rest is then required. */
function loadS3(env: NodeJS.ProcessEnv): S3Settings | null {
  const bucket = (env.S3_BUCKET ?? "").trim();
  if (bucket === "") return null;
  const need = (name: string): string => {
    const v = (env[name] ?? "").trim();
    if (v === "") throw new Error(`S3_BUCKET is set but ${name} is empty`);
    return v;
  };
  return {
    bucket,
    endpoint: need("S3_ENDPOINT"),
    region: (env.S3_REGION ?? "").trim() || "us-east-1",
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    forcePathStyle: ["1", "true", "on", "yes"].includes(
      (env.S3_FORCE_PATH_STYLE ?? "").trim().toLowerCase(),
    ),
  };
}
