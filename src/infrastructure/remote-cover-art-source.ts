import type { CoverArtSource } from "../domain/ports/cover-art.ts";

// Free, no-key cover lookup by artist+title. Three providers tried in
// a randomised order; the first that yields a ~250px image wins.
// stdlib fetch only — every provider exposes a small pre-sized
// variant, so no image library is needed.

const UA = "pass-the-aux/1 (self-hosted)";
const TIMEOUT_MS = 4000;

function timeout(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS);
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    signal: timeout(),
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getImage(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url, {
    signal: timeout(),
    headers: { "User-Agent": UA },
  });
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct && !ct.startsWith("image/")) return null;
  const bytes = new Uint8Array(await res.arrayBuffer());
  return bytes.byteLength > 512 ? bytes : null; // reject error/placeholder blobs
}

async function fromItunes(
  artist: string | null,
  title: string,
): Promise<Uint8Array | null> {
  const term = encodeURIComponent(`${artist ?? ""} ${title}`.trim());
  const j = (await getJson(
    `https://itunes.apple.com/search?term=${term}&entity=song&limit=1`,
  )) as { results?: Array<{ artworkUrl100?: string }> } | null;
  const art = j?.results?.[0]?.artworkUrl100;
  if (!art) return null;
  // iTunes art URLs are size-templated: 100x100bb → 250x250bb.
  return getImage(art.replace(/\/\d+x\d+bb\./, "/250x250bb."));
}

async function fromDeezer(
  artist: string | null,
  title: string,
): Promise<Uint8Array | null> {
  const q = encodeURIComponent(
    artist ? `artist:"${artist}" track:"${title}"` : title,
  );
  const j = (await getJson(`https://api.deezer.com/search?q=${q}&limit=1`)) as
    | { data?: Array<{ album?: { cover_medium?: string } }> }
    | null;
  const url = j?.data?.[0]?.album?.cover_medium; // 250×250
  return url ? getImage(url) : null;
}

async function fromCoverArtArchive(
  artist: string | null,
  title: string,
): Promise<Uint8Array | null> {
  const q = encodeURIComponent(
    artist ? `artist:"${artist}" AND recording:"${title}"` : title,
  );
  const j = (await getJson(
    `https://musicbrainz.org/ws/2/recording?query=${q}&fmt=json&limit=1`,
  )) as
    | { recordings?: Array<{ releases?: Array<{ id?: string }> }> }
    | null;
  const mbid = j?.recordings?.[0]?.releases?.[0]?.id;
  if (!mbid) return null;
  return getImage(`https://coverartarchive.org/release/${mbid}/front-250`);
}

function shuffled<T>(items: readonly T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export class RemoteCoverArtSource implements CoverArtSource {
  readonly #enabled: boolean;
  readonly #providers: ReadonlyArray<
    (a: string | null, t: string) => Promise<Uint8Array | null>
  >;

  constructor(
    enabled: boolean,
    providers: ReadonlyArray<
      (a: string | null, t: string) => Promise<Uint8Array | null>
    > = [fromItunes, fromDeezer, fromCoverArtArchive],
  ) {
    this.#enabled = enabled;
    this.#providers = providers;
  }

  async fetch(
    artist: string | null,
    title: string,
  ): Promise<Uint8Array | null> {
    if (!this.#enabled || !title.trim()) return null;
    for (const provider of shuffled(this.#providers)) {
      try {
        const bytes = await provider(artist, title);
        if (bytes) return bytes;
      } catch {
        // network/timeout/parse — try the next source
      }
    }
    return null;
  }
}
