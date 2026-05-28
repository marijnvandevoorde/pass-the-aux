// Minimal, dependency-free ID3v2 (.2.3 / .2.4) reader — enough for the
// library: TIT2 (title), TPE1 (artist), APIC (cover art, reused by the
// album-art ticket). Best-effort: any malformed/absent tag yields null so
// callers fall back to the filename. Pure, so it is unit-tested directly.

export interface Id3Tags {
  title?: string;
  artist?: string;
  /** TBPM frame (embedded beats-per-minute), if a positive integer. */
  bpm?: number;
  /** TKEY frame (initial musical key, e.g. "8A" / "Am"). */
  key?: string;
  picture?: { mime: string; data: Uint8Array };
}

function syncsafe(b: Uint8Array, o: number): number {
  return (
    ((b[o]! & 0x7f) << 21) |
    ((b[o + 1]! & 0x7f) << 14) |
    ((b[o + 2]! & 0x7f) << 7) |
    (b[o + 3]! & 0x7f)
  );
}

function uint32be(b: Uint8Array, o: number): number {
  return (
    ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
  );
}

function decodeText(body: Uint8Array): string {
  if (body.length === 0) return "";
  const enc = body[0];
  const rest = body.subarray(1);
  let s: string;
  if (enc === 1) {
    // UTF-16 with BOM
    const be = rest[0] === 0xfe && rest[1] === 0xff;
    let u = rest.subarray(2);
    if (be) {
      const sw = new Uint8Array(u.length);
      for (let i = 0; i + 1 < u.length; i += 2) {
        sw[i] = u[i + 1]!;
        sw[i + 1] = u[i]!;
      }
      u = sw;
    }
    s = new TextDecoder("utf-16le").decode(u);
  } else if (enc === 2) {
    const sw = new Uint8Array(rest.length);
    for (let i = 0; i + 1 < rest.length; i += 2) {
      sw[i] = rest[i + 1]!;
      sw[i + 1] = rest[i]!;
    }
    s = new TextDecoder("utf-16le").decode(sw);
  } else {
    s = new TextDecoder(enc === 3 ? "utf-8" : "latin1").decode(rest);
  }
  return s.replace(/\0+$/g, "").trim();
}

export function parseId3(bytes: Uint8Array): Id3Tags | null {
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x49 ||
    bytes[1] !== 0x44 ||
    bytes[2] !== 0x33
  ) {
    return null;
  }
  const ver = bytes[3]!;
  if (ver !== 3 && ver !== 4) return null;
  if ((bytes[5]! & 0x40) !== 0) return null; // extended header — skip (rare)

  const end = Math.min(10 + syncsafe(bytes, 6), bytes.length);
  const out: Id3Tags = {};
  let pos = 10;
  while (pos + 10 <= end) {
    const id = String.fromCharCode(
      bytes[pos]!,
      bytes[pos + 1]!,
      bytes[pos + 2]!,
      bytes[pos + 3]!,
    );
    if (id === "\0\0\0\0") break; // padding
    const size =
      ver === 4 ? syncsafe(bytes, pos + 4) : uint32be(bytes, pos + 4);
    pos += 10;
    if (size <= 0 || pos + size > end) break;
    const body = bytes.subarray(pos, pos + size);
    if (id === "TIT2") out.title = decodeText(body) || undefined;
    else if (id === "TPE1") out.artist = decodeText(body) || undefined;
    else if (id === "TBPM") {
      const n = parseInt(decodeText(body).trim(), 10);
      if (Number.isFinite(n) && n > 0 && n < 1000) out.bpm = n;
    } else if (id === "TKEY") {
      out.key = decodeText(body).trim() || undefined;
    } else if (id === "APIC") {
      let i = 1; // skip text-encoding byte
      while (i < body.length && body[i] !== 0) i++;
      const mime = new TextDecoder("latin1").decode(body.subarray(1, i));
      i++; // NUL after mime
      i++; // picture type byte
      const enc = body[0];
      if (enc === 1 || enc === 2) {
        while (i + 1 < body.length && !(body[i] === 0 && body[i + 1] === 0)) {
          i += 2;
        }
        i += 2;
      } else {
        while (i < body.length && body[i] !== 0) i++;
        i++;
      }
      if (mime && i < body.length) {
        out.picture = { mime, data: body.subarray(i) };
      }
    }
    pos += size;
  }
  return out.title ||
    out.artist ||
    out.picture ||
    out.bpm !== undefined ||
    out.key
    ? out
    : null;
}
