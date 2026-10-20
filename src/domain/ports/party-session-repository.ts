import type { NowPlaying, SessionConfigDTO, SessionQueueItem } from "../party-session.ts";

/** A crowd request the DJ hasn't picked up yet; `seq` orders them. */
export interface StoredRequest extends SessionQueueItem {
  seq: number;
}

/** A party session as stored. `rev` goes up on every change, so a
 *  process can tell cheaply whether its cached copy is stale (another
 *  pod wrote, e.g. during a rolling deploy). */
export interface StoredPartySession {
  id: string;
  ownerUserId: string;
  createdAt: number;
  /** Last activity; idle sessions are deleted after a while. */
  updatedAt: number;
  rev: number;
  config: SessionConfigDTO;
  nowPlaying: NowPlaying | null;
  nowPlayingAt: number | null;
  upNext: SessionQueueItem[] | null;
  /** Undelivered crowd requests, oldest first. */
  requests: StoredRequest[];
  /** Tracks played or requested (no replays). */
  played: string[];
  /** One row per guest vote, in the order they were cast. */
  votes: Array<{ path: string; guest: string }>;
}

/** Durable party sessions, so a restart or deploy doesn't end the
 *  party. Every write except `touch` bumps `rev` and `updatedAt`. The
 *  set-like writes (votes, played) are idempotent and requests are rows,
 *  so two processes writing the same session never undo each other. */
export interface PartySessionRepository {
  load(id: string): Promise<StoredPartySession | null>;
  /** The stored `rev`, or null when the session is gone. */
  rev(id: string): Promise<number | null>;
  /** Insert a new session; false (and nothing changes) when the id exists. */
  create(s: { id: string; ownerUserId: string; config: SessionConfigDTO; at: number }): Promise<boolean>;
  /** Update the session-level fields that are given. */
  saveState(
    id: string,
    patch: {
      config?: SessionConfigDTO;
      nowPlaying?: { track: NowPlaying | null; at: number | null };
      upNext?: SessionQueueItem[];
    },
    at: number,
  ): Promise<void>;
  /** Store a crowd request; returns its `seq`. */
  addRequest(id: string, item: SessionQueueItem, at: number): Promise<number>;
  /** The DJ picked these requests up. */
  removeRequests(id: string, seqs: number[], at: number): Promise<void>;
  addPlayed(id: string, paths: string[], at: number): Promise<void>;
  clearPlayed(id: string, at: number): Promise<void>;
  /** Cast (`on`) or take back one guest's vote for a track. */
  setVote(id: string, path: string, guest: string, on: boolean, at: number): Promise<void>;
  /** Drop every vote for a track (the oldest voted track, over the cap). */
  dropVotes(id: string, path: string, at: number): Promise<void>;
  /** Mark the session active without counting it as a change. */
  touch(id: string, at: number): Promise<void>;
  /** Delete sessions idle since before `cutoff`; returns how many. */
  deleteIdleSince(cutoff: number): Promise<number>;
}
