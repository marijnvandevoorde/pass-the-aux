import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsCoverStore } from "../../src/infrastructure/fs-cover-store.ts";

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "djm-cover-"));
}

test("write/has/read round-trips as <base>.jpg next to the mp3", async () => {
  const dir = await tmp();
  const s = new FsCoverStore(dir);
  assert.equal(await s.has("Queen - X.mp3"), false);
  assert.equal(await s.read("Queen - X.mp3"), null);

  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  await s.write("Queen - X.mp3", bytes);
  assert.equal(await s.has("Queen - X.mp3"), true);
  assert.deepEqual(await s.read("Queen - X.mp3"), bytes);
  // stored beside the mp3 with a .jpg extension
  assert.ok(
    await fsp
      .access(path.join(dir, "Queen - X.jpg"))
      .then(() => true)
      .catch(() => false),
  );
});

test("path traversal ids are refused (null, no write)", async () => {
  const dir = await tmp();
  const s = new FsCoverStore(dir);
  await s.write("../escape.mp3", new Uint8Array([1]));
  assert.equal(await s.has("../escape.mp3"), false);
  assert.equal(await s.read("../escape.mp3"), null);
});
