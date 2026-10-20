// DOM-free part of the bar waveform (waveform.ts), unit-tested.

/** Resample to `n` bars, taking the loudest slice under each bar so short
 *  drops survive the downsampling. */
export function resampleLevels(levels: readonly number[], n: number): number[] {
  if (levels.length === 0 || n <= 0) return [];
  const max = Math.max(...levels);
  const scale = max > 1 ? 100 : 1; // accept 0–1 or 0–100
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * levels.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / n));
    let m = 0;
    for (let j = a; j < b && j < levels.length; j++) m = Math.max(m, levels[j] ?? 0);
    out.push(Math.max(0, Math.min(1, m / scale)));
  }
  return out;
}
