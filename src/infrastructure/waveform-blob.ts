import type { Waveform } from "../domain/waveform.ts";

/** Levels are in [0, 1] at two decimals, so one byte (0–100) each keeps
 *  a waveform at ~120 bytes and round-trips exactly. */
export function packPeaks(peaks: readonly number[]): Buffer {
  const buf = Buffer.alloc(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    buf[i] = Math.max(0, Math.min(100, Math.round((peaks[i] ?? 0) * 100)));
  }
  return buf;
}

/** Null when the blob is empty or unreadable. */
export function unpackWaveform(durationSec: unknown, blob: Uint8Array | null | undefined): Waveform | null {
  const d = Number(durationSec);
  if (!blob || blob.byteLength === 0 || !Number.isFinite(d) || d < 0) return null;
  const peaks: number[] = [];
  for (const b of blob) peaks.push(Math.min(100, b) / 100);
  return { durationSec: d, peaks };
}
