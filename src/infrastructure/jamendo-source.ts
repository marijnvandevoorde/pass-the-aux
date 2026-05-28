import { Readable } from "node:stream";
import { RemoteDisabledError, RemoteSourceError } from "../domain/errors.ts";
import type {
  RemoteAudio,
  RemoteSearchPage,
  RemoteSource,
  RemoteTrack,
} from "../domain/ports/remote-source.ts";

export interface JamendoSourceOptions {
  /** DB row id — used to route /api/remote-import calls back to us. */
  id: string;
  /** UI-facing label shown in the source switcher. */
  displayName: string;
  /** Jamendo Developer client_id (free, no signature required for the
   *  public search/stream endpoints). `null`/empty disables the source. */
  clientId: string | null;
  /** Injectable fetch (defaults to global) — used by unit tests. */
  fetchImpl?: typeof fetch;
}

/** Jamendo's public API. We deliberately use the v3.0 base + the
 *  unauthenticated `client_id` flow, which is all we need for search +
 *  direct-stream URLs. */
const API = "https://api.jamendo.com/v3.0";
const PAGE_SIZE = 10;

/** Map an `audio/*` content-type to a sensible file extension. */
const CT_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
};

function extFromContentType(ct: string): string {
  const key = ct.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return CT_EXT[key] ?? "mp3";
}

function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Adapter for Jamendo's open Creative-Commons catalog. Search returns
 *  10 results per page; download streams Jamendo's CDN URL straight
 *  through (Jamendo doesn't require auth on the audio URL itself). */
export class JamendoSource implements RemoteSource {
  readonly id: string;
  readonly displayName: string;
  readonly #clientId: string | null;
  readonly #fetch: typeof fetch;
  /** Track id → direct audio URL learned during search. Avoids a second
   *  round-trip when the user imports a result they just saw. */
  readonly #audioUrlCache = new Map<string, string>();

  constructor(opts: JamendoSourceOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.#clientId = (opts.clientId ?? "").trim() || null;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  get enabled(): boolean {
    return this.#clientId !== null;
  }

  async search(query: string, offset = 0): Promise<RemoteSearchPage> {
    if (this.#clientId === null) throw new RemoteDisabledError();
    const url = new URL(`${API}/tracks/`);
    url.searchParams.set("client_id", this.#clientId);
    url.searchParams.set("format", "json");
    url.searchParams.set("limit", String(PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("search", query);
    // Direct streamable mp3 URLs in the `audio` field.
    url.searchParams.set("audioformat", "mp32");
    // Include image so the UI gets cover art.
    url.searchParams.set("imagesize", "300");

    let res: Response;
    try {
      res = await this.#fetch(url);
    } catch (e) {
      throw new RemoteSourceError(`request failed: ${msg(e)}`);
    }
    if (!res.ok) throw new RemoteSourceError(`HTTP ${res.status}`);
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new RemoteSourceError(`HTTP ${res.status} (non-JSON response)`);
    }
    const env = obj(json);
    const headers = obj(env.headers);
    if (headers.status !== "success") {
      const err = str(headers.error_message) || `code ${num(headers.code)}`;
      throw new RemoteSourceError(`jamendo: ${err}`);
    }
    const rawItems = Array.isArray(env.results) ? env.results : [];
    const items = rawItems
      .map(mapTrack)
      .filter((t): t is RemoteTrack & { _audio: string } => t._audio !== "");
    for (const t of items) this.#audioUrlCache.set(t.remoteId, t._audio);
    const cleanItems: RemoteTrack[] = items.map(stripInternal);

    // Jamendo doesn't return a true grand total. We report a lower
    // bound — if this page is full, hint that more pages exist by
    // adding one extra; the UI uses `total > offset+items.length` to
    // enable the "next page" button.
    const more = rawItems.length >= PAGE_SIZE;
    const total = offset + cleanItems.length + (more ? 1 : 0);
    return { items: cleanItems, total, offset };
  }

  async download(remoteId: string): Promise<RemoteAudio> {
    if (this.#clientId === null) throw new RemoteDisabledError();
    const audioUrl = this.#audioUrlCache.get(remoteId)
      ?? (await this.#fetchAudioUrl(remoteId));
    if (audioUrl === null) {
      throw new RemoteSourceError(`jamendo: track ${remoteId} not found`);
    }
    let res: Response;
    try {
      res = await this.#fetch(audioUrl);
    } catch (e) {
      throw new RemoteSourceError(`request failed: ${msg(e)}`);
    }
    if (!res.ok) throw new RemoteSourceError(`HTTP ${res.status}`);
    if (!res.body) throw new RemoteSourceError("empty response body");
    const ct = res.headers.get("content-type") ?? "audio/mpeg";
    const audioCt = ct.startsWith("audio/") ? ct : "audio/mpeg";
    const len = Number(res.headers.get("content-length"));
    return {
      stream: Readable.fromWeb(res.body),
      contentType: audioCt,
      ext: extFromContentType(audioCt),
      size: Number.isFinite(len) && len > 0 ? len : null,
    };
  }

  /** Fall back to a second API call when the user imports a track we
   *  didn't see in the current process (e.g. server restarted between
   *  search and import). */
  async #fetchAudioUrl(remoteId: string): Promise<string | null> {
    const url = new URL(`${API}/tracks/`);
    url.searchParams.set("client_id", this.#clientId!);
    url.searchParams.set("format", "json");
    url.searchParams.set("id", remoteId);
    url.searchParams.set("audioformat", "mp32");
    let res: Response;
    try {
      res = await this.#fetch(url);
    } catch (e) {
      throw new RemoteSourceError(`request failed: ${msg(e)}`);
    }
    if (!res.ok) return null;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    const results = Array.isArray(obj(json).results) ? obj(json).results : [];
    const first = obj((results as unknown[])[0]);
    const audio = str(first.audio);
    return audio === "" ? null : audio;
  }
}

/** Pure mapper exposed via the surrounding module so tests can call it
 *  without spinning the whole adapter. Returns a track with an extra
 *  `_audio` field that's later stripped before crossing the port. */
export function mapTrack(raw: unknown): RemoteTrack & { _audio: string } {
  const it = obj(raw);
  return {
    remoteId: String(it.id ?? ""),
    title: str(it.name),
    version: null,
    artist: str(it.artist_name),
    album: str(it.album_name),
    coverUrl:
      str(it.album_image) || str(it.image) || null,
    durationSec: num(it.duration),
    hires: false,
    explicit: false,
    _audio: str(it.audio),
  };
}

function stripInternal(t: RemoteTrack & { _audio: string }): RemoteTrack {
  const {
    remoteId, title, version, artist, album,
    coverUrl, durationSec, hires, explicit,
  } = t;
  return {
    remoteId, title, version, artist, album,
    coverUrl, durationSec, hires, explicit,
  };
}
