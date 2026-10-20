// Shared party-session store. The DJ app creates a session when
// Automix starts; the crowd page appends tracks and votes; the DJ
// drains those into its live queue.
//
// Sessions live in memory for speed, with a PartySessionRepository
// behind them so a restart or deploy doesn't end the party: every
// change is written through (except the playhead, which the DJ
// re-sends every few seconds anyway), and a session this process
// doesn't know yet is loaded on first use, so guests' QR links keep
// working. A cached session is checked against the stored `rev` every
// few seconds, so a second process (a rolling deploy runs old and new
// pod side by side) picks up the other's changes. Idle sessions are
// deleted after PARTY_SESSION_TTL_MS (`sweep`).
//
// Model: crowd adds go to `pending` (undelivered) and into `played`
// (so the same track can't be re-queued — SESSION·4). The DJ drains
// `pending` on its poll and tells us what it has actually played.

import type {
  NowPlaying,
  SessionConfigDTO,
  SessionQueueItem,
} from "../domain/party-session.ts";
import type {
  PartySessionRepository,
  StoredPartySession,
  StoredRequest,
} from "../domain/ports/party-session-repository.ts";

export type { NowPlaying, SessionConfigDTO, SessionQueueItem };

const finiteNonNeg = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;

/** Validate the DJ's now-playing report: `null` clears it, `undefined`
 *  means "no change" (absent or malformed). */
export function parseNowPlaying(raw: unknown): NowPlaying | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== "object" || raw === undefined) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.name !== "string") return undefined;
  const durationSec = finiteNonNeg(o.durationSec);
  let positionSec = finiteNonNeg(o.positionSec);
  if (positionSec !== null && durationSec !== null) positionSec = Math.min(positionSec, durationSec);
  return {
    name: o.name,
    artist: typeof o.artist === "string" ? o.artist : null,
    bpm: typeof o.bpm === "number" ? o.bpm : null,
    path: typeof o.path === "string" ? o.path : null,
    by: typeof o.by === "string" ? o.by : null,
    positionSec,
    durationSec,
    playing: o.playing === true,
  };
}

export interface SessionSnapshot {
  id: string;
  config: SessionConfigDTO;
  pending: SessionQueueItem[];
  played: string[];
  nowPlaying: NowPlaying | null;
  nowPlayingAt: number | null;
  /** The DJ's queue as last reported, next first; null until a DJ client
   *  reports one (older clients), and the crowd shows `pending` then. */
  upNext: SessionQueueItem[] | null;
  /** Crowd votes per track path (tracks with at least one vote). */
  votes: Record<string, number>;
}

/** Most tracks with votes kept per session; the oldest drop off. */
const MAX_VOTED_TRACKS = 500;
/** Most guests counted per track. */
const MAX_VOTES_PER_TRACK = 1000;

/** A guest's anonymous id (random, kept on their phone): [a-z0-9], ≤ 32. */
export function sanitizeGuestId(raw: unknown): string {
  return typeof raw === "string" ? raw.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 32) : "";
}

/** Most queue entries kept from one report. */
const MAX_UP_NEXT = 100;

/** Validate the DJ's reported queue: `undefined` when absent/malformed
 *  (no change), else the well-formed entries, capped. */
export function parseUpNext(raw: unknown): SessionQueueItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SessionQueueItem[] = [];
  for (const it of raw) {
    if (out.length >= MAX_UP_NEXT) break;
    if (typeof it !== "object" || it === null) continue;
    const o = it as Record<string, unknown>;
    if (typeof o.name !== "string" || typeof o.path !== "string" || o.path === "") continue;
    out.push({
      name: o.name.slice(0, 300),
      path: o.path.slice(0, 1000),
      bpm: typeof o.bpm === "number" && Number.isFinite(o.bpm) ? o.bpm : null,
      by: typeof o.by === "string" ? o.by.slice(0, 40) : null,
    });
  }
  return out;
}

interface Entry {
  id: string;
  createdAt: number;
  config: SessionConfigDTO;
  /** Undelivered crowd requests; `seq` is -1 when not stored. */
  pending: StoredRequest[];
  played: Set<string>;
  /** the account that owns this session (whose music dir the
   *  crowd searches/queues into). "" when auth is disabled. */
  ownerUserId: string;
  nowPlaying: NowPlaying | null;
  nowPlayingAt: number | null;
  upNext: SessionQueueItem[] | null;
  /** track path → guest ids that voted for it. */
  votes: Map<string, Set<string>>;
  /** Stored rev this copy matches (plus our own writes). */
  rev: number;
  /** Whether the session row exists in the repository. */
  stored: boolean;
  /** When `rev` was last compared with the stored one. */
  checkedAt: number;
  /** Last use, for the idle sweep. */
  seenAt: number;
  /** Last time `seenAt` was written to the repository. */
  touchedAt: number;
  /** Writes still on their way to the repository. */
  inflight: number;
}

function newId(): string {
  const u = globalThis.crypto?.randomUUID?.();
  const raw = u ?? Math.random().toString(36).slice(2) + Date.now().toString(36);
  return raw.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
}

/** Normalise a DJ-chosen session id to something URL- and QR-safe:
 *  lowercase, only [a-z0-9_-], max 32 chars. Empty if nothing usable. */
export function sanitizeSessionId(raw: unknown): string {
  return typeof raw === "string"
    ? raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32)
    : "";
}

/** A session nobody has used for this long is deleted: the night of the
 *  party and the day after, so a QR link still works the next morning. */
export const PARTY_SESSION_TTL_MS = 48 * 3600_000;
/** How often a cached session is checked against the stored one. */
const REVALIDATE_MS = 5000;
/** How often plain use (polls) is written as activity. */
const TOUCH_MS = 10 * 60_000;

/** Did the track or its play state change (not just the playhead)? */
function sameTrack(a: NowPlaying | null, b: NowPlaying | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.path === b.path &&
    a.name === b.name &&
    a.artist === b.artist &&
    a.by === b.by &&
    (a.playing ?? false) === (b.playing ?? false)
  );
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export interface SessionStoreOptions {
  /** Where sessions are kept across restarts; null = memory only. */
  repo?: PartySessionRepository | null;
  now?: () => number;
  revalidateMs?: number;
  ttlMs?: number;
}

export class SessionStore {
  readonly #m = new Map<string, Entry>();
  readonly #loading = new Map<string, Promise<Entry | null>>();
  readonly #repo: PartySessionRepository | null;
  readonly #now: () => number;
  readonly #revalidateMs: number;
  readonly #ttlMs: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.#repo = opts.repo ?? null;
    this.#now = opts.now ?? Date.now;
    this.#revalidateMs = opts.revalidateMs ?? REVALIDATE_MS;
    this.#ttlMs = opts.ttlMs ?? PARTY_SESSION_TTL_MS;
  }

  #fresh(id: string, config: SessionConfigDTO, ownerUserId: string, stored: boolean): Entry {
    const now = this.#now();
    return {
      id,
      createdAt: now,
      config,
      pending: [],
      played: new Set(),
      ownerUserId,
      nowPlaying: null,
      nowPlayingAt: null,
      upNext: null,
      votes: new Map(),
      rev: 0,
      stored,
      checkedAt: now,
      seenAt: now,
      touchedAt: now,
      inflight: 0,
    };
  }

  #fromStored(s: StoredPartySession): Entry {
    const now = this.#now();
    const votes = new Map<string, Set<string>>();
    for (const v of s.votes) {
      let g = votes.get(v.path);
      if (!g) votes.set(v.path, (g = new Set()));
      g.add(v.guest);
    }
    return {
      id: s.id,
      createdAt: s.createdAt,
      config: s.config,
      pending: s.requests.map((r) => ({ ...r })),
      played: new Set(s.played),
      ownerUserId: s.ownerUserId,
      nowPlaying: s.nowPlaying,
      nowPlayingAt: s.nowPlayingAt,
      upNext: s.upNext,
      votes,
      rev: s.rev,
      stored: true,
      checkedAt: now,
      seenAt: Math.max(now, s.updatedAt),
      touchedAt: s.updatedAt,
      inflight: 0,
    };
  }

  /** One load or check per session at a time. */
  #once(id: string, fn: () => Promise<Entry | null>): Promise<Entry | null> {
    const busy = this.#loading.get(id);
    if (busy) return busy;
    const p = fn().finally(() => this.#loading.delete(id));
    this.#loading.set(id, p);
    return p;
  }

  async #load(id: string): Promise<Entry | null> {
    if (!this.#repo) return null;
    try {
      const s = await this.#repo.load(id);
      if (!s) return null;
      const e = this.#fromStored(s);
      this.#m.set(id, e);
      return e;
    } catch (err) {
      console.error(`party session ${id}: could not load: ${message(err)}`);
      return null;
    }
  }

  /** Reload when another process changed the stored session. */
  async #revalidate(e: Entry): Promise<Entry | null> {
    const repo = this.#repo;
    if (!repo || !e.stored || e.inflight > 0) return e;
    let rev: number | null;
    try {
      rev = await repo.rev(e.id);
    } catch (err) {
      console.error(`party session ${e.id}: could not check: ${message(err)}`);
      return e;
    }
    if (this.#m.get(e.id) !== e) return this.#m.get(e.id) ?? null;
    e.checkedAt = this.#now();
    if (rev === null) {
      this.#m.delete(e.id); // deleted elsewhere (idle sweep)
      return null;
    }
    if (rev === e.rev || e.inflight > 0) return e;
    let s: StoredPartySession | null;
    try {
      s = await repo.load(e.id);
    } catch (err) {
      console.error(`party session ${e.id}: could not reload: ${message(err)}`);
      return e;
    }
    if (this.#m.get(e.id) !== e || e.inflight > 0) return this.#m.get(e.id) ?? null;
    if (!s) {
      this.#m.delete(e.id);
      return null;
    }
    const next = this.#fromStored(s);
    // The playhead isn't stored on every tick: keep ours when it's newer.
    if (
      e.nowPlaying &&
      next.nowPlaying &&
      e.nowPlaying.path === next.nowPlaying.path &&
      (e.nowPlayingAt ?? 0) > (next.nowPlayingAt ?? 0)
    ) {
      next.nowPlaying = e.nowPlaying;
      next.nowPlayingAt = e.nowPlayingAt;
    }
    this.#m.set(e.id, next);
    return next;
  }

  /** The live session: cached, else loaded. `check` compares it with the
   *  stored copy now instead of every few seconds. */
  async #entry(id: string, check = false): Promise<Entry | null> {
    if (id === "" || sanitizeSessionId(id) !== id) return null;
    const e = this.#m.get(id);
    if (!e) return this.#repo ? this.#once(id, () => this.#load(id)) : null;
    const now = this.#now();
    e.seenAt = now;
    const repo = this.#repo;
    if (repo && e.stored && now - e.touchedAt >= TOUCH_MS) {
      e.touchedAt = now;
      repo.touch(id, now).catch((err: unknown) =>
        console.error(`party session ${id}: could not touch: ${message(err)}`),
      );
    }
    if (!check && now - e.checkedAt < this.#revalidateMs) return e;
    return this.#once(id, () => this.#revalidate(e));
  }

  /** Write a change through. Each repository write bumps the stored
   *  `rev` once, so `writes` says how many `fn` makes. A failed write is
   *  logged; the party carries on from memory. */
  async #write(
    e: Entry,
    fn: (repo: PartySessionRepository, at: number) => Promise<unknown>,
    writes = 1,
  ): Promise<void> {
    const repo = this.#repo;
    if (!repo || !e.stored) return;
    const at = this.#now();
    e.rev += writes;
    e.seenAt = at;
    e.touchedAt = at;
    e.inflight++;
    try {
      await fn(repo, at);
    } catch (err) {
      console.error(`party session ${e.id}: change not saved: ${message(err)}`);
    } finally {
      e.inflight--;
    }
  }

  /** Register a session. The DJ may pick the id (`desiredId`); if it
   *  already exists the call is idempotent — the existing session
   *  (its queue/played history) is kept and its id returned, so the
   *  DJ can reconnect to it after a refresh or a server restart. An
   *  empty/absent `desiredId` gets an auto-generated one. */
  async create(
    config: SessionConfigDTO,
    desiredId?: unknown,
    ownerUserId = "",
  ): Promise<string> {
    const wanted = sanitizeSessionId(desiredId);
    if (wanted !== "") {
      const existing = await this.#entry(wanted);
      if (existing) return existing.id; // idempotent: keep owner+history
    }
    const id = wanted !== "" ? wanted : newId();
    const e = this.#fresh(id, config, ownerUserId, false);
    this.#m.set(id, e);
    if (this.#repo) {
      try {
        if (await this.#repo.create({ id, ownerUserId, config, at: e.createdAt })) {
          e.stored = true;
        } else {
          // Another process created it meanwhile: use the stored one.
          const loaded = await this.#load(id);
          if (loaded) return loaded.id;
        }
      } catch (err) {
        console.error(`party session ${id}: not saved, memory only: ${message(err)}`);
      }
    }
    return id;
  }

  async has(id: string): Promise<boolean> {
    return (await this.#entry(id)) !== null;
  }

  /** the music-library owner the crowd page should act within. */
  async ownerOf(id: string): Promise<string> {
    return (await this.#entry(id))?.ownerUserId ?? "";
  }

  async get(id: string): Promise<SessionSnapshot | null> {
    const e = await this.#entry(id);
    if (!e) return null;
    return {
      id: e.id,
      config: e.config,
      pending: e.pending.map(({ seq: _seq, ...item }) => item),
      played: [...e.played],
      nowPlaying: e.nowPlaying,
      nowPlayingAt: e.nowPlayingAt,
      upNext: e.upNext ? [...e.upNext] : null,
      votes: counts(e),
    };
  }

  /** Votes per track path, for the DJ's queue and the crowd's Up Next. */
  async voteCounts(id: string): Promise<Record<string, number>> {
    const e = await this.#entry(id);
    return e ? counts(e) : {};
  }

  /** The tracks a guest has voted for. */
  async votesOf(id: string, guest: string): Promise<string[]> {
    const e = await this.#entry(id);
    if (!e || guest === "") return [];
    return [...e.votes].filter(([, g]) => g.has(guest)).map(([path]) => path);
  }

  /** A guest votes for a track (`on`) or takes the vote back. One vote
   *  per guest per track, so repeating either is harmless. */
  async vote(
    id: string,
    path: string,
    guest: string,
    on: boolean,
  ): Promise<{ count: number; voted: boolean } | "not-found" | "invalid"> {
    const e = await this.#entry(id);
    if (!e) return "not-found";
    if (path === "" || path.length > 1000 || guest === "") return "invalid";
    let guests = e.votes.get(path);
    if (on) {
      if (!guests) {
        guests = new Set();
        e.votes.set(path, guests);
        if (e.votes.size > MAX_VOTED_TRACKS) {
          const oldest = e.votes.keys().next().value;
          if (oldest !== undefined) {
            e.votes.delete(oldest);
            await this.#write(e, (r, at) => r.dropVotes(id, oldest, at));
          }
        }
      }
      if (guests.size < MAX_VOTES_PER_TRACK && !guests.has(guest)) {
        guests.add(guest);
        await this.#write(e, (r, at) => r.setVote(id, path, guest, true, at));
      }
    } else if (guests?.has(guest)) {
      guests.delete(guest);
      if (guests.size === 0) e.votes.delete(path);
      await this.#write(e, (r, at) => r.setVote(id, path, guest, false, at));
    }
    const now = e.votes.get(path);
    return { count: now?.size ?? 0, voted: now?.has(guest) ?? false };
  }

  /** The DJ's queue; stored only when it changed. */
  async setUpNext(id: string, items: SessionQueueItem[]): Promise<void> {
    const e = await this.#entry(id);
    if (!e) return;
    const changed = JSON.stringify(e.upNext) !== JSON.stringify(items);
    e.upNext = items;
    if (changed) await this.#write(e, (r, at) => r.saveState(id, { upNext: items }, at));
  }

  /** What's playing. The playhead moves on every report but is stored
   *  only with a new track or play/pause: the crowd extrapolates it. */
  async setNowPlaying(id: string, track: NowPlaying | null): Promise<void> {
    const e = await this.#entry(id);
    if (!e) return;
    const changed = !sameTrack(e.nowPlaying, track);
    e.nowPlaying = track;
    e.nowPlayingAt = track ? this.#now() : null;
    if (changed) {
      const at = e.nowPlayingAt;
      await this.#write(e, (r, now) => r.saveState(id, { nowPlaying: { track, at } }, now));
    }
  }

  /** Crowd add. Rejects a track already played/queued (SESSION·4). */
  async enqueue(
    id: string,
    item: SessionQueueItem,
  ): Promise<"ok" | "not-found" | "played"> {
    // Checked against the stored copy first: another process may have
    // queued or played it a moment ago.
    const e = await this.#entry(id, true);
    if (!e) return "not-found";
    if (e.played.has(item.path)) return "played";
    const req: StoredRequest = { ...item, seq: -1 };
    e.pending.push(req);
    e.played.add(item.path);
    await this.#write(e, async (r, at) => {
      req.seq = await r.addRequest(id, item, at);
      await r.addPlayed(id, [item.path], at);
    }, 2);
    return "ok";
  }

  /** Whether a track id would be rejected as a replay. */
  async isPlayed(id: string, path: string): Promise<boolean> {
    return (await this.#entry(id))?.played.has(path) ?? false;
  }

  /** DJ poll: take undelivered crowd adds and record what it has
   *  played/loaded so far. */
  async drain(id: string, alsoPlayed: string[] = []): Promise<SessionQueueItem[]> {
    let e = await this.#entry(id);
    if (!e) return [];
    // About to hand requests over: make sure no other process already did.
    if (e.pending.length > 0) e = await this.#entry(id, true);
    if (!e) return [];
    const added = alsoPlayed.filter((p) => !e.played.has(p));
    for (const p of added) e.played.add(p);
    const out = e.pending;
    e.pending = [];
    const seqs = out.map((q) => q.seq).filter((s) => s >= 0);
    if (added.length > 0) await this.#write(e, (r, at) => r.addPlayed(id, added, at));
    if (seqs.length > 0) await this.#write(e, (r, at) => r.removeRequests(id, seqs, at));
    return out.map(({ seq: _seq, ...item }) => item);
  }

  /** Merge a partial config into a live session (e.g. the DJ toggling
   *  "show queue to crowd"). Returns true when the session existed. */
  async patchConfig(id: string, patch: Partial<SessionConfigDTO>): Promise<boolean> {
    const e = await this.#entry(id);
    if (!e) return false;
    e.config = { ...e.config, ...patch };
    const config = e.config;
    await this.#write(e, (r, at) => r.saveState(id, { config }, at));
    return true;
  }

  async clearPlayed(id: string): Promise<boolean> {
    const e = await this.#entry(id);
    if (!e) return false;
    e.played.clear();
    await this.#write(e, (r, at) => r.clearPlayed(id, at));
    return true;
  }

  /** Forget sessions nobody used for the TTL, in memory and stored.
   *  Returns how many stored sessions were deleted. */
  async sweep(): Promise<number> {
    const cutoff = this.#now() - this.#ttlMs;
    for (const [id, e] of this.#m) if (e.seenAt < cutoff) this.#m.delete(id);
    if (!this.#repo) return 0;
    try {
      return await this.#repo.deleteIdleSince(cutoff);
    } catch (err) {
      console.error(`party sessions: idle sweep failed: ${message(err)}`);
      return 0;
    }
  }
}

function counts(e: Entry): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [path, guests] of e.votes) if (guests.size > 0) out[path] = guests.size;
  return out;
}
