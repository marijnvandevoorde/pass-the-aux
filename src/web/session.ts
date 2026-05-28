// Pure (DOM-free) automix-session model: (de)serialise + the resume
// decision. The localStorage / automix glue lives in app.ts; this is the
// testable seam. Unit-tested.

const VERSION = 1;
export const SESSION_KEY = "passtheaux.session";

export interface SessionConfig {
  automix: boolean;
  autoFill: boolean;
  beatSync: boolean;
  fadeSeconds: number;
  /** snap target for the manual "Fade to next" button.
   *  Optional → old stored sessions default to "downbeat". */
  snapTo?: "beat" | "downbeat";
}

export interface SessionTrack {
  name: string;
  path: string | null;
  bpm: number | null;
}

/** A loaded deck's restorable identity (audio nodes aren't
 *  serialisable; the track path + position + play-state are). */
export interface SessionDeck {
  path: string;
  offsetSec: number;
  playing: boolean;
}

export interface SessionState {
  id: string | null;
  config: SessionConfig;
  queue: SessionTrack[];
  played: string[];
  /** Legacy single-track resume (kept for back-compat). */
  active: { path: string; offsetSec: number } | null;
  /** Both decks, so a refresh doesn't lose them / shift the queue.
   *  Optional → old stored sessions still parse. */
  decks?: { A: SessionDeck | null; B: SessionDeck | null };
}

export function emptySession(): SessionState {
  return {
    id: null,
    config: { automix: false, autoFill: false, beatSync: true, fadeSeconds: 8, snapTo: "downbeat" },
    queue: [],
    played: [],
    active: null,
    decks: { A: null, B: null },
  };
}

export function serialize(s: SessionState): string {
  return JSON.stringify({ v: VERSION, s });
}

/** Parse a stored payload; null on missing / corrupt / version mismatch. */
export function parse(raw: string | null | undefined): SessionState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as { v?: number; s?: unknown };
    if (o.v !== VERSION || typeof o.s !== "object" || o.s === null) return null;
    const s = o.s as SessionState;
    if (!s.config || !Array.isArray(s.queue) || !Array.isArray(s.played)) {
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export type Resume =
  | { kind: "resume"; path: string; offsetSec: number }
  | { kind: "next" }
  | { kind: "none" };

/**
 * Decide how to pick up a restored session: resume the in-progress
 * track at its offset if it still exists in the library, else start the
 * next queued track, else nothing.
 */
export function resumeDecision(
  s: SessionState,
  libraryPaths: ReadonlySet<string>,
): Resume {
  if (
    s.active &&
    s.active.path &&
    libraryPaths.has(s.active.path) &&
    Number.isFinite(s.active.offsetSec) &&
    s.active.offsetSec >= 0
  ) {
    return { kind: "resume", path: s.active.path, offsetSec: s.active.offsetSec };
  }
  if (s.queue.some((t) => t.path && libraryPaths.has(t.path))) {
    return { kind: "next" };
  }
  return { kind: "none" };
}
