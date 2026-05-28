import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FsLibraryWatcher,
  isRelevantChange,
} from "../../src/infrastructure/fs-library-watcher.ts";

// The fs.watch binding itself is an environment-dependent I/O seam (left
// untested like other platform I/O); the decision logic is pure and is
// covered here deterministically.

test("isRelevantChange ignores sidecars and dotfiles, accepts audio", () => {
  assert.equal(isRelevantChange("song.mp3"), true);
  assert.equal(isRelevantChange("sub/dir/track.flac"), true);
  assert.equal(isRelevantChange(".pass-the-aux-cache.json"), false);
  assert.equal(isRelevantChange(".pass-the-aux-crates.json"), false);
  assert.equal(isRelevantChange(".DS_Store"), false);
  assert.equal(isRelevantChange(null), false);
  assert.equal(isRelevantChange(""), false);
});

test("unsubscribe stops delivery and is safe to call twice", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "djm-watch-"));
  const watcher = new FsLibraryWatcher(dir);
  let calls = 0;
  const off = watcher.subscribe(() => calls++);
  off();
  off();
  await fsp.writeFile(path.join(dir, "later.wav"), "x");
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(calls, 0);
});

test("a missing directory degrades quietly (no throw on subscribe)", () => {
  const watcher = new FsLibraryWatcher(path.join(os.tmpdir(), "nope-djm-xyz"));
  const off = watcher.subscribe(() => {});
  off();
  assert.ok(true);
});
