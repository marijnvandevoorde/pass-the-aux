/** Most tracks remembered as wanted per user; the oldest drop off. */
const MAX_WANTED = 64;
/** A track built (or tried) recently isn't asked for again this soon, so
 *  a deck that re-fetches a grid that can't be built doesn't start a new
 *  sweep every time. */
const COOLDOWN_MS = 10 * 60_000;

/**
 * Tracks that need a beat grid soon: loaded on a deck, queued, or
 * requested by the crowd. {@link BuildBeatGrids} takes these before the
 * rest of the library, which it otherwise walks in library order.
 * In-memory, process lifetime, shared by all users (keyed by user id).
 */
export class GridDemand {
  readonly #wanted = new Map<string, string[]>();
  readonly #recent = new Map<string, number>();
  /** Tracks being built right now (`uid\nid`): the wanted lane and the
   *  library sweep run side by side and must not send one track twice. */
  readonly #claimed = new Set<string>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** Ask for grids for `trackIds` (in order of urgency). Listeners hear
   *  about it when at least one id is new. */
  want(uid: string, trackIds: readonly string[]): void {
    const list = this.#wanted.get(uid) ?? [];
    const now = this.#now();
    let added = false;
    for (const id of trackIds) {
      if (id === "" || list.includes(id)) continue;
      const at = this.#recent.get(`${uid}\n${id}`);
      if (at !== undefined && now - at < COOLDOWN_MS) continue;
      list.push(id);
      added = true;
    }
    if (list.length > MAX_WANTED) list.splice(0, list.length - MAX_WANTED);
    this.#wanted.set(uid, list);
    if (added) for (const l of this.#listeners) l();
  }

  /** The most urgent wanted track among `candidates` that nobody is
   *  building yet, if any. */
  next(uid: string, candidates: ReadonlySet<string>): string | undefined {
    return this.#wanted
      .get(uid)
      ?.find((id) => candidates.has(id) && !this.#claimed.has(`${uid}\n${id}`));
  }

  /** Take a track to build it. False when another run is on it. */
  claim(uid: string, trackId: string): boolean {
    const k = `${uid}\n${trackId}`;
    if (this.#claimed.has(k)) return false;
    this.#claimed.add(k);
    return true;
  }

  release(uid: string, trackId: string): void {
    this.#claimed.delete(`${uid}\n${trackId}`);
  }

  /** Users with wanted tracks, for the wanted-grid lane. */
  users(): string[] {
    return [...this.#wanted].filter(([, l]) => l.length > 0).map(([uid]) => uid);
  }

  /** The track has been handled (built, skipped or given up on). */
  done(uid: string, trackId: string): void {
    const list = this.#wanted.get(uid);
    const i = list?.indexOf(trackId) ?? -1;
    if (list && i >= 0) list.splice(i, 1);
    const now = this.#now();
    this.#recent.set(`${uid}\n${trackId}`, now);
    if (this.#recent.size > 1000) {
      for (const [k, at] of this.#recent) {
        if (now - at >= COOLDOWN_MS) this.#recent.delete(k);
      }
    }
  }

  wanted(uid: string): readonly string[] {
    return this.#wanted.get(uid) ?? [];
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

/** Per-user entry point for the HTTP layer: the DJ's browser reports its
 *  queue, the crowd queue reports requests. */
export class PrioritizeBeatGrids {
  readonly #demand: GridDemand;
  readonly #userId: string;

  constructor(demand: GridDemand, userId = "") {
    this.#demand = demand;
    this.#userId = userId;
  }

  /** Accepts an array of library paths; anything else is ignored. */
  execute(paths: unknown): void {
    if (!Array.isArray(paths)) return;
    const ids = paths
      .filter((p): p is string => typeof p === "string")
      .map((p) => p.trim())
      .filter((p) => p !== "" && p.length <= 1024)
      .slice(0, 32);
    this.#demand.want(this.#userId, ids);
  }
}
