import test from "node:test";
import assert from "node:assert/strict";
import { resizeCover } from "../../src/infrastructure/image-resize.ts";

test("non-image bytes degrade to the original (no throw)", async () => {
  // ffmpeg can't decode this → resizeCover must return the input
  // unchanged rather than reject (cover writes are best-effort).
  const junk = new Uint8Array([1, 2, 3, 4, 5]);
  const out = await resizeCover(junk);
  assert.deepEqual(out, junk);
});

test("empty input is returned as-is", async () => {
  const empty = new Uint8Array(0);
  const out = await resizeCover(empty);
  assert.equal(out.byteLength, 0);
});

test("a real PNG is shrunk and re-encoded smaller", async (t) => {
  // Build a 600x600 solid-colour PNG with zlib (stdlib) so the test
  // needs no fixture. Skips cleanly if ffmpeg isn't on this machine.
  const { createPngBytes, ffmpegAvailable } = await import(
    "./_png-fixture.ts"
  );
  if (!(await ffmpegAvailable())) {
    t.skip("ffmpeg not installed");
    return;
  }
  const big = createPngBytes(600, 600);
  const out = await resizeCover(big, 250);
  assert.notDeepEqual(out, big); // actually transcoded
  assert.ok(out.byteLength > 0);
  assert.ok(
    out.byteLength < big.byteLength,
    `expected resized (${out.byteLength}) < source (${big.byteLength})`,
  );
  // JPEG SOI marker — proves it re-encoded to JPEG.
  assert.equal(out[0], 0xff);
  assert.equal(out[1], 0xd8);
});
