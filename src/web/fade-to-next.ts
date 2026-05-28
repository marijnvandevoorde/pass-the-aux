// one-shot "Fade to next" runtime. Works whenever both
// decks have a track loaded — not gated by Automix.
//
// The actual scheduling decisions (snap point, incoming start, tempo
// sync target) live in `fade-to-next-plan.ts` so they can be unit-
// tested without a Web Audio context.

import type { Deck } from "./deck.js";
import type { DeckId } from "./types.js";
import type { Mixer, FadeHandle } from "./mixer.js";
import { planFade, type SnapTo } from "./fade-to-next-plan.js";

export type { SnapTo };

export interface FadeToNextDeps {
  decks: Record<DeckId, Deck>;
  mixer: Mixer;
  fadeSeconds: number;
  beatSync: boolean;
  snapTo: SnapTo;
  onStatus(status: string): void;
  /** Fired every animation frame with the live crossfader position
   *  (-1 .. +1) so the slider UI can mirror the fade. */
  onCrossfade?: (pos: number) => void;
  /** Fired when the fade finishes (e.g. for Automix state advancement). */
  onDone?: (info: { from: DeckId; to: DeckId }) => void;
}

/** Pick the outgoing deck. A loaded + playing deck wins. */
function pickOutgoing(decks: Record<DeckId, Deck>): DeckId | null {
  if (decks.A.isPlaying && decks.A.buffer) return "A";
  if (decks.B.isPlaying && decks.B.buffer) return "B";
  if (decks.A.buffer && !decks.B.buffer) return "A";
  if (decks.B.buffer && !decks.A.buffer) return "B";
  return null;
}

export function fadeToNext(deps: FadeToNextDeps): FadeHandle | null {
  const fromId = pickOutgoing(deps.decks);
  if (!fromId) {
    deps.onStatus("load a track on both decks first");
    return null;
  }
  const toId: DeckId = fromId === "A" ? "B" : "A";
  const from = deps.decks[fromId];
  const to = deps.decks[toId];
  if (!to.buffer) {
    deps.onStatus("load another deck first");
    return null;
  }

  const plan = planFade(
    {
      id: fromId,
      currentTime: from.currentTime,
      rate: from.rate,
      baseBPM: from.baseBPM,
      cuePoint: from.cuePoint,
      beats: from.beats,
      downbeatPhase: from.downbeatPhase,
    },
    {
      id: toId,
      baseBPM: to.baseBPM,
      cuePoint: to.cuePoint,
      firstSolidCueSec: to.firstSolidCueSec,
      beats: to.beats,
      downbeatPhase: to.downbeatPhase,
    },
    { snapTo: deps.snapTo, beatSync: deps.beatSync },
  );
  if (!plan) {
    deps.onStatus("could not plan a fade — try again");
    return null;
  }

  deps.onStatus(plan.status);

  if (plan.tempoSyncTarget !== null) {
    to.syncTo(plan.tempoSyncTarget);
  }

  let cancelled = false;
  let activeHandle: FadeHandle | null = null;

  const timer = setTimeout(() => {
    if (cancelled) return;
    to.seek(plan.incomingStartSec);
    activeHandle = deps.mixer.fadeFromTo(from, to, {
      durationSec: deps.fadeSeconds,
      beatSync: deps.beatSync,
      onStatus: deps.onStatus,
      onCrossfade: deps.onCrossfade,
      onDone: (info) => {
        if (!info.cancelled) {
          from.stop();
          deps.onDone?.({ from: fromId, to: toId });
        }
      },
    });
  }, plan.waitMs);

  return {
    cancel: (): void => {
      cancelled = true;
      clearTimeout(timer);
      activeHandle?.cancel();
    },
  };
}
