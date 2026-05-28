// Pure (DOM-free) granular pitch shifter so it can be unit-tested under
// node:test. Classic overlap-add resampling: lay down fixed-length
// Hann-windowed grains at a constant synthesis hop; inside each grain the
// input is read with step `shift`, which changes pitch without changing
// duration. shift = 1 ≈ identity; shift > 1 raises pitch, < 1 lowers it.
//
// The analysis cursor deliberately *trails* the write cursor (a few grains
// of latency) so a grain only ever reads input that has already arrived —
// reading ahead would emit silence.
//
// In the deck this cancels the vinyl pitch change: a buffer played at
// playbackRate `r` is pitched up by `r`, so shift `1/r` restores pitch
// while tempo still tracks `r`.

const GRAIN = 1024;
const HOP = GRAIN / 4; // 75% overlap
const OLA_LEN = GRAIN * 4;

function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return w;
}

/**
 * Streaming, block-based granular pitch shifter for one channel. State
 * persists across `process` calls so it can drive an AudioWorklet, but it
 * has no Web Audio / DOM dependency.
 */
export class GrainShifter {
  #shift: number;
  readonly #ring: Float32Array;
  readonly #win = hann(GRAIN);
  readonly #ola = new Float32Array(OLA_LEN);
  readonly #olaWin = new Float32Array(OLA_LEN);
  #writeCount = 0; // total input samples written
  #aPos = 0; // analysis read base (absolute input index), trails write
  #sinceHop = 0; // input samples since the last grain
  #head = 0; // absolute output index (drain cursor)

  constructor(shift = 1, ringSize = 1 << 16) {
    this.#shift = this.#clamp(shift);
    this.#ring = new Float32Array(ringSize);
  }

  #clamp(shift: number): number {
    return Math.min(4, Math.max(0.25, shift || 1)); // ±2 octaves
  }

  setShift(shift: number): void {
    this.#shift = this.#clamp(shift);
  }

  #sample(pos: number): number {
    const ring = this.#ring;
    const n = ring.length;
    const i = Math.floor(pos);
    const frac = pos - i;
    const a = ring[((i % n) + n) % n]!;
    const b = ring[(((i + 1) % n) + n) % n]!;
    return a + (b - a) * frac;
  }

  #spawnGrain(): void {
    // Only emit once enough past input is buffered to fill the grain.
    if (this.#aPos + Math.ceil(GRAIN * this.#shift) > this.#writeCount) return;
    const win = this.#win;
    for (let k = 0; k < GRAIN; k++) {
      const s = this.#sample(this.#aPos + k * this.#shift) * win[k]!;
      const idx = (this.#head + k) % OLA_LEN;
      this.#ola[idx]! += s;
      this.#olaWin[idx]! += win[k]!;
    }
    this.#aPos += HOP; // matches the synthesis hop → no drift
  }

  /** Pitch-shift one block; output length equals input length. */
  process(input: Float32Array): Float32Array {
    const out = new Float32Array(input.length);
    const ring = this.#ring;
    const n = ring.length;
    for (let i = 0; i < input.length; i++) {
      ring[this.#writeCount % n] = input[i]!;
      this.#writeCount++;

      if (this.#sinceHop === 0) this.#spawnGrain();
      this.#sinceHop = (this.#sinceHop + 1) % HOP;

      const h = this.#head % OLA_LEN;
      const w = this.#olaWin[h]!;
      out[i] = w > 1e-6 ? this.#ola[h]! / w : 0;
      this.#ola[h] = 0;
      this.#olaWin[h] = 0;
      this.#head++;
    }
    return out;
  }
}
