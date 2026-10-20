import { Readable } from "node:stream";
import { describeFetchError } from "./fetch-error.ts";
import { RemoteDisabledError, RemoteSourceError } from "../domain/errors.ts";
import type {
  RemoteAudio,
  RemoteCheck,
  RemoteCover,
  RemoteSearchPage,
  RemoteSource,
  RemoteTrack,
} from "../domain/ports/remote-source.ts";

/** Largest cover accepted from a remote. */
const COVER_MAX_BYTES = 2 * 1024 * 1024;
/** Raster types only: an SVG served from our origin could carry script. */
const COVER_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

export interface RemoteLibraryOptions {
  /** Stable id for this remote (the DB row id, or a built-in adapter id). */
  id: string;
  /** UI-facing label shown in the source switcher. */
  displayName: string;
  /** Base URL of the remote; `null`/empty disables the source. */
  baseUrl: string | null;
  /** Shared secret sent as `Authorization: Bearer <secret>`. The
   *  remote validates it; `null` disables the source. */
  secret: string | null;
  /** Optional `Token-Country` ISO code for region-specific catalogues. */
  country?: string | null;
  /** Injectable `fetch` (defaults to the global) — used by unit tests. */
  fetchImpl?: typeof fetch;
}

/** Map an `audio/*` content-type to a sensible file extension. */
const CT_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/aac": "m4a",
  "audio/x-m4a": "m4a",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
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
/**
 * Adapter for the unified Pass the Aux remote-library wire contract:
 * two unauthenticated-by-default GET endpoints, with a Bearer secret
 * the remote validates. Audio quality is the operator's choice — this
 * adapter just streams whatever bytes the remote returns and derives
 * the file extension from `Content-Type`.
 *
 * One instance per configured remote; the chosen `id` matches the
 * remote_libraries row id so the registry can route by it.
 */
export class RemoteLibrarySource implements RemoteSource {
  readonly id: string;
  readonly displayName: string;
  readonly #base: string | null;
  readonly #secret: string | null;
  readonly #country: string | null;
  readonly #fetch: typeof fetch;

  constructor(opts: RemoteLibraryOptions) {
    this.id = opts.id;
    this.displayName = opts.displayName;
    const base = (opts.baseUrl ?? "").trim().replace(/\/+$/, "");
    this.#base = base === "" ? null : base;
    this.#secret = (opts.secret ?? "").trim() || null;
    this.#country = (opts.country ?? "").trim() || null;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  get enabled(): boolean {
    return this.#base !== null && this.#secret !== null;
  }

  async search(query: string, offset = 0): Promise<RemoteSearchPage> {
    const res = await this.#get("/api/get-music", { q: query, offset });
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new RemoteSourceError(`HTTP ${res.status} (non-JSON response)`);
    }
    const env = obj(json);
    if (env.success !== true) {
      const e = env.error;
      throw new RemoteSourceError(
        typeof e === "string" && e !== "" ? e : `HTTP ${res.status}`,
      );
    }
    const tracks = obj(obj(env.data).tracks);
    const rawItems = Array.isArray(tracks.items) ? tracks.items : [];
    const items = rawItems
      .filter((x) => obj(x).streamable !== false)
      .map((x) => mapTrack(x, this.#base));
    const total = typeof tracks.total === "number" ? tracks.total : items.length;
    const indexing = obj(obj(env.data).library).scanning === true;
    return indexing ? { items, total, offset, indexing } : { items, total, offset };
  }

  async download(remoteId: string): Promise<RemoteAudio> {
    const res = await this.#get("/api/stream-music", { track_id: remoteId });
    const ct = res.headers.get("content-type") ?? "";
    if (!res.ok || ct.includes("application/json")) {
      throw new RemoteSourceError(await readError(res));
    }
    if (!res.body) throw new RemoteSourceError("empty response body");
    const len = Number(res.headers.get("content-length"));
    const audioCt = ct.startsWith("audio/") ? ct : "audio/mpeg";
    return {
      stream: Readable.fromWeb(res.body),
      contentType: audioCt,
      ext: extFromContentType(audioCt),
      size: Number.isFinite(len) && len > 0 ? len : null,
    };
  }

  /** "Test connection": `GET /api/status` (pass-the-remote 0.2+), or a
   *  search on servers that don't have it. Never throws. */
  async check(): Promise<RemoteCheck> {
    const fail = (message: string): RemoteCheck => ({
      ok: false,
      message,
      tracks: null,
      indexing: false,
    });
    if (this.#base === null) return fail("no base URL set");
    if (this.#secret === null) return fail("no secret set");
    let res: Response;
    try {
      res = await this.#get("/api/status", {});
    } catch (e) {
      return fail(plain(e));
    }
    let body: Record<string, unknown> | null = null;
    try {
      body = obj(await res.json());
    } catch {
      body = null;
    }
    if (res.status === 404 || (res.ok && body === null)) {
      // An older pass-the-remote (or another server speaking the
      // contract) without /api/status: a search proves URL + secret.
      try {
        const page = await this.search("a");
        return {
          ok: true,
          message: `Connected (this server doesn't report its status; a test search found ${page.total} tracks)`,
          tracks: null,
          indexing: false,
        };
      } catch (e) {
        const m = plain(e);
        return fail(
          /non-JSON|HTTP 404/.test(m)
            ? `${m}: this URL doesn't answer like a Pass the Aux remote, check the base URL`
            : m,
        );
      }
    }
    if (body === null) return fail(`HTTP ${res.status} (not a Pass the Aux remote?)`);
    if (!res.ok || body.success !== true) {
      return fail(typeof body.error === "string" && body.error !== "" ? body.error : `HTTP ${res.status}`);
    }
    const data = obj(body.data);
    const tracks = typeof data.tracks === "number" ? data.tracks : null;
    const indexing = data.scanning === true;
    const lastError = typeof data.lastError === "string" ? data.lastError : null;
    const count = tracks === null ? "" : ` · ${tracks} track${tracks === 1 ? "" : "s"}`;
    let message = `Connected${count}`;
    if (indexing) message += " · still indexing, results may be incomplete";
    else if (lastError !== null) message += ` · the server says: ${lastError}`;
    return { ok: true, message, tracks, indexing };
  }

  /** A track's cover from the remote's `GET /api/cover` (it needs the
   *  secret, so the browser can't load it directly). */
  async cover(remoteId: string): Promise<RemoteCover | null> {
    let res: Response;
    try {
      res = await this.#get("/api/cover", { track_id: remoteId });
    } catch {
      return null;
    }
    const ct = (res.headers.get("content-type") ?? "").split(";", 1)[0]?.trim() ?? "";
    const len = Number(res.headers.get("content-length"));
    if (!res.ok || !COVER_TYPES.has(ct.toLowerCase()) || len > COVER_MAX_BYTES) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return data.byteLength > 0 && data.byteLength <= COVER_MAX_BYTES ? { data, mime: ct.toLowerCase() } : null;
  }

  #get(
    path: string,
    params: Record<string, string | number>,
  ): Promise<Response> {
    if (this.#base === null || this.#secret === null) {
      throw new RemoteDisabledError();
    }
    let url: URL;
    try {
      url = new URL(this.#base + path);
    } catch {
      throw new RemoteSourceError(`invalid base URL: ${this.#base}`);
    }
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#secret}`,
    };
    if (this.#country !== null) headers["Token-Country"] = this.#country;
    return this.#fetch(url, { headers }).catch((e: unknown) => {
      throw new RemoteSourceError(describeFetchError(e, url));
    });
  }
}

/** The message of a thrown error without the domain prefix. */
function plain(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m.replace(/^remote library: /, "");
}

/** Whether `url` lives on the remote's own host: then it needs the
 *  Bearer secret (pass-the-remote's /api/cover), unlike a CDN URL. */
function onHost(url: string, base: string | null): boolean {
  if (base === null) return false;
  try {
    return new URL(url, base).host === new URL(base).host;
  } catch {
    return false;
  }
}

function mapTrack(raw: unknown, base: string | null): RemoteTrack {
  const it = obj(raw);
  const album = obj(it.album);
  const image = obj(album.image);
  const version = str(it.version).trim();
  const coverUrl =
    str(image.thumbnail) || str(image.small) || str(image.large) || null;
  return {
    remoteId: String(it.id ?? ""),
    title: str(it.title),
    version: version === "" ? null : version,
    artist: str(obj(it.performer).name),
    album: str(album.title),
    coverUrl,
    ...(coverUrl !== null && onHost(coverUrl, base) ? { coverViaSource: true } : {}),
    durationSec: num(it.duration),
    hires: it.hires === true,
    explicit: it.parental_warning === true,
  };
}

async function readError(res: Response): Promise<string> {
  try {
    const j = obj(await res.json());
    if (typeof j.error === "string" && j.error !== "") return j.error;
  } catch {
    // not a JSON error body
  }
  return `HTTP ${res.status}`;
}
