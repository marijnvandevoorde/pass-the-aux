import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ManageRemoteLibraries } from "../../src/application/manage-remote-libraries.ts";
import { ensureSchema } from "../../src/infrastructure/sqlite-pool.ts";
import { SqliteRemoteLibrariesRepository } from "../../src/infrastructure/sqlite-remote-libraries-repository.ts";
import {
  InvalidRequestError,
  NotFoundError,
} from "../../src/domain/errors.ts";

async function setup(): Promise<{
  uc: ManageRemoteLibraries;
  cleanup: () => Promise<void>;
}> {
  // Each test gets its own in-memory DB so state doesn't leak.
  const db = new DatabaseSync(":memory:");
  ensureSchema(db);
  const repo = new SqliteRemoteLibrariesRepository(db);
  return {
    uc: new ManageRemoteLibraries(repo),
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
