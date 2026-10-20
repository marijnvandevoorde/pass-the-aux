// Pure (DOM-free) memory of cue points the DJ set by hand, per track.
// Automix presets the next track's cue to its mix-in point; a manual cue
// must win over that, also when the track is queued again later in the
// night or after a page refresh. The localStorage glue lives in app.ts.

const MAX_ENTRIES = 500;

export class CueMemory {
  readonly #cues = new Map<string, number>();

  get(key: string | null | undefined): number | null {
    if (!key) return null;
    return this.#cues.get(key) ?? null;
  }

  set(key: string | null | undefined, sec: number): void {
    if (!key || !Number.isFinite(sec) || sec < 0) return;
    this.#cues.delete(key); // re-insert: most recent last
    this.#cues.set(key, Math.round(sec * 1000) / 1000);
    while (this.#cues.size > MAX_ENTRIES) {
      const oldest = this.#cues.keys().next().value;
      if (oldest === undefined) break;
      this.#cues.delete(oldest);
    }
  }

  delete(key: string | null | undefined): void {
    if (key) this.#cues.delete(key);
  }

  serialize(): string {
    return JSON.stringify([...this.#cues]);
  }

  static parse(raw: string | null | undefined): CueMemory {
    const m = new CueMemory();
    if (!raw) return m;
    try {
      const rows: unknown = JSON.parse(raw);
      if (!Array.isArray(rows)) return m;
      for (const row of rows) {
        if (
          Array.isArray(row) &&
          typeof row[0] === "string" &&
          typeof row[1] === "number"
        ) {
          m.set(row[0], row[1]);
        }
      }
    } catch {
      // corrupt → start empty
    }
    return m;
  }
}

/** Where the incoming track should start in an automatic mix: the
 *  pass-the-beat mix-in point (first solid downbeat), when the grid has
 *  one. Null leaves the cue alone. */
export function mixInPoint(grid: {
  firstSolidCueSec: number | null;
}): number | null {
  const t = grid.firstSolidCueSec;
  return t !== null && Number.isFinite(t) && t >= 0 ? t : null;
}
