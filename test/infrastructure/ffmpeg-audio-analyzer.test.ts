import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { FfmpegAudioAnalyzer } from "../../src/infrastructure/ffmpeg-audio-analyzer.ts";

test("path traversal is refused (null, no spawn)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "djm-an-"));
  const a = new FfmpegAudioAnalyzer(dir);
  assert.equal(await a.analyze("../../etc/passwd"), null);
});

test("a missing / non-audio file degrades to null (no throw)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "djm-an-"));
  const a = new FfmpegAudioAnalyzer(dir);
  // ffmpeg absent OR file missing OR not audio → all return null,
  // never throw (analysis is best-effort).
  assert.equal(await a.analyze("nope.mp3"), null);
  await fsp.writeFile(path.join(dir, "junk.mp3"), "not audio at all");
  assert.equal(await a.analyze("junk.mp3"), null);
});
