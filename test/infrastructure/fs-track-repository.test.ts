import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FsTrackRepository } from "../../src/infrastructure/fs-track-repository.ts";

async function library(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "djm-lib-"));
  await fsp.mkdir(path.join(dir, "house"), { recursive: true });
  await fsp.writeFile(path.join(dir, "a.mp3"), "x");
  await fsp.writeFile(path.join(dir, "notes.txt"), "x");
  await fsp.writeFile(path.join(dir, ".hidden.mp3"), "x");
  await fsp.writeFile(path.join(dir, "house", "b.wav"), "xx");
  await fsp.writeFile(path.join(dir, "house", "c.flac"), "xxx");
  return dir;
}

test("list returns only audio files, recursively, skipping hidden/non-audio", async () => {
  const dir = await library();
  const repo = new FsTrackRepository(dir);
  const ids = (await repo.list()).map((t) => t.id).sort();
  assert.deepEqual(ids, ["a.mp3", path.join("house", "b.wav"), path.join("house", "c.flac")]);
});

test("list reports the sub-directory in `dir`", async () => {
  const dir = await library();
  const tracks = await new FsTrackRepository(dir).list();
  const b = tracks.find((t) => t.name === "b.wav")!;
  assert.equal(b.dir, "house");
  assert.equal(b.ext, ".wav");
  assert.equal(b.size, 2);
});

test("findById resolves a valid track and rejects bad ones", async () => {
  const dir = await library();
  const repo = new FsTrackRepository(dir);
  assert.equal((await repo.findById("a.mp3"))?.name, "a.mp3");
  assert.equal(await repo.findById("notes.txt"), null);
  assert.equal(await repo.findById("missing.mp3"), null);
  assert.equal(await repo.findById("../../etc/passwd"), null);
});

test("an empty / missing directory yields no tracks", async () => {
  const repo = new FsTrackRepository(path.join(os.tmpdir(), "djm-does-not-exist-xyz"));
  assert.deepEqual(await repo.list(), []);
});
