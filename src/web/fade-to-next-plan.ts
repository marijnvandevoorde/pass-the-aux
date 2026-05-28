// Pure (DOM-free) "Fade to next" scheduling. Decides:
//   - snap point on the outgoing deck (next beat or downbeat)
//   - real-world wait time until that point
//   - where the incoming deck should start playing
//   - whether to tempo-match (and what target BPM)
//
// Tempo / phase helpers are inlined here rather than imported from
// `beatsync` because this file is dual-target (Node runs it directly
// for unit tests, the browser bundle loads its compiled form) and the
// two toolchains disagree about how to spell a sibling import. ~15
// lines of duplication is the smaller price.

import type { DeckId } from "./types.js";

export type SnapTo = "beat" | "downbeat";

export interface OutgoingState {
  id: DeckId;
  currentTime: number;
  /** Effective playback rate (incl. tempo + bend). */
  rate: number;
  baseBPM: number | null;
  cuePoint: number;
  beats: ArrayLike<number> | null;
  downbeatPhase: 0 | 1 | 2 | 3;
}

export interface IncomingState {
  id: DeckId;
  baseBPM: number | null;
  cuePoint: number;
  firstSolidCueSec: number | null;
  /** Beat grid (track-time seconds), if analysis has produced one. */
  beats: ArrayLike<number> | null;
  /** Which (i % 4) in `beats` marks the bar's downbeat. */
  downbeatPhase: 0 | 1 | 2 | 3;
}

export interface PlanOpts {
  snapTo: SnapTo;
  beatSync: boolean;
  /** Outgoing-track lead time below which we step to the next candidate. */
  minLeadSec?: number;
}

export interface FadePlan {
  snapAtSec: number;
  waitMs: number;
  incomingStartSec: number;
  tempoSyncTarget: number | null;
  status: string;
}

/** Nearest power-of-two multiple of `refBpm` to `inBpm`. */
function octaveMatched(refBpm: number, inBpm: number): number {
  if (refBpm <= 0 || inBpm <= 0) return refBpm;
  const k = Math.round(Math.log2(inBpm / refBpm));
  return refBpm * Math.pow(2, k);
}

function within(percent: number, max: number): boolean {
  return Number.isFinite(percent) && Math.abs(percent) <= max;
}

function nextBeatAtOrAfter(
  beats: ArrayLike<number>,
  posSec: number,
): number | null {
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    if (t !== undefined && t >= posSec) return t;
  }
  return null;
}

function nextDownbeatAtOrAfter(
  beats: ArrayLike<number>,
  posSec: number,
  phase: 0 | 1 | 2 | 3,
): number | null {
  for (let i = 0; i < beats.length; i++) {
    const t = beats[i];
    if (t === undefined || t < posSec) continue;
    if (((i % 4) as 0 | 1 | 2 | 3) === phase) return t;
  }
  return null;
}

/** Build a fade plan. Returns null only when nothing usable is possible. */
export function planFade(
  outgoing: OutgoingState,
  incoming: IncomingState,
  opts: PlanOpts,
): FadePlan | null {
  const minLead = opts.minLeadSec ?? 0.05;
  const now = outgoing.currentTime;
  const minSnap = now + minLead;

  let snapAtSec: number | null = null;
  if (outgoing.beats && outgoing.beats.length > 0) {
    if (opts.snapTo === "downbeat") {
      snapAtSec = nextDownbeatAtOrAfter(
        outgoing.beats,
        minSnap,
        outgoing.downbeatPhase,
      );
    }
    if (snapAtSec === null) {
      snapAtSec = nextBeatAtOrAfter(outgoing.beats, minSnap);
    }
  }
  if (snapAtSec === null) {
    const bps = outgoing.baseBPM ? outgoing.baseBPM / 60 : null;
    if (bps && bps > 0) {
      const beatLen = 1 / bps;
      const phase = (((minSnap - outgoing.cuePoint) / beatLen) % 1 + 1) % 1;
      snapAtSec = minSnap + (1 - phase) * beatLen;
    } else {
      snapAtSec = minSnap;
    }
  }

  const rate = outgoing.rate > 0 ? outgoing.rate : 1;
  const waitMs = Math.max(0, ((snapAtSec - now) / rate) * 1000);

  // Anchor the incoming start on the user's cue (or 1 s when nothing
  // is cued — skips any leading silence/click without leaping into the
  // song body). `firstSolidCueSec` is *not* used here; it is a separate
  // concern (where in the track it's musical to start playback at all),
  // surfaced only as a clickable visual marker. Per-transition phase
  // matching is handled by the phase-snap below.
  const anchorSec = incoming.cuePoint > 0 ? incoming.cuePoint : 1;
  let incomingStartSec = anchorSec;

  // Phase-snap: shift the incoming start onto its nearest beat (or
  // downbeat, depending on snapTo) inside ±½-bar of the anchor pick.
  // The outgoing deck has already been snapped to a beat/downbeat at
  // `snapAtSec`; once the tempo-sync target is applied both decks
  // progress in lockstep, so landing the incoming on its own beat grid
  // is what aligns the two phase-wise (kick-on-kick, snare-on-snare).
  // Search window is bounded by the period so the start can never
  // drift more than half a beat (or half a bar) from the anchor pick.
  if (incoming.beats && incoming.beats.length > 0) {
    const beatLen =
      incoming.baseBPM && incoming.baseBPM > 0 ? 60 / incoming.baseBPM : 0.5;
    const isDownbeat = opts.snapTo === "downbeat";
    const halfPeriod = isDownbeat ? 2 * beatLen : beatLen / 2;
    const phase = incoming.downbeatPhase;
    let nearest: number | null = null;
    let nearestDist = Infinity;
    for (let i = 0; i < incoming.beats.length; i++) {
      const t = incoming.beats[i];
      if (t === undefined) continue;
      if (isDownbeat && (i % 4) !== phase) continue;
      const d = Math.abs(t - incomingStartSec);
      if (d <= halfPeriod && d < nearestDist) {
        nearestDist = d;
        nearest = t;
      }
      if (t > incomingStartSec + halfPeriod) break;
    }
    if (nearest !== null) incomingStartSec = nearest;
  }

  let tempoSyncTarget: number | null = null;
  let syncStatus = "";
  if (opts.beatSync && outgoing.baseBPM && incoming.baseBPM) {
    // Sync to the outgoing deck's EFFECTIVE tempo, not its track's
    // tagged BPM: a 120-BPM track the DJ has nudged to +4% is actually
    // playing at ~125, so the incoming deck must land on 125. `rate`
    // folds in the tempo slider and any live pitch bend — the same
    // reference `mixer.fadeFromTo` uses, so both stay consistent.
    const outBpm =
      outgoing.baseBPM * (outgoing.rate > 0 ? outgoing.rate : 1);
    const target = octaveMatched(outBpm, incoming.baseBPM);
    const pct = (target / incoming.baseBPM - 1) * 100;
    if (within(pct, 8)) {
      tempoSyncTarget = target;
      syncStatus = "beat-synced";
    } else {
      syncStatus = "tempo gap >8% — plain fade";
    }
  }

  const status = formatStatus(opts.snapTo, waitMs / 1000, syncStatus);
  return { snapAtSec, waitMs, incomingStartSec, tempoSyncTarget, status };
}

function formatStatus(
  snapTo: SnapTo,
  waitSec: number,
  sync: string,
): string {
  const snap = snapTo === "downbeat" ? "next bar" : "next beat";
  const wait = waitSec >= 0.05 ? ` in ${waitSec.toFixed(1)}s` : "";
  return `fading at ${snap}${wait}${sync ? ` (${sync})` : ""}`;
}
