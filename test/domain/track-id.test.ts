import test from "node:test";
import assert from "node:assert/strict";
import { TrackId } from "../../src/domain/track-id.ts";
import { ForbiddenPathError } from "../../src/domain/errors.ts";

test("TrackId accepts library-relative paths", () => {
  assert.equal(new TrackId("song.mp3").value, "song.mp3");
  assert.equal(new TrackId("crates/house/track.flac").value, "crates/house/track.flac");
  assert.equal(new TrackId("a\\b\\c.wav").value, "a/b/c.wav");
  assert.equal(new TrackId("  spaced.mp3  ").value, "spaced.mp3");
});

test("TrackId rejects traversal and absolute paths", () => {
  for (const bad of [
    "",
    "   ",
    "/etc/passwd",
    "../secret.mp3",
    "a/../../b.mp3",
    "..",
    "crates/..",
    "\\\\server\\share",
    123,
    null,
  ]) {
    assert.throws(
      () => new TrackId(bad as unknown),
      ForbiddenPathError,
      `should reject ${String(bad)}`,
    );
  }
});
