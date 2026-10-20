import { spawn } from "node:child_process";
import { waveformFromPcm, type Waveform } from "../domain/waveform.ts";
import type { WaveformSource } from "../domain/ports/waveform-source.ts";
import { fsLocalFiles, type LocalFiles } from "./ffmpeg-audio-analyzer.ts";

/** A low rate is plenty for a 120-slice loudness overview and keeps the
 *  decode small (5 min ≈ 2.4 MB of PCM). */
const SR = 2_000;

function decode(abs: string): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const ff = spawn(
      "ffmpeg",
      ["-v", "error", "-i", abs, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.on("error", reject); // ENOENT → ffmpeg not installed
    ff.on("close", (code) => {
      const buf = Buffer.concat(chunks);
      if (buf.byteLength < 4) {
        reject(new Error(`ffmpeg produced no audio (exit ${code})`));
        return;
      }
      const n = Math.floor(buf.byteLength / 4);
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4);
      resolve(new Float32Array(ab));
    });
  });
}

/** One decode at a time across the whole server: a crowd of phones
 *  opening the page must not start a pile of ffmpeg processes on the
 *  small node. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Overview waveform via ffmpeg (system binary). Null when the track
 *  can't be read or ffmpeg is missing. */
export class FfmpegWaveformSource implements WaveformSource {
  readonly #files: LocalFiles;

  constructor(source: string | LocalFiles) {
    this.#files = typeof source === "string" ? fsLocalFiles(source) : source;
  }

  async waveform(trackId: string): Promise<Waveform | null> {
    try {
      const pcm = await serial(() => this.#files.withFile(trackId, decode));
      if (pcm === null || pcm.length < SR) return null;
      return waveformFromPcm(pcm, SR);
    } catch {
      return null;
    }
  }
}
