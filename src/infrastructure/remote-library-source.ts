import { Readable } from "node:stream";
import { RemoteDisabledError, RemoteSourceError } from "../domain/errors.ts";
import type {
  RemoteAudio,
  RemoteSearchPage,
  RemoteSource,
  RemoteTrack,
} from "../domain/ports/remote-source.ts";

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
function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
      .map(mapTrack);
    const total = typeof tracks.total === "number" ? tracks.total : items.length;
    return { items, total, offset };
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
      throw new RemoteSourceError(`request failed: ${msg(e)}`);
    });
  }
}

function mapTrack(raw: unknown): RemoteTrack {
  const it = obj(raw);
  const album = obj(it.album);
  const image = obj(album.image);
  const version = str(it.version).trim();
  return {
    remoteId: String(it.id ?? ""),
    title: str(it.title),
    version: version === "" ? null : version,
    artist: str(obj(it.performer).name),
    album: str(album.title),
    coverUrl:
      str(image.thumbnail) ||
      str(image.small) ||
      str(image.large) ||
      null,
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
