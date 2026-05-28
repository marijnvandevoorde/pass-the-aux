import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { FsLibraryWriter } from "../../src/infrastructure/fs-library-writer.ts";

const dir = (): Promise<string> =>
  fsp.mkdtemp(path.join(os.tmpdir(), "djm-w-"));
const src = (s: string): Readable => Readable.from(Buffer.from(s));

test("writes a sanitised file and returns its library path", async () => {
  const d = await dir();
  const p = await new FsLibraryWriter(d).write(
    src("AUDIO"),
    "Daft Punk - One More Time",
    "flac",
  );
  assert.equal(p, "Daft Punk - One More Time.flac");
  assert.equal(await fsp.readFile(path.join(d, p), "utf8"), "AUDIO");
  const leftover = (await fsp.readdir(d)).filter((f) =>
    f.startsWith(".import-"),
  );
  assert.deepEqual(leftover, []); // temp cleaned up by the atomic rename
});

test("colliding names get a numeric suffix", async () => {
  const d = await dir();
  const w = new FsLibraryWriter(d);
  const a = await w.write(src("1"), "Song", "mp3");
  const b = await w.write(src("2"), "Song", "mp3");
  const c = await w.write(src("3"), "Song", "mp3");
  assert.deepEqual(
    [a, b, c].sort(),
    ["Song (1).mp3", "Song (2).mp3", "Song.mp3"],
  );
  assert.equal(await fsp.readFile(path.join(d, "Song (2).mp3"), "utf8"), "3");
});

test("path-traversal names are neutralised and stay inside MUSIC_DIR", async () => {
  const d = await dir();
  const p = await new FsLibraryWriter(d).write(
    src("x"),
    "../../etc/passwd",
    "flac",
  );
  assert.ok(!p.includes("/") && !p.includes(path.sep));
  assert.ok((await fsp.readdir(d)).includes(p));
  const parent = await fsp.readdir(path.dirname(d));
  assert.ok(!parent.includes("passwd"));
});

test("empty/odd names fall back to 'track'; extension sanitised", async () => {
  const d = await dir();
  const p = await new FsLibraryWriter(d).write(src("x"), "   ...   ", "FLAC");
  assert.equal(p, "track.flac");
});
