// derive artist/title from a filename when embedded tags are
// absent. Pure; unit-tested.

/** Strip the last extension (".mp3", ".flac", …). No-ext → unchanged. */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * Fallback naming when there are no tags:
 *  - split the (extension-less) filename on the FIRST `" - "`
 *    → part 1 = artist, part 2 = title;
 *  - if there is no `" - "` (or a side is blank) → the whole
 *    filename-minus-extension is the title, artist unknown.
 */
export function parseTrackName(filename: string): {
  artist: string | null;
  title: string;
} {
  const base = stripExtension(filename).trim();
  const sep = base.indexOf(" - ");
  if (sep > 0) {
    const artist = base.slice(0, sep).trim();
    const title = base.slice(sep + 3).trim();
    if (artist && title) return { artist, title };
  }
  return { artist: null, title: base };
}
