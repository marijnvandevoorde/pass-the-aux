import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { FfmpegWaveformSource } from "../../src/infrastructure/ffmpeg-waveform-source.ts";
import { writeTinyWav } from "../fixtures/wav.ts";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

test("missing, non-audio and traversing paths give null (no throw)", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pta-wave-"));
  const src = new FfmpegWaveformSource(dir);
  assert.equal(await src.waveform("nope.mp3"), null);
  await fsp.writeFile(path.join(dir, "junk.mp3"), "not audio at all");
  assert.equal(await src.waveform("junk.mp3"), null);
  assert.equal(await src.waveform("../../etc/passwd"), null);
});

test("a real file decodes to levels and a duration", { skip: !hasFfmpeg && "ffmpeg not installed" }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "pta-wave-"));
  writeTinyWav(path.join(dir, "tone.wav"), 8000 * 3); // 3 s at 8 kHz
  const w = await new FfmpegWaveformSource(dir).waveform("tone.wav");
  assert.ok(w);
  assert.ok(Math.abs(w.durationSec - 3) < 0.05);
  assert.equal(w.peaks.length, 120);
  assert.ok(w.peaks.every((p) => p >= 0 && p <= 1));
});
