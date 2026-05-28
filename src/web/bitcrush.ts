// Pure (DOM-free) bit-depth quantisation curve for a WaveShaperNode —
// a zero-dep bit-crusher (sample-rate reduction would need an
// AudioWorklet and is deferred). Unit-tested.

export function bitcrushCurve(
  bits: number,
  len = 4096,
): Float32Array<ArrayBuffer> {
  const b = Math.max(1, Math.min(16, Math.floor(bits)));
  const steps = Math.pow(2, b);
  const curve = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1; // -1..1 input
    const q = Math.round(((x + 1) / 2) * (steps - 1)) / (steps - 1);
    curve[i] = q * 2 - 1; // back to -1..1, quantised
  }
  return curve;
}
