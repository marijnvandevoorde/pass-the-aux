import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../../src/infrastructure/config.ts";

test("storageDriver defaults to sqlite; only 'mysql' switches it", () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).storageDriver, "sqlite");
  assert.equal(
    loadConfig({ STORAGE_DRIVER: "MySQL" } as NodeJS.ProcessEnv)
      .storageDriver,
    "mysql",
  );
  // Anything unrecognised falls back to the default (sqlite).
  assert.equal(
    loadConfig({ STORAGE_DRIVER: "postgres" } as NodeJS.ProcessEnv)
      .storageDriver,
    "sqlite",
  );
});

test("registrationOpen is OFF by default; only truthy opens it", () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).registrationOpen, false);
  for (const v of ["1", "true", "on", "YES", " On "]) {
    assert.equal(
      loadConfig({ REGISTRATION_OPEN: v } as NodeJS.ProcessEnv)
        .registrationOpen,
      true,
      `"${v}" should open registration`,
    );
  }
  for (const v of ["", "0", "false", "off", "no", "nope"]) {
    assert.equal(
      loadConfig({ REGISTRATION_OPEN: v } as NodeJS.ProcessEnv)
        .registrationOpen,
      false,
      `"${v}" should keep registration closed`,
    );
  }
});

test("db config has sane defaults and reads DB_* env", () => {
  const d = loadConfig({} as NodeJS.ProcessEnv).db;
  assert.deepEqual(d, {
    host: "127.0.0.1",
    port: 3306,
    user: "passtheaux",
    password: "",
    database: "passtheaux",
  });
  const c = loadConfig({
    DB_HOST: "db.local",
    DB_PORT: "3307",
    DB_USER: "u",
    DB_PASSWORD: "p",
    DB_NAME: "n",
    SESSION_SECRET: "s3cret",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(c.db, {
    host: "db.local",
    port: 3307,
    user: "u",
    password: "p",
    database: "n",
  });
  assert.equal(c.sessionSecret, "s3cret");
});

test("library is on disk unless S3_BUCKET is set; then the rest is required", () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).s3, null);
  const s3 = loadConfig({
    S3_BUCKET: "music",
    S3_ENDPOINT: "https://s3.example.test",
    S3_REGION: "eu-amsterdam-1",
    S3_ACCESS_KEY_ID: "AK",
    S3_SECRET_ACCESS_KEY: "SK",
    S3_FORCE_PATH_STYLE: "true",
  } as NodeJS.ProcessEnv).s3;
  assert.deepEqual(s3, {
    bucket: "music",
    endpoint: "https://s3.example.test",
    region: "eu-amsterdam-1",
    accessKeyId: "AK",
    secretAccessKey: "SK",
    forcePathStyle: true,
  });
  assert.throws(
    () => loadConfig({ S3_BUCKET: "music" } as NodeJS.ProcessEnv),
    /S3_ENDPOINT/,
  );
});

test("pass-the-beat scaling is off unless a Deployment is named", () => {
  assert.equal(loadConfig({} as NodeJS.ProcessEnv).passTheBeatScaling, null);
  assert.deepEqual(
    loadConfig({
      PASS_THE_BEAT_K8S_DEPLOYMENT: "pass-the-beat",
      PASS_THE_BEAT_IDLE_SECONDS: "60",
    } as NodeJS.ProcessEnv).passTheBeatScaling,
    {
      deployment: "pass-the-beat",
      namespace: "",
      idleMs: 60_000,
      readyTimeoutMs: 900_000,
      backoffMs: 1_800_000,
    },
  );
});
