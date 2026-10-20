// The one transition engine. Automix (automatic and on demand) and the
// manual "Fade to next" button both go through `startTransition`, so a
// mix sounds the same whichever way it was started.
//
// The scheduling decisions (snap point, incoming start, tempo target)
// live in `fade-to-next-plan.ts` so they can be unit-tested without a
// Web Audio context. This file turns a plan into audio:
//
//   1. tempo-match the (still stopped) incoming deck;
//   2. start it on the audio clock at the exact moment the outgoing deck
//      reaches the snap beat/bar (sample-accurate, no setTimeout jitter);
//   3. schedule the crossfade on the audio clock from that same moment
//      (keeps going in a hidden tab, unlike requestAnimationFrame);
//
// No phase-bend afterwards: with the start scheduled on the audio clock
// and both tempos taken from the grids' averages, the decks stay locked
// (measured: constant offset over a 8 s fade). An earlier phase-lock loop
// chased per-beat grid jitter and made it wobble.

import type { Deck } from "./deck.js";
import type { DeckId } from "./types.js";
import type { Mixer } from "./mixer.js";
import { planFade, type SnapTo } from "./fade-to-next-plan.js";

export type { SnapTo };

export interface TransitionHandle {
  /** Abort: an incoming deck that hasn't started yet is stopped again
   *  and the crossfader returns to the outgoing side. */
  cancel(): void;
}

export interface TransitionOpts {
  /** Wanted fade length; at the mix-out point it is fitted to whole bars
   *  of the outro. */
  durationSec: number;
  beatSync: boolean;
  snapTo: SnapTo;
  /** Start at this point of the outgoing track (its mix-out point)
   *  instead of the next beat/bar, when it is still ahead. */
  mixOutSec?: number | null;
  onStatus?: (status: string) => void;
  /** Live crossfader position (-1 .. +1) for the slider UI. */
  onCrossfade?: (pos: number) => void;
  /** Exactly once: when the fade completed, or was cancelled / taken over
   *  by the DJ grabbing the crossfader. */
  onDone?: (info: { cancelled: boolean }) => void;
}

const UI_TICK_MS = 50;

/**
 * Crossfade `from` → `to`. Returns null when `to` has nothing loaded.
 */
export function startTransition(
  mixer: Mixer,
  from: Deck,
  to: Deck,
  opts: TransitionOpts,
): TransitionHandle | null {
  if (!to.buffer) return null;
  const ctx = mixer.ctx;

  const plan = planFade(
    {
      id: from.id,
      currentTime: from.currentTime,
      rate: from.rate,
      tempoRate: from.tempoRate,
      baseBPM: from.baseBPM,
      cuePoint: from.cuePoint,
      beats: from.beats,
      downbeatPhase: from.downbeatPhase,
      downbeats: from.downbeats,
      durationSec: from.duration,
    },
    {
      id: to.id,
      baseBPM: to.baseBPM,
      cuePoint: to.cuePoint,
      firstSolidCueSec: to.firstSolidCueSec,
      beats: to.beats,
      downbeatPhase: to.downbeatPhase,
      downbeats: to.downbeats,
    },
    {
      snapTo: opts.snapTo,
      beatSync: opts.beatSync,
      mixOutSec: opts.mixOutSec ?? null,
      fadeSec: opts.durationSec,
    },
  );
  if (!plan) {
    opts.onStatus?.("could not plan a fade — try again");
    return null;
  }

  if (plan.tempoSyncTarget !== null) to.syncTo(plan.tempoSyncTarget);

  // When does the outgoing deck reach the snap point, on the audio clock?
  // A stopped outgoing deck has no snap point: just start now.
  const now = ctx.currentTime;
  const snapCtx = from.isPlaying ? from.ctxTimeAt(plan.snapAtSec) : null;
  const when = Math.max(now + 0.03, snapCtx ?? now + plan.waitMs / 1000);

  to.playAt(when, plan.incomingStartSec);

  const fromPos = from.id === "A" ? -1 : 1;
  const toPos = to.id === "A" ? -1 : 1;
  const startPos = mixer.crossfadePosition;
  const dur = Math.max(0.05, plan.fadeSec);
  const gen = mixer.scheduleCrossfade(startPos, toPos, when, dur);
  opts.onStatus?.(plan.status);

  let finished = false;

  const finish = (cancelled: boolean): void => {
    if (finished) return;
    finished = true;
    clearInterval(timer);
    opts.onDone?.({ cancelled });
  };

  const step = (): void => {
    if (finished) return;
    if (mixer.crossfadeGeneration !== gen) {
      // The DJ grabbed the crossfader: hand over, don't fight them.
      finish(true);
      return;
    }
    if (!to.buffer) {
      finish(true); // incoming ejected mid-fade
      return;
    }
    const t = ctx.currentTime;
    const p = Math.max(0, Math.min(1, (t - when) / dur));
    opts.onCrossfade?.(startPos + (toPos - startPos) * p);

    if (t >= when + dur) finish(false);
  };
  const timer = setInterval(step, UI_TICK_MS);

  return {
    cancel: (): void => {
      if (finished) return;
      if (ctx.currentTime < when) {
        // Not audible yet: put the incoming deck back on its cue.
        to.stop();
        to.seek(to.cuePoint);
        mixer.setCrossfade(fromPos);
        opts.onCrossfade?.(fromPos);
      } else {
        mixer.setCrossfade(mixer.crossfadePosition);
      }
      finish(true);
    },
  };
}

// ── Standalone "Fade to next" (Automix off) ─────────────────────────

export interface FadeToNextDeps {
  decks: Record<DeckId, Deck>;
  mixer: Mixer;
  fadeSeconds: number;
  beatSync: boolean;
  snapTo: SnapTo;
  onStatus(status: string): void;
  onCrossfade?: (pos: number) => void;
  /** Fired when the fade completes (not when cancelled). */
  onDone?: (info: { from: DeckId; to: DeckId }) => void;
  /** Fired when it ends either way, so the caller can clear its guard. */
  onSettled?: () => void;
}

/** Pick the outgoing deck: the one playing. */
function pickOutgoing(decks: Record<DeckId, Deck>): DeckId | null {
  const a = decks.A.isPlaying && !!decks.A.buffer;
  const b = decks.B.isPlaying && !!decks.B.buffer;
  if (a && !b) return "A";
  if (b && !a) return "B";
  if (a && b) return null; // both playing: ambiguous, don't guess
  if (decks.A.buffer && !decks.B.buffer) return "A";
  if (decks.B.buffer && !decks.A.buffer) return "B";
  return null;
}

export function fadeToNext(deps: FadeToNextDeps): TransitionHandle | null {
  const fromId = pickOutgoing(deps.decks);
  if (!fromId) {
    deps.onStatus(
      deps.decks.A.isPlaying && deps.decks.B.isPlaying
        ? "both decks are playing — move the crossfader by hand"
        : "load a track on both decks first",
    );
    return null;
  }
  const toId: DeckId = fromId === "A" ? "B" : "A";
  const from = deps.decks[fromId];
  const to = deps.decks[toId];
  if (!to.buffer) {
    deps.onStatus("load another deck first");
    return null;
  }
  return startTransition(deps.mixer, from, to, {
    durationSec: deps.fadeSeconds,
    beatSync: deps.beatSync,
    snapTo: deps.snapTo,
    onStatus: deps.onStatus,
    ...(deps.onCrossfade && { onCrossfade: deps.onCrossfade }),
    onDone: ({ cancelled }) => {
      if (!cancelled) {
        // Clear the outgoing deck (the UI shows it empty), so a stale
        // buffer can never be faded back in by the next click.
        from.unload();
        deps.onDone?.({ from: fromId, to: toId });
      }
      deps.onSettled?.();
    },
  });
}
