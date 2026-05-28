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
