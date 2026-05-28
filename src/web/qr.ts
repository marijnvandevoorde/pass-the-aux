// Pure (DOM-free), zero-dependency QR encoder — enough for a short
// crowd-join URL: byte mode, error-correction level L, versions 1–4
// (single EC block), fixed mask 0 (a valid QR mask; any scanner reads
// it). Returns a boolean module matrix; rendering is the caller's job.
// Unit-tested for structure (size + finder patterns).

// --- GF(256) for Reed–Solomon (primitive poly 0x11d) ----------------
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();
const mul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!;

function rsGenerator(deg: number): number[] {
  let g = [1];
  for (let i = 0; i < deg; i++) {
    const ng = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      ng[j] = (ng[j] ?? 0) ^ mul(g[j]!, EXP[i]!);
      ng[j + 1] = (ng[j + 1] ?? 0) ^ g[j]!;
    }
    g = ng;
  }
  return g;
}

function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0]!;
    res.shift();
    res.push(0);
    // `res[i]` holds the x^(ecLen-1-i) term after the shift, so it pairs
    // with the generator's x^(ecLen-1-i) coefficient — `gen` runs
    // low-to-high degree, hence the reversed index.
    for (let i = 0; i < ecLen; i++) {
      res[i] = (res[i] ?? 0) ^ mul(gen[ecLen - 1 - i]!, factor);
    }
  }
  return res;
}

// version → { size, dataCw, ecCw } for ECC level L, single block.
const SPEC = [
  { v: 1, size: 21, data: 19, ec: 7 },
  { v: 2, size: 25, data: 34, ec: 10 },
  { v: 3, size: 29, data: 55, ec: 15 },
  { v: 4, size: 33, data: 80, ec: 20 },
];
// Alignment-pattern centre per version (none for v1).
const ALIGN = [[], [], [6, 18], [6, 22], [6, 26]];

export function qrMatrix(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  const spec = SPEC.find((s) => bytes.length + 2 <= s.data);
  if (!spec) throw new Error("QR: text too long for v1–4");

  // Bit stream: mode (0100) + 8-bit count + data + terminator + pad.
  const bits: number[] = [];
  const push = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const cap = spec.data * 8;
  push(0, Math.min(4, cap - bits.length)); // terminator
  while (bits.length % 8 !== 0) bits.push(0);
  const dataCw: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    dataCw.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  }
  const pads = [0xec, 0x11];
  let p = 0;
  while (dataCw.length < spec.data) dataCw.push(pads[p++ % 2]!);
  const all = [...dataCw, ...rsEncode(dataCw, spec.ec)];

  const n = spec.size;
  const m: (boolean | null)[][] = Array.from({ length: n }, () =>
    new Array<boolean | null>(n).fill(null),
  );
  const set = (r: number, c: number, v: boolean): void => {
    m[r]![c] = v;
  };
  const finder = (r: number, c: number): void => {
    for (let i = -1; i <= 7; i++) {
      for (let j = -1; j <= 7; j++) {
        const rr = r + i;
        const cc = c + j;
        if (rr < 0 || rr >= n || cc < 0 || cc >= n) continue;
        const inRing =
          i >= 0 && i <= 6 && j >= 0 && j <= 6
            ? i === 0 || i === 6 || j === 0 || j === 6 ||
              (i >= 2 && i <= 4 && j >= 2 && j <= 4)
            : false;
        set(rr, cc, inRing);
      }
    }
  };
  finder(0, 0);
  finder(0, n - 7);
  finder(n - 7, 0);
  for (let i = 8; i < n - 8; i++) {
    const v = i % 2 === 0;
    if (m[6]![i] === null) set(6, i, v);
    if (m[i]![6] === null) set(i, 6, v);
  }
  const ac = ALIGN[spec.v]!;
  for (const ar of ac) {
    for (const acc of ac) {
      if (m[ar]![acc] !== null) continue;
      for (let i = -2; i <= 2; i++) {
        for (let j = -2; j <= 2; j++) {
          set(
            ar + i,
            acc + j,
            Math.max(Math.abs(i), Math.abs(j)) !== 1,
          );
        }
      }
    }
  }
  set(n - 8, 8, true); // dark module

  // Format info (ECC L = 01, mask 0) → 15 bits, BCH + 0x5412 mask.
  let fmt = 0b01000;
  let rem = fmt;
  for (let i = 0; i < 10; i++) {
    rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0b10100110111 : 0);
  }
  const formatBits = ((fmt << 10) | (rem & 0x3ff)) ^ 0b101010000010010;
  const fbit = (i: number): boolean => ((formatBits >> i) & 1) === 1;
  // Copy 1 — wraps the top-left finder: bits 0-6 down column 8 (row 6
  // skipped, it's the timing row), bits 7-14 along row 8 (column 6
  // skipped likewise).
  for (let i = 0; i <= 5; i++) set(i, 8, fbit(i));
  set(7, 8, fbit(6));
  set(8, 8, fbit(7));
  set(8, 7, fbit(8));
  for (let i = 9; i <= 14; i++) set(8, 14 - i, fbit(i));
  // Copy 2 — bits 0-7 up column 8 beside the bottom-left finder, bits
  // 8-14 along row 8 beside the top-right finder. Stops short of the
  // dark module at (n-8, 8), leaving it intact.
  for (let i = 0; i <= 7; i++) set(8, n - 1 - i, fbit(i));
  for (let i = 8; i <= 14; i++) set(n - 15 + i, 8, fbit(i));

  // Data placement (zigzag, bottom-up), mask 0: (r+c)%2===0 inverts.
  const stream = all
    .flatMap((cw) => [7, 6, 5, 4, 3, 2, 1, 0].map((b) => (cw >> b) & 1));
  let si = 0;
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col = 5;
    for (let t = 0; t < n; t++) {
      const row = up ? n - 1 - t : t;
      for (let k = 0; k < 2; k++) {
        const cc = col - k;
        if (m[row]![cc] !== null) continue;
        let v = si < stream.length ? stream[si++] === 1 : false;
        if ((row + cc) % 2 === 0) v = !v; // mask 0
        set(row, cc, v);
      }
    }
    up = !up;
  }
  return m.map((row) => row.map((c) => c === true));
}
