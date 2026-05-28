// Pure (DOM-free) record of what has been played / queued this session,
// so the smart auto-fill never serves the same track twice.
// Session-scoped only: a fresh page load starts empty (no persistence).
//
// Policy: auto-selection must consult `has()` and skip seen tracks; a
// manual queue/load is never blocked — it just calls `record()` anyway.

export class SessionHistory {
  readonly #seen = new Set<string>();

  /** Mark a track id as played/queued. No-ops on empty/null ids. */
  record(id: string | null | undefined): void {
    if (id) this.#seen.add(id);
  }

  /** Has this track already been played/queued this session? */
  has(id: string | null | undefined): boolean {
    return id != null && this.#seen.has(id);
  }

  get size(): number {
    return this.#seen.size;
  }

  clear(): void {
    this.#seen.clear();
  }

  /** All seen ids (for session persistence). */
  snapshot(): string[] {
    return [...this.#seen];
  }
}
