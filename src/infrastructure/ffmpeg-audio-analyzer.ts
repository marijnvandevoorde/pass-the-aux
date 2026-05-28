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

export class FfmpegAudioAnalyzer implements AudioAnalyzer {
  readonly beatAnalyzerVersion = BEAT_GRID_ANALYZER_VERSION;
  readonly #musicDir: string;

  constructor(musicDir: string) {
    this.#musicDir = musicDir;
  }

  async analyze(trackId: string): Promise<AudioFeatures | null> {
    const abs = safeResolve(this.#musicDir, trackId);
    if (abs === null) return null;
    let pcm: Float32Array;
    try {
      pcm = await decode(abs);
    } catch {
      return null; // unreadable / not audio / ffmpeg absent
    }
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
    const abs = safeResolve(this.#musicDir, trackId);
    if (abs === null) return null;
    let pcm: Float32Array;
    try {
      pcm = await decode(abs);
    } catch {
      return null;
    }
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
