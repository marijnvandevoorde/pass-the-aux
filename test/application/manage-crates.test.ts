import test from "node:test";
import assert from "node:assert/strict";
import { ManageCrates } from "../../src/application/manage-crates.ts";
import {
  ForbiddenPathError,
  InvalidRequestError,
} from "../../src/domain/errors.ts";
import type { CrateRepository } from "../../src/domain/ports/crate-repository.ts";

function setup(seed: Record<string, string[]> = {}) {
  const store: Record<string, string[]> = { ...seed };
  const repo: CrateRepository = {
    all: async () => ({ ...store }),
    put: async (_userId, name, ids) => {
      store[name] = ids;
    },
    remove: async (_userId, name) => {
      delete store[name];
    },
  };
  return { useCase: new ManageCrates(repo), store };
}

test("save persists a trimmed crate and reports the count", async () => {
  const { useCase, store } = setup();
  const result = await useCase.save("  Friday Set  ", ["a.mp3", "b/c.wav"]);
  assert.deepEqual(result, { name: "Friday Set", count: 2 });
  assert.deepEqual(store["Friday Set"], ["a.mp3", "b/c.wav"]);
});

test("save rejects an empty name without touching the repo", async () => {
  const { useCase, store } = setup();
  await assert.rejects(() => useCase.save("   ", ["a.mp3"]), InvalidRequestError);
  assert.deepEqual(store, {});
});

test("save rejects a traversal track id", async () => {
  const { useCase } = setup();
  await assert.rejects(
    () => useCase.save("x", ["../../etc/passwd"]),
    ForbiddenPathError,
  );
});

test("list returns crates sorted by name", async () => {
  const { useCase } = setup({ zeta: ["z.mp3"], alpha: ["a.mp3"] });
  const list = await useCase.list();
  assert.deepEqual(
    list.map((c) => c.name),
    ["alpha", "zeta"],
  );
});

test("remove deletes the crate; empty name is rejected", async () => {
  const { useCase, store } = setup({ keep: ["a.mp3"], drop: ["b.mp3"] });
  await assert.rejects(() => useCase.remove(""), InvalidRequestError);
  assert.deepEqual(await useCase.remove("drop"), { name: "drop" });
  assert.deepEqual(Object.keys(store), ["keep"]);
});
