// Zero-dep parser for Vorbis comments and FLAC PICTURE blocks.
// Covers OGG Vorbis (.ogg), OGG Opus (.opus), and native FLAC (.flac).
// All three share the same comment and picture-block wire formats;
// only the outer container differs.
//
// Specs:
//   Vorbis: https://www.xiph.org/vorbis/doc/v-comment.html
//   OGG:    https://www.xiph.org/ogg/doc/framing.html
//   FLAC:   https://xiph.org/flac/format.html

export interface VorbisTags {
  title?: string;
  artist?: string;
  picture?: { mime: string; data: Uint8Array };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function u32le(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(n);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const UTF8 = new TextDecoder();

// ── Base64 decoder ────────────────────────────────────────────────────────────
// Needed to decode METADATA_BLOCK_PICTURE values. Pure JS so this module
// stays free of Node / browser API dependencies.

const B64_ALPHA =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_TABLE = new Uint8Array(256).fill(0xff);
for (let i = 0; i < B64_ALPHA.length; i++) {
  B64_TABLE[B64_ALPHA.charCodeAt(i)] = i;
}

function fromBase64(s: string): Uint8Array | null {
  // Collect 6-bit values, skip whitespace, stop at '='
  const v: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x3d) break; // '='
    if (c <= 32) continue; // whitespace
    const val = B64_TABLE[c];
    if (val === 0xff) return null; // invalid char
    v.push(val!);
  }
  const byteLen = (v.length * 3) >> 2;
  const out = new Uint8Array(byteLen);
  let o = 0;
  for (let i = 0; i + 3 < v.length; i += 4) {
    const a = v[i]!, b = v[i + 1]!, c = v[i + 2]!, d = v[i + 3]!;
    out[o++] = (a << 2) | (b >> 4);
    out[o++] = ((b & 0xf) << 4) | (c >> 2);
    out[o++] = ((c & 0x3) << 6) | d;
  }
  const rem = v.length % 4;
  if (rem === 2) {
    out[o++] = (v[v.length - 2]! << 2) | (v[v.length - 1]! >> 4);
  } else if (rem === 3) {
    const a = v[v.length - 3]!, b = v[v.length - 2]!, c = v[v.length - 1]!;
    out[o++] = (a << 2) | (b >> 4);
    out[o++] = ((b & 0xf) << 4) | (c >> 2);
  }
  return out.subarray(0, o);
}

// ── FLAC PICTURE block ────────────────────────────────────────────────────────
// Shared between FLAC native blocks and OGG METADATA_BLOCK_PICTURE comments.

function parsePictureBlock(
  raw: Uint8Array,
): { mime: string; data: Uint8Array } | null {
  if (raw.length < 32) return null;
  let o = 4; // skip picture_type uint32
  const mimeLen = u32be(raw, o);
  o += 4;
  if (o + mimeLen + 4 > raw.length) return null;
  const mime = UTF8.decode(raw.subarray(o, o + mimeLen));
  o += mimeLen;
  const descLen = u32be(raw, o);
  o += 4 + descLen; // skip description
  o += 16; // skip width, height, color_depth, colors_used
  if (o + 4 > raw.length) return null;
  const dataLen = u32be(raw, o);
  o += 4;
  if (o + dataLen > raw.length) return null;
  return { mime, data: raw.subarray(o, o + dataLen) };
}

// ── Vorbis comment block parser ───────────────────────────────────────────────
// Used by OGG Vorbis, OGG Opus, and FLAC (all share the same wire format).
// `body` starts after the per-format header prefix (\x03vorbis / OpusTags / none).

function parseCommentBody(body: Uint8Array): VorbisTags | null {
  if (body.length < 8) return null;
  let o = 0;
  const vendorLen = u32le(body, o);
  o += 4 + vendorLen;
  if (o + 4 > body.length) return null;
  const count = u32le(body, o);
  o += 4;

  const out: VorbisTags = {};
  for (let c = 0; c < count; c++) {
    if (o + 4 > body.length) break;
    const clen = u32le(body, o);
    o += 4;
    if (o + clen > body.length) break;
    const str = UTF8.decode(body.subarray(o, o + clen));
    o += clen;

    const eq = str.indexOf("=");
    if (eq < 1) continue;
    const key = str.slice(0, eq).toUpperCase();
    const val = str.slice(eq + 1);

    if (key === "TITLE") {
      out.title = val.trim() || undefined;
    } else if (key === "ARTIST") {
      out.artist = val.trim() || undefined;
    } else if (key === "METADATA_BLOCK_PICTURE" && !out.picture) {
      const raw = fromBase64(val);
      if (raw) {
        const pic = parsePictureBlock(raw);
        if (pic) out.picture = pic;
      }
    }
  }

  return out.title || out.artist || out.picture ? out : null;
}

// ── OGG container ─────────────────────────────────────────────────────────────
// Iterate over OGG pages and reassemble logical packets.
// Stops as soon as maxPackets complete packets have been yielded.

function* oggPackets(
  bytes: Uint8Array,
  maxPackets: number,
): Generator<Uint8Array> {
  let pos = 0;
  let yielded = 0;
  const pending: Uint8Array[] = [];

  while (pos + 27 <= bytes.length && yielded < maxPackets) {
    if (
      bytes[pos] !== 0x4f ||
      bytes[pos + 1] !== 0x67 ||
      bytes[pos + 2] !== 0x67 ||
      bytes[pos + 3] !== 0x53
    ) break;

    const nsegs = bytes[pos + 26]!;
    if (pos + 27 + nsegs > bytes.length) break;

    const lacing = bytes.subarray(pos + 27, pos + 27 + nsegs);
    let dataOff = pos + 27 + nsegs;

    for (let i = 0; i < nsegs && yielded < maxPackets; i++) {
      const len = lacing[i]!;
      const end = dataOff + len;
      if (end > bytes.length) {
        // Truncated at end of buffer — yield whatever we accumulated
        if (pending.length > 0) {
          pending.push(bytes.subarray(dataOff));
          yield concat(pending);
          yielded++;
        }
        return;
      }
      pending.push(bytes.subarray(dataOff, end));
      dataOff = end;
      if (len < 255) {
        yield concat(pending);
        yielded++;
        pending.length = 0;
      }
    }

    let pageDataLen = 0;
    for (let i = 0; i < nsegs; i++) pageDataLen += lacing[i]!;
    pos += 27 + nsegs + pageDataLen;
  }

  if (pending.length > 0) yield concat(pending);
}

// ── Public API ────────────────────────────────────────────────────────────────

// \x03vorbis
const OGG_VORBIS_COMMENT = new Uint8Array([
  0x03, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73,
]);
// OpusTags
const OGG_OPUS_COMMENT = new Uint8Array([
  0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73,
]);

function matchesPrefix(packet: Uint8Array, prefix: Uint8Array): boolean {
  if (packet.length < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (packet[i] !== prefix[i]) return false;
  }
  return true;
}

/**
 * Parse an OGG Vorbis file (.ogg) — finds the \x03vorbis comment packet
 * (always the second packet in a Vorbis bitstream) and extracts tags.
 */
export function parseOggVorbis(bytes: Uint8Array): VorbisTags | null {
  let idx = 0;
  for (const pkt of oggPackets(bytes, 3)) {
    if (idx++ !== 1) continue;
    if (!matchesPrefix(pkt, OGG_VORBIS_COMMENT)) return null;
    return parseCommentBody(pkt.subarray(OGG_VORBIS_COMMENT.length));
  }
  return null;
}

/**
 * Parse an OGG Opus file (.opus) — finds the OpusTags comment packet
 * (always the second packet in an Opus bitstream) and extracts tags.
 */
export function parseOggOpus(bytes: Uint8Array): VorbisTags | null {
  let idx = 0;
  for (const pkt of oggPackets(bytes, 3)) {
    if (idx++ !== 1) continue;
    if (!matchesPrefix(pkt, OGG_OPUS_COMMENT)) return null;
    return parseCommentBody(pkt.subarray(OGG_OPUS_COMMENT.length));
  }
  return null;
}

// fLaC magic
const FLAC_MAGIC = new Uint8Array([0x66, 0x4c, 0x61, 0x43]);

/**
 * Parse a native FLAC file (.flac) — walks the metadata block chain at the
 * start of the file, collecting VORBIS_COMMENT (type 4) and PICTURE (type 6)
 * blocks. Stops when it hits the first audio frame or runs out of buffer.
 */
export function parseFlac(bytes: Uint8Array): VorbisTags | null {
  if (bytes.length < 4) return null;
  for (let i = 0; i < 4; i++) if (bytes[i] !== FLAC_MAGIC[i]) return null;

  let pos = 4;
  const out: VorbisTags = {};

  while (pos + 4 <= bytes.length) {
    const hdr = bytes[pos]!;
    const isLast = !!(hdr & 0x80);
    const type = hdr & 0x7f;
    const len = (bytes[pos + 1]! << 16) | (bytes[pos + 2]! << 8) | bytes[pos + 3]!;
    pos += 4;
    if (pos + len > bytes.length) break;
    const block = bytes.subarray(pos, pos + len);
    pos += len;

    if (type === 4) {
      // VORBIS_COMMENT
      const tags = parseCommentBody(block);
      if (tags) {
        out.title = out.title ?? tags.title;
        out.artist = out.artist ?? tags.artist;
        out.picture = out.picture ?? tags.picture;
      }
    } else if (type === 6 && !out.picture) {
      // PICTURE block
      const pic = parsePictureBlock(block);
      if (pic) out.picture = pic;
    }

    if (isLast) break;
  }

  return out.title || out.artist || out.picture ? out : null;
}
