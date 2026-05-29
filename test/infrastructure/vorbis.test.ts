import test from "node:test";
import assert from "node:assert/strict";
import { parseOggVorbis, parseOggOpus, parseFlac } from "../../src/infrastructure/vorbis.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function u32le(n: number): number[] {
  return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff];
}

function u32be(n: number): number[] {
  return [(n >> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function utf8(s: string): number[] {
  return [...new TextEncoder().encode(s)];
}

/** Build a Vorbis comment body (after the per-format header prefix). */
function commentBody(vendor: string, comments: string[]): number[] {
  const v = utf8(vendor);
  const cs = comments.map((c) => utf8(c));
  return [
    ...u32le(v.length), ...v,
    ...u32le(cs.length),
    ...cs.flatMap((c) => [...u32le(c.length), ...c]),
    0x01, // framing bit
  ];
}

/** Wrap body in \x03vorbis prefix for OGG Vorbis. */
function oggVorbisCommentPacket(comments: string[]): number[] {
  const prefix = [0x03, ...utf8("vorbis")];
  return [...prefix, ...commentBody("test encoder", comments)];
}

/** Wrap body in OpusTags prefix for OGG Opus. */
function oggOpusCommentPacket(comments: string[]): number[] {
  const prefix = [...utf8("OpusTags")];
  return [...prefix, ...commentBody("test encoder", comments)];
}

/** Build an OGG page with a single packet (all segments < 255). */
function oggPage(packetBytes: number[], seqNum: number, flags = 0): number[] {
  // Split into 255-byte segments
  const segs: number[][] = [];
  let i = 0;
  while (i < packetBytes.length) {
    segs.push(packetBytes.slice(i, i + 255));
    i += 255;
  }
  // If the last segment is exactly 255 bytes, add a 0-byte terminator
  if (segs.length > 0 && segs[segs.length - 1]!.length === 255) {
    segs.push([]);
  }
  const nsegs = segs.length;
  const lacing = segs.map((s) => s.length);
  const data = segs.flat();
  return [
    0x4f, 0x67, 0x67, 0x53, // OggS
    0x00, // version
    flags, // header type
    0, 0, 0, 0, 0, 0, 0, 0, // granule_position
    0x01, 0x00, 0x00, 0x00, // serial_number
    ...u32le(seqNum), // page_sequence_number
    0x00, 0x00, 0x00, 0x00, // checksum (not verified)
    nsegs,
    ...lacing,
    ...data,
  ];
}

/** Minimal OGG Vorbis file: id page, comment page, setup page. */
function makeOggVorbis(comments: string[]): Uint8Array {
  const idPacket = [0x01, ...utf8("vorbis"), ...new Array(23).fill(0)];
  const cmtPacket = oggVorbisCommentPacket(comments);
  const setupPacket = [0x05, ...utf8("vorbis")];
  return new Uint8Array([
    ...oggPage(idPacket, 0, 0x02), // first page
    ...oggPage(cmtPacket, 1),
    ...oggPage(setupPacket, 2),
  ]);
}

/** Minimal OGG Opus file: id page, comment page. */
function makeOggOpus(comments: string[]): Uint8Array {
  const idPacket = [...utf8("OpusHead"), 0x01, 0x02, ...new Array(9).fill(0)];
  const cmtPacket = oggOpusCommentPacket(comments);
  return new Uint8Array([
    ...oggPage(idPacket, 0, 0x02),
    ...oggPage(cmtPacket, 1),
  ]);
}

/** Minimal FLAC file: magic + VORBIS_COMMENT block. */
function makeFlac(comments: string[], addPicture = false): Uint8Array {
  const body = commentBody("test encoder", comments);
  // Remove framing bit (FLAC doesn't use it, but it won't matter since we
  // read by count; strip last byte to match strict framing-less format)
  const cblock = body.slice(0, -1);
  const isLast = addPicture ? 0x04 : 0x84; // type 4, last=bit7
  const len = cblock.length;
  const commentBlock = [
    isLast,
    (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff,
    ...cblock,
  ];
  const blocks: number[] = [...commentBlock];

  if (addPicture) {
    const jpegBytes = [0xff, 0xd8, 0xfe, 0x01]; // minimal JPEG-ish bytes
    const mime = utf8("image/jpeg");
    const desc: number[] = [];
    const pictureBlock = [
      ...u32be(3), // picture type: front cover
      ...u32be(mime.length), ...mime,
      ...u32be(desc.length), ...desc,
      ...u32be(100), ...u32be(100), // width, height
      ...u32be(24), ...u32be(0), // color_depth, colors_used
      ...u32be(jpegBytes.length), ...jpegBytes,
    ];
    const plen = pictureBlock.length;
    blocks.push(0x86); // type 6, last=bit7
    blocks.push((plen >> 16) & 0xff, (plen >> 8) & 0xff, plen & 0xff);
    blocks.push(...pictureBlock);
  }

  return new Uint8Array([
    0x66, 0x4c, 0x61, 0x43, // fLaC
    ...blocks,
  ]);
}

// ── OGG Vorbis tests ──────────────────────────────────────────────────────────

test("ogg: reads TITLE and ARTIST", () => {
  const t = parseOggVorbis(makeOggVorbis(["TITLE=Night Drive", "ARTIST=CC0"]));
  assert.equal(t?.title, "Night Drive");
  assert.equal(t?.artist, "CC0");
});

test("ogg: keys are case-insensitive", () => {
  const t = parseOggVorbis(makeOggVorbis(["title=lowercase", "artist=also lower"]));
  assert.equal(t?.title, "lowercase");
  assert.equal(t?.artist, "also lower");
});

test("ogg: returns null when no useful tags", () => {
  assert.equal(parseOggVorbis(makeOggVorbis(["ENCODER=libvorbis"])), null);
});

test("ogg: returns null for non-OGG data", () => {
  assert.equal(parseOggVorbis(new Uint8Array([1, 2, 3, 4, 5])), null);
});

test("ogg: trims whitespace from values", () => {
  const t = parseOggVorbis(makeOggVorbis(["TITLE=  spaced  "]));
  assert.equal(t?.title, "spaced");
});

// ── OGG Opus tests ────────────────────────────────────────────────────────────

test("opus: reads TITLE and ARTIST", () => {
  const t = parseOggOpus(makeOggOpus(["TITLE=Opus Track", "ARTIST=Opus Artist"]));
  assert.equal(t?.title, "Opus Track");
  assert.equal(t?.artist, "Opus Artist");
});

test("opus: returns null for non-Opus OGG (wrong comment magic)", () => {
  // An OGG Vorbis stream has a \x03vorbis comment; Opus parser should reject it
  const vorbisFile = makeOggVorbis(["TITLE=Should Not Match"]);
  assert.equal(parseOggOpus(vorbisFile), null);
});

// ── FLAC tests ────────────────────────────────────────────────────────────────

test("flac: reads TITLE and ARTIST", () => {
  const t = parseFlac(makeFlac(["TITLE=Flac Track", "ARTIST=Flac Artist"]));
  assert.equal(t?.title, "Flac Track");
  assert.equal(t?.artist, "Flac Artist");
});

test("flac: reads embedded PICTURE block", () => {
  const t = parseFlac(makeFlac(["TITLE=With Art"], true));
  assert.equal(t?.picture?.mime, "image/jpeg");
  assert.ok((t?.picture?.data.length ?? 0) > 0);
});

test("flac: returns null for non-FLAC data", () => {
  assert.equal(parseFlac(new Uint8Array([0x49, 0x44, 0x33, 0])), null); // ID3 magic
});

// ── Multi-page comment packet ─────────────────────────────────────────────────

test("ogg: reassembles a comment packet that spans multiple pages", () => {
  // Build a comment packet large enough to force page splitting (> 65025 bytes)
  // We use a long TITLE to bloat the packet.
  const longTitle = "A".repeat(70_000);
  const idPacket = [0x01, ...utf8("vorbis"), ...new Array(23).fill(0)];
  const cmtPacket = oggVorbisCommentPacket([`TITLE=${longTitle}`, "ARTIST=Test"]);

  // Split cmtPacket into chunks of 65025 (255*255) bytes to match max page size
  const pageSize = 255 * 255;
  const pages: number[] = [...oggPage(idPacket, 0, 0x02)];
  let seq = 1;
  let remaining = cmtPacket;
  while (remaining.length > 0) {
    const chunk = remaining.slice(0, pageSize);
    remaining = remaining.slice(pageSize);
    const flags = remaining.length > 0 ? 0x01 : 0x00; // 0x01 = continued
    // For multi-page packets we need to build pages carefully:
    // - Each chunk may end with segment 255 (continuation) or < 255 (end)
    // Build the page manually: if not the last chunk, all segments are 255
    if (remaining.length > 0) {
      // All 255-byte segments, packet continues
      const numFullSegs = Math.floor(chunk.length / 255);
      const lastSegLen = chunk.length % 255;
      const lacing = [
        ...new Array(numFullSegs).fill(255),
        ...(lastSegLen > 0 ? [lastSegLen] : []),
      ];
      // But if last seg is 255, packet still continues, which is fine
      // since remaining.length > 0 means we'll continue on next page
      const pageHeader = [
        0x4f, 0x67, 0x67, 0x53,
        0x00, flags, 0, 0, 0, 0, 0, 0, 0, 0,
        0x01, 0x00, 0x00, 0x00,
        ...u32le(seq++),
        0x00, 0x00, 0x00, 0x00,
        lacing.length, ...lacing,
      ];
      pages.push(...pageHeader, ...chunk);
    } else {
      pages.push(...oggPage(chunk, seq++));
    }
  }

  const bytes = new Uint8Array(pages);
  const t = parseOggVorbis(bytes);
  assert.equal(t?.title?.length, longTitle.length);
  assert.equal(t?.artist, "Test");
});
