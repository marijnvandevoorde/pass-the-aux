import type { BpmSource } from "../domain/ports/bpm-source.ts";

// Free, no-key BPM/key fallback. MusicBrainz recording search →
// recording MBID → AcousticBrainz crowd analysis (rhythm.bpm,
// tonal.key_*). The AcousticBrainz dataset is frozen (2022) so newer
// tracks may 404 — strictly best-effort, stdlib fetch only.

const UA = "pass-the-aux/1 (self-hosted)";
const TIMEOUT_MS = 4000;

function sig(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function json(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: sig(),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  return res.ok ? res.json() : null;
}

const SCALE: Record<string, string> = { minor: "m", major: "" };

export class AcousticBrainzSource implements BpmSource {
  readonly #enabled: boolean;

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  async lookup(
    artist: string | null,
    title: string,
  ): Promise<{ bpm: number | null; key: string | null } | null> {
    if (!this.#enabled || !title.trim()) return null;
    try {
      const q = encodeURIComponent(
        artist ? `artist:"${artist}" AND recording:"${title}"` : title,
      );
      const mb = (await json(
        `https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=1`,
      )) as { recordings?: Array<{ id?: string }> } | null;
      const mbid = mb?.recordings?.[0]?.id;
      if (!mbid) return null;

      const ab = (await json(
        `https://acousticbrainz.org/api/v1/${mbid}/low-level?n=0`,
      )) as
        | {
            rhythm?: { bpm?: number };
            tonal?: { key_key?: string; key_scale?: string };
          }
        | null;
      if (!ab) return null;

      const rawBpm = ab.rhythm?.bpm;
      const bpm =
        typeof rawBpm === "number" && rawBpm > 20 && rawBpm < 400
          ? Math.round(rawBpm * 10) / 10
          : null;
      const kk = ab.tonal?.key_key;
      const key = kk
        ? `${kk}${SCALE[ab.tonal?.key_scale ?? ""] ?? ""}`
        : null;
      return bpm === null && key === null ? null : { bpm, key };
    } catch {
      return null; // network/timeout/parse — best-effort
    }
  }
}
