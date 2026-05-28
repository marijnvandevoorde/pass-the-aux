// Test-only helpers (NOT a test file — `_` prefix keeps it out of the
// `*.test.ts` glob). Builds a valid PNG with the stdlib alone so cover
// resize can be exercised end-to-end without a binary fixture.
import zlib from "node:zlib";
import { spawn } from "node:child_process";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!)! & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** A `w`×`h` solid mid-grey truecolor PNG. */
export function createPngBytes(w: number, h: number): Uint8Array {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const row = Buffer.alloc(1 + w * 3, 0x80); // filter byte 0 + grey pixels
  row[0] = 0;
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  const idat = zlib.deflateSync(raw);
  return new Uint8Array(
    Buffer.concat([
      sig,
      chunk("IHDR", ihdr),
      chunk("IDAT", idat),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

/** Whether `ffmpeg` is on PATH (resize tests skip cleanly if not). */
export function ffmpegAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const ff = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
    ff.on("error", () => resolve(false));
    ff.on("close", (code) => resolve(code === 0));
  });
}
