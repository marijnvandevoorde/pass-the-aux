import { spawn } from "node:child_process";
import { safeResolve } from "./path-safety.ts";
// Pure, DOM-free DSP shared with the browser analyser — same
// algorithms, so server results match what the client computed.
import { estimateTempo } from "../web/tempo-estimate.ts";
import { estimateEnergy, estimateKey } from "../web/track-features.ts";
import { trackBeats } from "../web/beat-grid.ts";
import {
  BEAT_GRID_ANALYZER_VERSION,
  type BeatGrid,
} from "../domain/beat-grid.ts";
import type {
  AudioAnalyzer,
  AudioFeatures,
} from "../domain/ports/audio-analyzer.ts";

const SR = 22_050; // mono, plenty for tempo/key/energy; keeps DSP cheap

/** Decode any audio file to mono float32 PCM via ffmpeg (system
 *  binary). Rejects if ffmpeg is missing or the file isn't audio. */
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
      // copy into an aligned ArrayBuffer for Float32Array
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + n * 4);
      resolve(new Float32Array(ab));
    });
  });
}

/** Gives ffmpeg a local path for a track for the duration of `fn`
 *  (the file itself on disk; a temp copy for remote storage). Null when
 *  the track can't be reached. */
export interface LocalFiles {
  withFile<T>(id: string, fn: (abs: string) => Promise<T>): Promise<T | null>;
}

/** `LocalFiles` over a music directory on disk. */
export function fsLocalFiles(musicDir: string): LocalFiles {
  return {
    async withFile<T>(id: string, fn: (abs: string) => Promise<T>) {
      const abs = safeResolve(musicDir, id);
      return abs === null ? null : fn(abs);
    },
  };
}

export class FfmpegAudioAnalyzer implements AudioAnalyzer {
  readonly beatAnalyzerVersion = BEAT_GRID_ANALYZER_VERSION;
  readonly #files: LocalFiles;

  /** A music directory on disk, or any other `LocalFiles`. */
  constructor(source: string | LocalFiles) {
    this.#files = typeof source === "string" ? fsLocalFiles(source) : source;
  }

  /** Mono PCM of the track, or null when unreadable / not audio /
   *  ffmpeg absent. */
  async #pcm(trackId: string): Promise<Float32Array | null> {
    try {
      return await this.#files.withFile(trackId, decode);
    } catch {
      return null;
    }
  }

  async analyze(trackId: string): Promise<AudioFeatures | null> {
    const pcm = await this.#pcm(trackId);
    if (pcm === null) return null;
    if (pcm.length < SR) return null; // < 1 s — nothing reliable
    const k = estimateKey(pcm, SR);
    return {
      bpm: estimateTempo(pcm, SR) ?? null,
      key: k?.key ?? null,
      mode: k?.mode ?? null,
      camelot: k?.camelot ?? null,
      energy: estimateEnergy(pcm),
    };
  }

  async analyzeBeats(
    trackId: string,
  ): Promise<Omit<BeatGrid, "analyzedAt"> | null> {
    const pcm = await this.#pcm(trackId);
    if (pcm === null) return null;
    if (pcm.length < SR) return null;
    const bpm = estimateTempo(pcm, SR);
    if (bpm === null) return null;
    const result = trackBeats(pcm, SR, bpm);
    if (result === null) return null;
    return {
      trackId,
      durationSec: pcm.length / SR,
      beats: result.beats,
      downbeatPhase: result.downbeatPhase,
      firstSolidBeatIndex: result.firstSolidBeatIndex,
      confidence: result.confidence,
      analyzerVersion: BEAT_GRID_ANALYZER_VERSION,
    };
  }
}
