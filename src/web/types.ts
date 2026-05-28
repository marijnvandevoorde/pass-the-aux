export type DeckId = "A" | "B";

/** A track as the client tracks it (server library entry or a dropped file). */
export interface TrackInfo {
  id?: string;
  path: string | null;
  name: string;
  dir?: string;
  bpm: number | null;
}

export interface CratesResponse {
  crates: Array<{ name: string; trackIds: string[] }>;
}

/** A remote-library track, as the server's RemoteSource maps it. */
export interface RemoteTrackInfo {
  remoteId: string;
  title: string;
  version: string | null;
  artist: string;
  album: string;
  coverUrl: string | null;
  durationSec: number;
  hires: boolean;
  explicit: boolean;
}

export interface RemoteSearchResponse {
  items: RemoteTrackInfo[];
  total: number;
  offset: number;
  enabled: boolean;
}

export interface RemoteStatusResponse {
  enabled: boolean;
}

export interface RemoteImportResponse {
  ok: boolean;
  path: string;
}

export type RemoteStoreKind = "pta" | "jamendo" | "fma";

/** One user-configured remote store, as the server returns it.
 *  `apiKey` is never sent over the wire. */
export interface RemoteStorePublic {
  id: string;
  kind: RemoteStoreKind;
  name: string;
  baseUrl: string | null;
  isActive: boolean;
  createdAt: number;
}

export interface RemoteStoreInput {
  kind: RemoteStoreKind;
  name: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

/** server-computed beat grid for one track, delivered
 *  lazily when a deck loads. */
export interface BeatGridResponse {
  path: string;
  durationSec: number;
  beats: number[];
  downbeatPhase: 0 | 1 | 2 | 3;
  firstSolidCueSec: number | null;
  confidence: number;
}

export interface LibraryResponse {
  musicDir: string;
  count: number;
  /** pagination. Older callers ignore these. */
  total?: number;
  offset?: number;
  limit?: number;
  tracks: Array<{
    id: string;
    path: string;
    name: string;
    display: string;
    title: string | null;
    artist: string | null;
    dir: string;
    ext: string;
    size: number;
    mtime: number;
    bpm: number | null;
    key: string | null;
    mode: string | null;
    camelot: string | null;
    energy: number | null;
  }>;
}
