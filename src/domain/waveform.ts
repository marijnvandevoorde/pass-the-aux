/**
 * A track's overview waveform: a short list of loudness levels, one per
 * slice of the track, for the mobile DJ and the crowd screen (which
 * play through <audio> / don't play at all, so they can't compute it
 * from a decoded buffer like the desktop decks do). A hundred numbers
 * keep it a few hundred bytes on a phone.
 */
export interface Waveform {
  durationSec: number;
  /** Loudness per slice in [0, 1], normalised to the track's loud parts. */
  peaks: number[];
}

/** Slices per waveform. Clients resample to their own bar count. */
export const WAVEFORM_BUCKETS = 120;

/**
 * Loudness per bucket from mono PCM. RMS rather than the sample peak:
 * mastered tracks hit full scale almost everywhere, so peaks draw a flat
 * block, while RMS shows breakdowns and drops. Normalised to the 95th
 * percentile (not the maximum) so one loud hit doesn't flatten the rest.
 */
export function waveformFromPcm(
  pcm: Float32Array,
  sampleRate: number,
  buckets = WAVEFORM_BUCKETS,
): Waveform {
  const durationSec = pcm.length / sampleRate;
  if (pcm.length === 0 || buckets <= 0) return { durationSec, peaks: [] };
  const n = Math.min(buckets, pcm.length);
  const rms = new Array<number>(n);
  for (let b = 0; b < n; b++) {
    const start = Math.floor((b * pcm.length) / n);
    const end = Math.max(start + 1, Math.floor(((b + 1) * pcm.length) / n));
    let sum = 0;
    for (let i = start; i < end; i++) {
      const v = pcm[i] ?? 0;
      sum += v * v;
    }
    rms[b] = Math.sqrt(sum / (end - start));
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const ref = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
  const peaks = rms.map((v) =>
    ref > 0 ? Math.round(Math.min(1, v / ref) * 100) / 100 : 0,
  );
  return { durationSec, peaks };
}
