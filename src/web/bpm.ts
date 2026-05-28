// Browser entry point for BPM analysis. The numeric core lives in the
// pure, unit-tested tempo-estimate module; here we just mix the decoded
// buffer down to mono and hand it over.

import { estimateTempo } from "./tempo-estimate.js";
import { estimateEnergy, estimateKey } from "./track-features.js";

function toMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0);
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  const mono = new Float32Array(buffer.length);
  for (let i = 0; i < mono.length; i++) {
    mono[i] = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
  }
  return mono;
}

export async function detectBPM(
  audioBuffer: AudioBuffer,
): Promise<number | null> {
  return estimateTempo(toMono(audioBuffer), audioBuffer.sampleRate);
}

export interface TrackFeatures {
  key: string | null;
  mode: string | null;
  camelot: string | null;
  energy: number | null;
}

/** Musical key + energy from the same decoded buffer (one extra pass). */
export function analyzeFeatures(audioBuffer: AudioBuffer): TrackFeatures {
  const mono = toMono(audioBuffer);
  const k = estimateKey(mono, audioBuffer.sampleRate);
  return {
    key: k?.key ?? null,
    mode: k?.mode ?? null,
    camelot: k?.camelot ?? null,
    energy: estimateEnergy(mono),
  };
}
