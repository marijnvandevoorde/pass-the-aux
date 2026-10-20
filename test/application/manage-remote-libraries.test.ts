import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ManageRemoteLibraries } from "../../src/application/manage-remote-libraries.ts";
import { ensureSchema } from "../../src/infrastructure/sqlite-pool.ts";
import { SqliteRemoteLibrariesRepository } from "../../src/infrastructure/sqlite-remote-libraries-repository.ts";
import { SqliteUserRepository } from "../../src/infrastructure/sqlite-user-repository.ts";
import {
  InvalidRequestError,
  NotFoundError,
  PlanRequiredError,
} from "../../src/domain/errors.ts";
import {
  FREE_PLAN,
  type UserRecord,
} from "../../src/domain/ports/user-repository.ts";

function userWithPlan(id: string, plan: string): UserRecord {
  return {
    id,
    username: id,
    pwSalt: "s",
    pwHash: "h",
    totpSecret: null,
    totpEnabled: false,
    recoveryCodes: null,
    plan,
    createdAt: 0,
  };
}

async function setup(): Promise<{
  uc: ManageRemoteLibraries;
  users: SqliteUserRepository;
  cleanup: () => Promise<void>;
}> {
  // Each test gets its own in-memory DB so state doesn't leak.
  const db = new DatabaseSync(":memory:");
  ensureSchema(db);
  const repo = new SqliteRemoteLibrariesRepository(db);
  const users = new SqliteUserRepository(db);
  return {
    uc: new ManageRemoteLibraries(repo, users),
    users,
    cleanup: async () => db.close(),
  };
}

test("first remote becomes active automatically", async () => {
  const { uc, cleanup } = await setup();
  try {
    const a = await uc.add("u1", {
      kind: "pta",
      name: "Marc's NAS",
      baseUrl: "http://nas.local",
      apiKey: "secret",
    });
    assert.equal(a.isActive, true);
    const list = await uc.list("u1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, a.id);
  } finally {
    await cleanup();
  }
});

test("setActive enforces exactly-one-active per user", async () => {
  const { uc, cleanup } = await setup();
  try {
    const a = await uc.add("u1", {
      kind: "pta",
      name: "First",
      baseUrl: "http://a.local",
      apiKey: "s1",
    });
    const b = await uc.add("u1", {
      kind: "pta",
      name: "Second",
      baseUrl: "http://b.local",
      apiKey: "s2",
    });
    assert.equal(a.isActive, true);
    assert.equal(b.isActive, false);

    await uc.setActive("u1", b.id);
    const list = await uc.list("u1");
    const active = list.filter((r) => r.isActive);
    assert.equal(active.length, 1);
    assert.equal(active[0]!.id, b.id);
  } finally {
    await cleanup();
  }
});

test("deleting the active remote promotes the oldest remaining one", async () => {
  const { uc, cleanup } = await setup();
  try {
    const a = await uc.add("u1", {
      kind: "pta",
      name: "First",
      baseUrl: "http://a.local",
      apiKey: "s1",
    });
    const b = await uc.add("u1", {
      kind: "pta",
      name: "Second",
      baseUrl: "http://b.local",
      apiKey: "s2",
    });
    await uc.delete("u1", a.id);
    const list = await uc.list("u1");
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, b.id);
    assert.equal(list[0]!.isActive, true);
  } finally {
    await cleanup();
  }
});

test("pta kind requires baseUrl + apiKey; jamendo requires apiKey only", async () => {
  const { uc, cleanup } = await setup();
  try {
    await assert.rejects(
      uc.add("u1", { kind: "pta", name: "x", apiKey: "s" }),
      InvalidRequestError,
    );
    await assert.rejects(
      uc.add("u1", { kind: "pta", name: "x", baseUrl: "http://a" }),
      InvalidRequestError,
    );
    await assert.rejects(
      uc.add("u1", { kind: "pta", name: "x", baseUrl: "ftp://a", apiKey: "s" }),
      InvalidRequestError,
    );
    await assert.rejects(
      uc.add("u1", { kind: "jamendo", name: "j" }),
      InvalidRequestError,
    );
    // Jamendo OK with just apiKey
    const j = await uc.add("u1", {
      kind: "jamendo",
      name: "j",
      apiKey: "client-id",
    });
    assert.equal(j.kind, "jamendo");
  } finally {
    await cleanup();
  }
});

test("apiKey is never returned in the public shape", async () => {
  const { uc, cleanup } = await setup();
  try {
    const row = await uc.add("u1", {
      kind: "pta",
      name: "x",
      baseUrl: "http://a.local",
      apiKey: "secret-secret",
    });
    assert.equal("apiKey" in row, false);
    const list = await uc.list("u1");
    for (const r of list) assert.equal("apiKey" in r, false);
  } finally {
    await cleanup();
  }
});

test("free plan cannot add a remote (incl. jamendo); paid plan can", async () => {
  const { uc, users, cleanup } = await setup();
  try {
    await users.create(userWithPlan("free-user", FREE_PLAN));
    await users.create(userWithPlan("pro-user", "pro"));

    assert.equal(await uc.canManage("free-user"), false);
    assert.equal(await uc.canManage("pro-user"), true);

    await assert.rejects(
      uc.add("free-user", {
        kind: "pta",
        name: "NAS",
        baseUrl: "http://a.local",
        apiKey: "s",
      }),
      PlanRequiredError,
    );
    await assert.rejects(
      uc.add("free-user", { kind: "jamendo", name: "J", apiKey: "id" }),
      PlanRequiredError,
    );

    const ok = await uc.add("pro-user", {
      kind: "jamendo",
      name: "J",
      apiKey: "id",
    });
    assert.equal(ok.kind, "jamendo");
  } finally {
    await cleanup();
  }
});

test("no user record (auth-disabled / legacy) is not plan-gated", async () => {
  const { uc, cleanup } = await setup();
  try {
    assert.equal(await uc.canManage(""), true);
    const row = await uc.add("", {
      kind: "pta",
      name: "Legacy",
      baseUrl: "http://a.local",
      apiKey: "s",
    });
    assert.equal(row.isActive, true);
  } finally {
    await cleanup();
  }
});

test("users are isolated from each other", async () => {
  const { uc, cleanup } = await setup();
  try {
    await uc.add("u1", {
      kind: "pta",
      name: "u1 remote",
      baseUrl: "http://a",
      apiKey: "s",
    });
    await uc.add("u2", {
      kind: "pta",
      name: "u2 remote",
      baseUrl: "http://b",
      apiKey: "s",
    });
    const l1 = await uc.list("u1");
    const l2 = await uc.list("u2");
    assert.equal(l1.length, 1);
    assert.equal(l2.length, 1);
    assert.notEqual(l1[0]!.id, l2[0]!.id);
    await assert.rejects(
      uc.delete("u1", l2[0]!.id), // can't delete u2's row
      NotFoundError,
    );
  } finally {
    await cleanup();
  }
});

test("test connection: saved store uses its stored secret; form values override", async () => {
  const db = new DatabaseSync(":memory:");
  ensureSchema(db);
  const repo = new SqliteRemoteLibrariesRepository(db);
  const seen: Array<{ baseUrl: string | null; apiKey: string | null }> = [];
  const uc = new ManageRemoteLibraries(repo, new SqliteUserRepository(db), (row) => ({
    id: row.id,
    displayName: row.name,
    enabled: true,
    async search() {
      return { items: [], total: 0, offset: 0 };
    },
    async download(): Promise<never> {
      throw new Error("unused");
    },
    async check() {
      seen.push({ baseUrl: row.baseUrl, apiKey: row.apiKey });
      return { ok: row.apiKey === "right", message: "m", tracks: null, indexing: false };
    },
  }));
  try {
    const saved = await uc.add("u1", { kind: "pta", name: "NAS", baseUrl: "http://nas.local", apiKey: "right" });
    assert.equal((await uc.test("u1", { id: saved.id })).ok, true);
    // Editing: a blank secret keeps the stored one, a typed one is tested.
    assert.equal((await uc.test("u1", { id: saved.id, apiKey: "" })).ok, true);
    assert.equal((await uc.test("u1", { id: saved.id, apiKey: "wrong" })).ok, false);
    // Unsaved form values.
    assert.equal((await uc.test("u1", { kind: "pta", baseUrl: "http://x.local", apiKey: "right" })).ok, true);
    assert.deepEqual(seen.at(-1), { baseUrl: "http://x.local", apiKey: "right" });
    // Missing fields are a result, not an exception.
    const missing = await uc.test("u1", { kind: "pta", baseUrl: "http://x.local" });
    assert.equal(missing.ok, false);
    assert.match(missing.message, /secret/);
    // Someone else's store isn't found.
    await assert.rejects(uc.test("u2", { id: saved.id }), NotFoundError);
    await assert.rejects(uc.test("u1", { kind: "nope" }), InvalidRequestError);
  } finally {
    db.close();
  }
});

test("test connection: sources without check() are tested with a search", async () => {
  const db = new DatabaseSync(":memory:");
  ensureSchema(db);
  const uc = new ManageRemoteLibraries(
    new SqliteRemoteLibrariesRepository(db),
    new SqliteUserRepository(db),
    (row) =>
      row.kind === "fma"
        ? null
        : {
            id: row.id,
            displayName: row.name,
            enabled: true,
            async search() {
              if (row.apiKey !== "good") throw new Error("remote library: HTTP 401");
              return { items: [], total: 0, offset: 0 };
            },
            async download(): Promise<never> {
              throw new Error("unused");
            },
          },
  );
  try {
    assert.deepEqual(await uc.test("u1", { kind: "jamendo", apiKey: "good" }), {
      ok: true, message: "Connected", tracks: null, indexing: false,
    });
    assert.deepEqual(await uc.test("u1", { kind: "jamendo", apiKey: "bad" }), {
      ok: false, message: "HTTP 401", tracks: null, indexing: false,
    });
    assert.match((await uc.test("u1", { kind: "fma", apiKey: "k" })).message, /isn't supported/);
  } finally {
    db.close();
  }
});
