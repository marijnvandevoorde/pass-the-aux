import test from "node:test";
import assert from "node:assert/strict";
import { SearchRemote } from "../../src/application/search-remote.ts";
import {
  InvalidRequestError,
  RemoteDisabledError,
} from "../../src/domain/errors.ts";
import type {
  RemoteAudio,
  RemoteSource,
} from "../../src/domain/ports/remote-source.ts";

function fakeSource(enabled: boolean): {
  resolve: () => Promise<RemoteSource | null>;
  calls: Array<{ query: string; offset: number }>;
} {
  const calls: Array<{ query: string; offset: number }> = [];
  const source: RemoteSource = {
    id: "fake",
    displayName: "Fake",
    enabled,
    async search(query, offset = 0) {
      calls.push({ query, offset });
      return { items: [], total: 0, offset };
    },
    download(): Promise<RemoteAudio> {
      throw new Error("not used here");
    },
  };
  return { resolve: async () => source, calls };
}

test("a disabled source rejects with RemoteDisabledError", async () => {
  const { resolve } = fakeSource(false);
  const uc = new SearchRemote(resolve);
  assert.equal(await uc.enabled(), false);
  await assert.rejects(uc.execute("daft punk"), RemoteDisabledError);
});

test("a missing source rejects with RemoteDisabledError", async () => {
  const uc = new SearchRemote(async () => null);
  assert.equal(await uc.enabled(), false);
  await assert.rejects(uc.execute("daft punk"), RemoteDisabledError);
});

test("an empty or non-string query is rejected (400)", async () => {
  const { resolve } = fakeSource(true);
  const uc = new SearchRemote(resolve);
  await assert.rejects(uc.execute("   "), InvalidRequestError);
  await assert.rejects(uc.execute(undefined), InvalidRequestError);
  await assert.rejects(uc.execute(42), InvalidRequestError);
});

test("query is trimmed and offset normalised (floor, clamp, default 0)", async () => {
  const { resolve, calls } = fakeSource(true);
  const uc = new SearchRemote(resolve);

  await uc.execute("  daft punk  ");
  await uc.execute("x", "20");
  await uc.execute("x", -5);
  await uc.execute("x", 9999);
  await uc.execute("x", 12.9);

  assert.deepEqual(calls, [
    { query: "daft punk", offset: 0 },
    { query: "x", offset: 20 },
    { query: "x", offset: 0 },
    { query: "x", offset: 1000 },
    { query: "x", offset: 12 },
  ]);
});

test("enabled() reflects the resolved source", async () => {
  assert.equal(await new SearchRemote(fakeSource(true).resolve).enabled(), true);
  assert.equal(
    await new SearchRemote(fakeSource(false).resolve).enabled(),
    false,
  );
});
