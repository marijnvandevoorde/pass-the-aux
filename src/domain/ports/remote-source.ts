import type { Readable } from "node:stream";

/** A track discovered in a remote library — transport-agnostic. */
export interface RemoteTrack {
  /** Opaque remote identifier (the service's track id, as a string). */
  remoteId: string;
  title: string;
  /** Edition note, e.g. "Remastered"; `null` when absent. */
  version: string | null;
  artist: string;
  album: string;
  /** Thumbnail cover URL, or `null` when the service gave none. */
  coverUrl: string | null;
  /** The cover needs the source's credentials: fetch it with
   *  `RemoteSource.cover(remoteId)`, not from `coverUrl` directly. */
  coverViaSource?: boolean;
  durationSec: number;
  hires: boolean;
  explicit: boolean;
}

/** One page of remote search results (the service returns 10 per page). */
export interface RemoteSearchPage {
  /** Mapped, streamable-only tracks for this page. */
  items: RemoteTrack[];
  /** Total matches the service reports — used to paginate (`offset` += 10). */
  total: number;
  /** The offset this page was fetched at. */
  offset: number;
}

/** The bytes of a downloaded remote track plus how to name/serve them.
 *
 *  Audio quality is a server-side decision — each remote is configured by
 *  its operator to return one format. The mixer just receives whatever the
 *  server sends and derives the file extension from `Content-Type`. */
export interface RemoteAudio {
  /** Raw audio byte stream. */
  stream: Readable;
  /** e.g. `"audio/flac"` | `"audio/mpeg"`. */
  contentType: string;
  /** File extension without the dot, derived from `Content-Type`. */
  ext: string;
  /** Total bytes when the service sent `Content-Length`, else `null`. */
  size: number | null;
}

/** Result of a "test connection": whether the store answers with the
 *  configured credentials, in words the DJ can act on. */
export interface RemoteCheck {
  ok: boolean;
  message: string;
  /** Tracks the store holds, when it says. */
  tracks: number | null;
  /** The store is still indexing; search results may be incomplete. */
  indexing: boolean;
}

/** A cover picture fetched through the source. */
export interface RemoteCover {
  data: Uint8Array;
  mime: string;
}

/**
 * A remote, user-operated music source the mixer can search and pull
 * tracks from. Multiple sources can be registered at once (a self-hosted
 * music server, Jamendo, FMA, etc.); each one carries a stable `id` so
 * the client can route search/import calls to the right backend.
 *
 * The mixer is a plain client — there is deliberately no authentication,
 * secret, or request signing in this port or its adapters.
 */
export interface RemoteSource {
  /** Stable identifier used to route requests (e.g. `"jamendo"`). */
  readonly id: string;
  /** UI-facing label shown in the source selector (e.g. `"Jamendo"`). */
  readonly displayName: string;
  /** `true` when this source has the config it needs to operate. */
  readonly enabled: boolean;

  /** One page of results for `query`, starting at `offset` (default 0). */
  search(query: string, offset?: number): Promise<RemoteSearchPage>;

  /** Open the audio byte stream for a remote track. The remote chooses
   *  the audio format; the mixer adapts to whatever `Content-Type` it
   *  receives. */
  download(remoteId: string): Promise<RemoteAudio>;

  /** Optional hint that the source is about to be used (the user opened
   *  the app). A source that runs on demand starts itself in the
   *  background; must not throw or block. */
  prepare?(): void;

  /** Optional reachability + credentials check ("test connection").
   *  Never throws; sources without it are checked with a search. */
  check?(): Promise<RemoteCheck>;

  /** Optional: the cover of a track whose `coverViaSource` is set. */
  cover?(remoteId: string): Promise<RemoteCover | null>;
}
