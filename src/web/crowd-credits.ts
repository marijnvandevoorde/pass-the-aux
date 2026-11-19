// Pure (DOM-free) record of which guest requested which track, so the
// desktop DJ can credit them in its queue and send the name along with
// Now Playing and Up Next (the crowd page shows "requested by").
// Persisted with the session so a refresh keeps the credits. Unit-tested.

/** Most credits kept: a long night stays well under this; the oldest go first. */
export const MAX_CREDITS = 500;
const MAX_NAME = 24; // the server caps `by` at 24 too

export class CrowdCredits {
  readonly #by = new Map<string, string>();

  /** Credit `by` for the track at `path`. Ignores blanks. */
  record(path: string | null | undefined, by: string | null | undefined): void {
    const name = typeof by === "string" ? by.trim().slice(0, MAX_NAME) : "";
    if (!path || name === "") return;
    this.#by.delete(path); // re-insert so it counts as the newest
    this.#by.set(path, name);
    while (this.#by.size > MAX_CREDITS) {
      const oldest = this.#by.keys().next().value;
      if (oldest === undefined) break;
      this.#by.delete(oldest);
    }
  }

  /** The guest who requested the track, or null (the DJ's own pick). */
  of(path: string | null | undefined): string | null {
    return path ? this.#by.get(path) ?? null : null;
  }

  clear(): void {
    this.#by.clear();
  }

  /** For session persistence: path → guest name, oldest first. */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#by);
  }

  /** Restore from a stored snapshot; junk entries are skipped. */
  restore(raw: unknown): void {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    for (const [path, by] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof by === "string") this.record(path, by);
    }
  }
}

interface CreditableTrack {
  name: string;
  path: string | null;
  bpm: number | null;
}

/** The crowd's Up Next: tracks with a path, each with its requester. */
export function creditedUpNext(
  tracks: readonly CreditableTrack[],
  credits: CrowdCredits,
): { name: string; path: string; bpm: number | null; by: string | null }[] {
  return tracks
    .filter((t): t is CreditableTrack & { path: string } => !!t.path)
    .map((t) => ({ name: t.name, path: t.path, bpm: t.bpm, by: credits.of(t.path) }));
}
