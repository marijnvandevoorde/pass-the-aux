/** Looks up BPM (and musical key) for a track by metadata, for tracks
 *  with no embedded TBPM/TKEY and not yet analysed by the browser.
 *  Best-effort — returns null when nothing is found / disabled. */
export interface BpmSource {
  lookup(
    artist: string | null,
    title: string,
  ): Promise<{ bpm: number | null; key: string | null } | null>;
}
