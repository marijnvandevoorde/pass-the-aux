// Pure (DOM-free) model of the mobile DJ's set: what's playing, where,
// and what's queued. mobile-dj.ts saves it to localStorage so a refresh
// mid-set loses nothing (crowd requests are drained from the server, so
// the phone holds the only copy). Same pattern as session.ts on desktop.
// Unit-tested.

const VERSION = 1;
export const MOBILE_STATE_KEY = "pta-mobile-state";

export interface MobileTrack {
  path: string;
  name: string;
  artist: string | null;
  camelot: string | null;
  bpm: number | null;
  by: string;
}

export interface MobileState {
  /** The session this set belongs to; a state from another session is
   *  ignored on restore. */
  sessionId: string;
  nowPlaying: MobileTrack | null;
  /** Playhead of `nowPlaying` in seconds when saved. */
  positionSec: number;
  /** Whether it was playing (the restore can't autoplay without a tap,
   *  but it says so). */
  playing: boolean;
  queue: MobileTrack[];
  /** Played tracks not yet reported to the server. */
  pendingPlayed: string[];
}

export function serializeMobileState(s: MobileState): string {
  return JSON.stringify({ v: VERSION, s });
}

function isTrack(t: unknown): t is MobileTrack {
  if (typeof t !== "object" || t === null) return false;
  const o = t as Record<string, unknown>;
  return typeof o.path === "string" && o.path !== "" && typeof o.name === "string";
}

function cleanTrack(t: MobileTrack): MobileTrack {
  return {
    path: t.path,
    name: t.name,
    artist: typeof t.artist === "string" ? t.artist : null,
    camelot: typeof t.camelot === "string" ? t.camelot : null,
    bpm: typeof t.bpm === "number" && Number.isFinite(t.bpm) ? t.bpm : null,
    by: typeof t.by === "string" ? t.by : "you",
  };
}

/** Parse a stored payload; null on missing / corrupt / version mismatch.
 *  Malformed tracks are dropped rather than failing the whole set. */
export function parseMobileState(raw: string | null | undefined): MobileState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: number; s?: unknown };
    if (o.v !== VERSION || typeof o.s !== "object" || o.s === null) return null;
    const s = o.s as Record<string, unknown>;
    if (typeof s.sessionId !== "string" || !Array.isArray(s.queue)) return null;
    const pos = typeof s.positionSec === "number" && Number.isFinite(s.positionSec) && s.positionSec > 0
      ? s.positionSec
      : 0;
    return {
      sessionId: s.sessionId,
      nowPlaying: isTrack(s.nowPlaying) ? cleanTrack(s.nowPlaying) : null,
      positionSec: pos,
      playing: s.playing === true,
      queue: (s.queue as unknown[]).filter(isTrack).map(cleanTrack),
      pendingPlayed: Array.isArray(s.pendingPlayed)
        ? (s.pendingPlayed as unknown[]).filter((p): p is string => typeof p === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** What to bring back for this session: only tracks that are still in
 *  the library (a deleted file would fail to load mid-set), no
 *  duplicates, and nothing queued that is already playing. Null when
 *  the saved state is for another session or holds nothing. */
export function restorableState(
  s: MobileState | null,
  sessionId: string,
  libraryPaths: ReadonlySet<string>,
): MobileState | null {
  if (!s || s.sessionId !== sessionId) return null;
  // An empty library means it failed to load: keep everything rather
  // than throw the set away.
  const known = (p: string): boolean => libraryPaths.size === 0 || libraryPaths.has(p);
  const nowPlaying = s.nowPlaying && known(s.nowPlaying.path) ? s.nowPlaying : null;
  const seen = new Set<string>(nowPlaying ? [nowPlaying.path] : []);
  const queue = s.queue.filter((t) => {
    if (!known(t.path) || seen.has(t.path)) return false;
    seen.add(t.path);
    return true;
  });
  // A track that is gone still counts as played for the crowd's dedup.
  const pendingPlayed = [...s.pendingPlayed];
  if (s.nowPlaying && !nowPlaying) pendingPlayed.push(s.nowPlaying.path);
  if (!nowPlaying && queue.length === 0 && pendingPlayed.length === 0) return null;
  return {
    sessionId,
    nowPlaying,
    positionSec: nowPlaying ? s.positionSec : 0,
    playing: nowPlaying ? s.playing : false,
    queue,
    pendingPlayed,
  };
}
