// In-memory shared automix-session store. The DJ app creates a
// session when Automix starts; the crowd page appends tracks; the DJ
// drains those into its live queue. Process-lifetime only.
//
// Model: crowd adds go to `pending` (undelivered) and into `played`
// (so the same track can't be re-queued — SESSION·4). The DJ drains
// `pending` on its poll and tells us what it has actually played.

export interface SessionConfigDTO {
  automix: boolean;
  autoFill: boolean;
  beatSync: boolean;
  fadeSeconds: number;
}

export interface SessionQueueItem {
  name: string;
  path: string;
  bpm: number | null;
}

export interface SessionSnapshot {
  id: string;
  config: SessionConfigDTO;
  pending: SessionQueueItem[];
  played: string[];
}

interface Entry {
  id: string;
  createdAt: number;
  config: SessionConfigDTO;
  pending: SessionQueueItem[];
  played: Set<string>;
  /** the account that owns this session (whose music dir the
   *  crowd searches/queues into). "" when auth is disabled. */
  ownerUserId: string;
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

export class SessionStore {
  readonly #m = new Map<string, Entry>();

  /** Register a session. The DJ may pick the id (`desiredId`); if it
   *  already exists the call is idempotent — the existing session
   *  (its queue/played history) is kept and its id returned, so the
   *  DJ can reconnect to it after a refresh. An empty/absent
   *  `desiredId` gets an auto-generated one. */
  create(
    config: SessionConfigDTO,
    desiredId?: unknown,
    ownerUserId = "",
  ): string {
    const wanted = sanitizeSessionId(desiredId);
    if (wanted !== "") {
      const existing = this.#m.get(wanted);
      if (existing) return existing.id; // idempotent: keep owner+history
      this.#m.set(wanted, {
        id: wanted,
        createdAt: Date.now(),
        config,
        pending: [],
        played: new Set(),
        ownerUserId,
      });
      return wanted;
    }
    const id = newId();
    this.#m.set(id, {
      id,
      createdAt: Date.now(),
      config,
      pending: [],
      played: new Set(),
      ownerUserId,
    });
    return id;
  }

  has(id: string): boolean {
    return this.#m.has(id);
  }

  /** the music-library owner the crowd page should act within. */
  ownerOf(id: string): string {
    return this.#m.get(id)?.ownerUserId ?? "";
  }

  get(id: string): SessionSnapshot | null {
    const e = this.#m.get(id);
    if (!e) return null;
    return {
      id: e.id,
      config: e.config,
      pending: [...e.pending],
      played: [...e.played],
    };
  }

  /** Crowd add. Rejects a track already played/queued (SESSION·4). */
  enqueue(
    id: string,
    item: SessionQueueItem,
  ): "ok" | "not-found" | "played" {
    const e = this.#m.get(id);
    if (!e) return "not-found";
    if (e.played.has(item.path)) return "played";
    e.pending.push(item);
    e.played.add(item.path);
    return "ok";
  }

  /** Whether a track id would be rejected as a replay. */
  isPlayed(id: string, path: string): boolean {
    return this.#m.get(id)?.played.has(path) ?? false;
  }

  /** DJ poll: take undelivered crowd adds and record what it has
   *  played/loaded so far. */
  drain(id: string, alsoPlayed: string[] = []): SessionQueueItem[] {
    const e = this.#m.get(id);
    if (!e) return [];
    for (const p of alsoPlayed) e.played.add(p);
    const out = e.pending;
    e.pending = [];
    return out;
  }

  /** Wipe the played-tracks dedup set so guests can re-request previously
   *  played songs. Leaves the pending queue and ownership untouched.
   *  Returns true when the session existed. */
  clearPlayed(id: string): boolean {
    const e = this.#m.get(id);
    if (!e) return false;
    e.played.clear();
    return true;
  }
}
