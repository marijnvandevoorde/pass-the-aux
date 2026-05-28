import test from "node:test";
import assert from "node:assert/strict";
import { parseId3 } from "../../src/infrastructure/id3.ts";

function latin1(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0) & 0xff);
}

/** A v2.3 text frame: 4-char id, big-endian size, 2 flag bytes, body. */
function textFrame(id: string, text: string): number[] {
  const body = [0x00, ...latin1(text)]; // 0x00 = latin1 encoding
  const n = body.length;
  return [
    ...latin1(id),
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
    0,
    0,
    ...body,
  ];
}

function tag(...frames: number[][]): Uint8Array {
  const body = frames.flat();
  const L = body.length;
  return new Uint8Array([
    0x49,
    0x44,
    0x33, // "ID3"
    3,
    0,
    0, // v2.3, rev 0, no flags
    (L >> 21) & 0x7f,
    (L >> 14) & 0x7f,
    (L >> 7) & 0x7f,
    L & 0x7f, // syncsafe size
    ...body,
  ]);
}

test("reads TIT2 (title) and TPE1 (artist)", () => {
  const t = parseId3(
    tag(textFrame("TIT2", "Night Drive"), textFrame("TPE1", "CC0 Artist")),
  );
  assert.deepEqual(t, { title: "Night Drive", artist: "CC0 Artist" });
});

test("reads TBPM (bpm) and TKEY (key) frames", () => {
  const t = parseId3(
    tag(
      textFrame("TIT2", "Track"),
      textFrame("TBPM", "128"),
      textFrame("TKEY", "8A"),
    ),
  );
  assert.equal(t?.bpm, 128);
  assert.equal(t?.key, "8A");
  // a non-numeric / zero TBPM is ignored
  assert.equal(parseId3(tag(textFrame("TBPM", "0")))?.bpm, undefined);
  assert.equal(parseId3(tag(textFrame("TBPM", "n/a"))), null);
});

test("non-ID3 data returns null (filename fallback)", () => {
  assert.equal(parseId3(new Uint8Array([1, 2, 3, 4, 5])), null);
  assert.equal(parseId3(new Uint8Array(latin1("RIFFxxxxWAVE"))), null);
});

test("a tag with neither title nor artist nor art returns null", () => {
  assert.equal(parseId3(tag(textFrame("TCON", "Techno"))), null);
});

test("extracts an APIC picture (reused by the cover-art ticket)", () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];
  const apicBody = [
    0x00, // text encoding
    ...latin1("image/png"),
    0x00, // mime terminator
    0x03, // picture type (cover front)
    0x00, // empty description terminator
    ...png,
  ];
  const n = apicBody.length;
  const frame = [
    ...latin1("APIC"),
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
    0,
    0,
    ...apicBody,
  ];
  const t = parseId3(tag(frame));
  assert.equal(t?.picture?.mime, "image/png");
  assert.deepEqual([...(t?.picture?.data ?? [])], png);
});
