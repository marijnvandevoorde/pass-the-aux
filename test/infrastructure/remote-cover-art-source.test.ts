import test from "node:test";
import assert from "node:assert/strict";
import { RemoteCoverArtSource } from "../../src/infrastructure/remote-cover-art-source.ts";

const img = (b: number) => new Uint8Array([b, b, b]);

test("disabled or empty title → null, no provider hit", async () => {
  let called = 0;
  const p = async (): Promise<Uint8Array | null> => {
    called++;
    return img(1);
  };
  assert.equal(await new RemoteCoverArtSource(false, [p]).fetch("a", "t"), null);
  assert.equal(await new RemoteCoverArtSource(true, [p]).fetch("a", "  "), null);
  assert.equal(called, 0);
});

test("first provider that returns bytes wins; misses are skipped", async () => {
  const miss = async (): Promise<Uint8Array | null> => null;
  const boom = async (): Promise<Uint8Array | null> => {
    throw new Error("network");
  };
  const hit = async (): Promise<Uint8Array | null> => img(7);
  const got = await new RemoteCoverArtSource(true, [miss, boom, hit]).fetch(
    "Daft Punk",
    "Get Lucky",
  );
  assert.deepEqual(got, img(7));
});

test("providers are tried in a randomised order over many runs", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    let firstTried = "";
    const mk = (id: string) => async (): Promise<Uint8Array | null> => {
      if (!firstTried) firstTried = id;
      return null;
    };
    await new RemoteCoverArtSource(true, [mk("A"), mk("B"), mk("C")]).fetch(
      "x",
      "y",
    );
    seen.add(firstTried);
  }
  assert.ok(seen.size >= 2, `expected shuffling, first-tried set: ${[...seen]}`);
});
