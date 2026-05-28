import test from "node:test";
import assert from "node:assert/strict";
import { qrMatrix } from "../../src/web/qr.ts";

function isFinder(m: boolean[][], r: number, c: number): boolean {
  // 7x7: solid border ring + 3x3 solid centre.
  for (let i = 0; i < 7; i++) {
    for (let j = 0; j < 7; j++) {
      const ring =
        i === 0 || i === 6 || j === 0 || j === 6 ||
        (i >= 2 && i <= 4 && j >= 2 && j <= 4);
      if (m[r + i]![c + j] !== ring) return false;
    }
  }
  return true;
}

test("short text → 21×21 (v1) matrix with 3 finder patterns", () => {
  const m = qrMatrix("hi");
  assert.equal(m.length, 21);
  assert.equal(m[0]!.length, 21);
  assert.ok(isFinder(m, 0, 0), "top-left finder");
  assert.ok(isFinder(m, 0, 14), "top-right finder");
  assert.ok(isFinder(m, 14, 0), "bottom-left finder");
  assert.equal(m[21 - 8]![8], true, "dark module set");
});

test("a typical crowd URL fits and grows the version", () => {
  const m = qrMatrix("http://192.168.1.42:5174/crowd?s=ab12cd34ef56");
  assert.ok(m.length >= 21 && (m.length - 21) % 4 === 0);
  assert.ok(isFinder(m, 0, 0));
});

test("over-long text throws (v1–4 only)", () => {
  assert.throws(() => qrMatrix("x".repeat(200)), /too long/);
});

// Full-matrix snapshot of a known-good encode. The structural checks
// above all passed even while the encoder produced an UNSCANNABLE QR
// (transposed format-info placement + reversed Reed–Solomon generator
// coefficients), so they can't guard decodability on their own. This
// reference matrix was verified to decode back to "hi" with a real QR
// reader (macOS Vision). If a change to qr.ts trips this test, re-verify
// the output actually scans before updating the snapshot.
test('qrMatrix("hi") matches the scan-verified reference', () => {
  const expected = [
    "111111100010101111111",
    "100000100000101000001",
    "101110101010001011101",
    "101110100000101011101",
    "101110100101101011101",
    "100000100111001000001",
    "111111101010101111111",
    "000000001010000000000",
    "111011111010111000100",
    "011000010011010101111",
    "011111111101011101111",
    "001100000001110111010",
    "100101101011011100100",
    "000000001010001000111",
    "111111101110100010011",
    "100000101110001000111",
    "101110101100101010101",
    "101110100101010101010",
    "101110101111011101101",
    "100000101101110111010",
    "111111101001011101111",
  ];
  const m = qrMatrix("hi");
  assert.equal(m.length, expected.length);
  m.forEach((row, r) => {
    assert.equal(
      row.map((x) => (x ? "1" : "0")).join(""),
      expected[r],
      `row ${r} differs`,
    );
  });
});
