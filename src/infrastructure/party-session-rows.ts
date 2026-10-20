// Shared by the sqlite and mysql party-session repositories: how the
// rows map to a StoredPartySession.
import { createHash } from "node:crypto";
import type { NowPlaying, SessionConfigDTO, SessionQueueItem } from "../domain/party-session.ts";
import type { StoredPartySession, StoredRequest } from "../domain/ports/party-session-repository.ts";

/** Track paths can be long; votes and played tracks are keyed by a hash. */
export function pathKey(path: string): string {
  return createHash("sha1").update(path).digest("hex");
}

export interface SessionRow {
  id: string;
  owner_user_id: string;
  config: string;
  now_playing: string | null;
  now_playing_at: number | bigint | null;
  up_next: string | null;
  rev: number | bigint;
  created_at: number | bigint;
  updated_at: number | bigint;
}

export interface RequestRow {
  seq: number | bigint;
  name: string;
  path: string;
  bpm: number | null;
  by_name: string | null;
}

function json<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

const DEFAULT_CONFIG: SessionConfigDTO = {
  automix: false,
  autoFill: false,
  beatSync: true,
  fadeSeconds: 8,
  showUpNext: true,
};

export function toStored(
  s: SessionRow,
  requests: RequestRow[],
  played: Array<{ path: string }>,
  votes: Array<{ path: string; guest: string }>,
): StoredPartySession {
  return {
    id: s.id,
    ownerUserId: s.owner_user_id,
    createdAt: Number(s.created_at),
    updatedAt: Number(s.updated_at),
    rev: Number(s.rev),
    config: { ...DEFAULT_CONFIG, ...json<Partial<SessionConfigDTO>>(s.config, {}) },
    nowPlaying: json<NowPlaying | null>(s.now_playing, null),
    nowPlayingAt: s.now_playing_at === null ? null : Number(s.now_playing_at),
    upNext: json<SessionQueueItem[] | null>(s.up_next, null),
    requests: requests.map(
      (r): StoredRequest => ({
        seq: Number(r.seq),
        name: r.name,
        path: r.path,
        bpm: r.bpm,
        by: r.by_name,
      }),
    ),
    played: played.map((p) => p.path),
    votes: votes.map((v) => ({ path: v.path, guest: v.guest })),
  };
}

/** The `SET …` part and values for a saveState patch. */
export function statePatch(patch: {
  config?: SessionConfigDTO;
  nowPlaying?: { track: NowPlaying | null; at: number | null };
  upNext?: SessionQueueItem[];
}): { sets: string[]; values: Record<string, string | number | null> } {
  const sets: string[] = [];
  const values: Record<string, string | number | null> = {};
  if (patch.config) {
    sets.push("config = :config");
    values.config = JSON.stringify(patch.config);
  }
  if (patch.nowPlaying) {
    sets.push("now_playing = :np", "now_playing_at = :npAt");
    values.np = patch.nowPlaying.track ? JSON.stringify(patch.nowPlaying.track) : null;
    values.npAt = patch.nowPlaying.at;
  }
  if (patch.upNext) {
    sets.push("up_next = :upNext");
    values.upNext = JSON.stringify(patch.upNext);
  }
  return { sets, values };
}
