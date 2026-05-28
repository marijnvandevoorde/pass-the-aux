import test from "node:test";
import assert from "node:assert/strict";
import { GetCover } from "../../src/application/get-cover.ts";
import { ForbiddenPathError } from "../../src/domain/errors.ts";
import type { TagReader } from "../../src/domain/ports/tag-reader.ts";

function reader(cover: { mime: string; data: Uint8Array } | null): TagReader {
  return { read: async () => null, readCover: async () => cover };
}

test("returns the cover art for a valid path", async () => {
  const art = { mime: "image/png", data: new Uint8Array([1, 2, 3]) };
  const got = await new GetCover(reader(art)).execute("house/a.mp3");
  assert.deepEqual(got, art);
});

test("returns null when the track has no embedded art", async () => {
  assert.equal(await new GetCover(reader(null)).execute("a.mp3"), null);
});

test("rejects a traversal path before reading", async () => {
  await assert.rejects(
    () => new GetCover(reader(null)).execute("../../etc/passwd"),
    ForbiddenPathError,
  );
});

test("a stored cover JPG is preferred over embedded art", async () => {
  const embedded = { mime: "image/png", data: new Uint8Array([9]) };
  const stored = new Uint8Array([1, 2, 3, 4]);
  const store = {
    has: async () => true,
    read: async () => stored,
    write: async () => {},
  };
  const got = await new GetCover(reader(embedded), store).execute("a.mp3");
  assert.deepEqual(got, { mime: "image/jpeg", data: stored });
});

test("falls back to embedded art when nothing is stored", async () => {
  const embedded = { mime: "image/jpeg", data: new Uint8Array([5]) };
  const store = {
    has: async () => false,
    read: async () => null,
    write: async () => {},
  };
  assert.deepEqual(
    await new GetCover(reader(embedded), store).execute("a.mp3"),
    embedded,
  );
});
