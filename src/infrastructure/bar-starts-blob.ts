import { validBarStarts } from "../domain/beat-grid.ts";

/** Per-bar downbeat indices as a packed Int32-LE blob (4 bytes per bar);
 *  null when the grid has none (bars follow `downbeat_phase`). */
export function packBarStarts(bars: Int32Array | null | undefined): Buffer | null {
  if (!bars || bars.length === 0) return null;
  const buf = Buffer.allocUnsafe(bars.length * 4);
  for (let i = 0; i < bars.length; i++) buf.writeInt32LE(bars[i]!, i * 4);
  return buf;
}

/** Inverse of {@link packBarStarts}. A missing, truncated or inconsistent
 *  blob reads as null, so a bad row degrades to the 4/4 phase. */
export function unpackBarStarts(
  blob: Uint8Array | null | undefined,
  beatCount: number,
): Int32Array | null {
  if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) return null;
  const buf = Buffer.from(blob.buffer, blob.byteOffset, blob.byteLength);
  const out: number[] = [];
  for (let i = 0; i < buf.byteLength; i += 4) out.push(buf.readInt32LE(i));
  return validBarStarts(out, beatCount);
}
