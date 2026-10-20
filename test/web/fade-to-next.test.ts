import test from "node:test";
import assert from "node:assert/strict";
import {
  fitFadeToOutro,
  planFade,
  type IncomingState,
  type OutgoingState,
} from "../../src/web/fade-to-next-plan.ts";
import { downbeatFlags } from "../../src/web/beatsync.ts";

const close = (a: number, b: number, eps = 1e-3): void =>
  assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

function outgoing(over: Partial<OutgoingState> = {}): OutgoingState {
  return {
    id: "A",
    currentTime: 10,
    rate: 1,
    baseBPM: 120,
    cuePoint: 0,
    beats: null,
    downbeatPhase: 0,
    ...over,
  };
}

function incoming(over: Partial<IncomingState> = {}): IncomingState {
  return {
    id: "B",
    baseBPM: 122,
    cuePoint: 0,
    firstSolidCueSec: null,
    beats: null,
    downbeatPhase: 0,
    ...over,
  };
}

test("with no grid + no BPM: schedules with the min lead time", () => {
  const plan = planFade(
    outgoing({ baseBPM: null }),
    incoming({ baseBPM: null }),
    { snapTo: "downbeat", beatSync: true },
  );
  assert.ok(plan);
  // snapAtSec = currentTime + minLead (0.08); waitMs ≈ 80.
  close(plan.snapAtSec, 10.08);
  close(plan.waitMs, 80);
  assert.equal(plan.tempoSyncTarget, null);
});

test("with BPM-only outgoing: snaps to the next beat at BPM", () => {
  // 120 BPM ⇒ 0.5 s/beat; cuePoint = 0 ⇒ beats land at 0, 0.5, 1.0, …
  // currentTime = 10.10 ⇒ next beat ≥ 10.15 (minLead) is 10.5.
  const plan = planFade(
    outgoing({ currentTime: 10.1, baseBPM: 120 }),
    incoming({ baseBPM: 120 }),
    { snapTo: "beat", beatSync: false },
  );
  assert.ok(plan);
  close(plan.snapAtSec, 10.5);
  close(plan.waitMs, 400); // 0.4 s × 1.0 rate × 1000
});

test("downbeat snap with a real grid picks the next downbeat (phase 0)", () => {
  // Beats every 0.5 s. Phase 0 ⇒ downbeats at indices 0, 4, 8 → 0.5, 2.5, 4.5.
  const beats = new Float32Array([0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5]);
  const plan = planFade(
    outgoing({ currentTime: 1.4, baseBPM: 120, beats, downbeatPhase: 0 }),
    incoming(),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  close(plan.snapAtSec, 2.5); // beats[4]
});

test("downbeat snap falls back to next beat when no downbeat is past", () => {
  // Phase 0, only beats up to index 3 left. No future downbeat → fall back
  // to next beat after currentTime + minLead.
  const beats = new Float32Array([0.0, 0.5, 1.0, 1.5]);
  const plan = planFade(
    outgoing({ currentTime: 0.5, beats, downbeatPhase: 0 }),
    incoming(),
    { snapTo: "downbeat", beatSync: false, minLeadSec: 0.05 },
  );
  assert.ok(plan);
  close(plan.snapAtSec, 1.0);
});

test("rate > 1 shrinks the wallclock wait proportionally", () => {
  // 130 BPM out × tempo +8% = ~140 effective. We pass rate directly.
  const plan = planFade(
    outgoing({ currentTime: 0, rate: 2, baseBPM: 120 }),
    incoming(),
    { snapTo: "beat", beatSync: false },
  );
  assert.ok(plan);
  // First beat is at 0.5 in track time; wallclock = 0.5 / 2 × 1000 = 250.
  close(plan.waitMs, 250);
});

test("beatSync within ±8% (octave-folded) → tempoSyncTarget set", () => {
  const plan = planFade(
    outgoing({ baseBPM: 120 }),
    incoming({ baseBPM: 125 }),
    { snapTo: "downbeat", beatSync: true },
  );
  assert.ok(plan);
  assert.equal(plan.tempoSyncTarget, 120);
  assert.match(plan.status, /beat-synced/);
});

test("beatSync: target follows the outgoing deck's EFFECTIVE tempo", () => {
  // Deck A's track is tagged 120 BPM but the tempo slider has sped it
  // to 125 (rate = 125/120). The incoming deck must be synced to that
  // effective 125 — not the 120 the track is nominally tagged with.
  const plan = planFade(
    outgoing({ baseBPM: 120, rate: 125 / 120 }),
    incoming({ baseBPM: 125 }),
    { snapTo: "downbeat", beatSync: true },
  );
  assert.ok(plan);
  close(plan.tempoSyncTarget ?? 0, 125);
  assert.match(plan.status, /beat-synced/);
});

test("beatSync: effective tempo can bring an out-of-range pair in range", () => {
  // Tagged BPMs: 120 vs 132 → octaveMatched(120,132)=120, a -9.1% gap
  // that bails to a plain fade. But A is sped up to ~128 effective
  // (rate 128/120) → octaveMatched(128,132)=128, only -3% off 132, so
  // the sync now goes through against A's real tempo.
  const plan = planFade(
    outgoing({ baseBPM: 120, rate: 128 / 120 }),
    incoming({ baseBPM: 132 }),
    { snapTo: "downbeat", beatSync: true },
  );
  assert.ok(plan);
  close(plan.tempoSyncTarget ?? 0, 128);
  assert.match(plan.status, /beat-synced/);
});

test("beatSync octave-fold: 100 vs 80 → 20% gap, out of range, bails", () => {
  // octaveMatched(80, 100) = 80 (k=0); incoming would need 80 BPM, 20% down
  // → out of ±8% range. plan should bail to no sync.
  const plan = planFade(
    outgoing({ baseBPM: 80 }),
    incoming({ baseBPM: 100 }),
    { snapTo: "downbeat", beatSync: true },
  );
  assert.ok(plan);
  assert.equal(plan.tempoSyncTarget, null);
  assert.match(plan.status, /tempo gap/);
});

test("beatSync octave-fold: 64 vs 120 folds DOWN → in-range sync", () => {
  // octaveMatched(120, 64) = 60 (one octave below 120, near the 64
  // incoming) — tempo gap 60 vs 64 ≈ -6.25%, within ±8%, sync goes through.
  const plan = planFade(
    outgoing({ baseBPM: 120 }),
    incoming({ baseBPM: 64 }),
    { snapTo: "downbeat", beatSync: true },
  );
  assert.ok(plan);
  assert.equal(plan.tempoSyncTarget, 60);
  assert.match(plan.status, /beat-synced/);
});

test("beatSync disabled → no tempo sync regardless of match", () => {
  const plan = planFade(
    outgoing({ baseBPM: 120 }),
    incoming({ baseBPM: 121 }),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  assert.equal(plan.tempoSyncTarget, null);
});

test("incoming start: anchors on cuePoint (firstSolidCueSec is ignored)", () => {
  // The visual marker is a separate concern; the per-transition start
  // sits on the user's cue and only the phase-snap below moves it.
  const plan = planFade(
    outgoing(),
    incoming({ cuePoint: 1.0, firstSolidCueSec: 8.5 }),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  assert.equal(plan.incomingStartSec, 1.0);
});

test("incoming start: no cue → anchor at 1 s, firstSolidCueSec ignored", () => {
  const plan = planFade(
    outgoing(),
    incoming({ cuePoint: 0, firstSolidCueSec: 25 }),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  assert.equal(plan.incomingStartSec, 1);
});

test("phase-snap: downbeat-mode lands incoming start on the nearest bar", () => {
  // 120 BPM ⇒ 0.5 s/beat, 2 s/bar. downbeatPhase 0 ⇒ bars at beats[0,4,8] = 4, 6, 8.
  // anchor pick = 6.3 (cue=6.3, firstSolidCueSec=null) → nearest downbeat = 6.
  const beats = new Float32Array([
    4, 4.5, 5, 5.5,
    6, 6.5, 7, 7.5,
    8, 8.5, 9, 9.5,
  ]);
  const plan = planFade(
    outgoing(),
    incoming({ cuePoint: 6.3, baseBPM: 120, beats, downbeatPhase: 0 }),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  close(plan.incomingStartSec, 6);
});

test("phase-snap: beat-mode lands incoming start on the nearest beat", () => {
  // Same grid; beat-mode pulls 6.3 → 6.5 (nearest beat).
  const beats = new Float32Array([
    4, 4.5, 5, 5.5,
    6, 6.5, 7, 7.5,
    8, 8.5, 9, 9.5,
  ]);
  const plan = planFade(
    outgoing(),
    incoming({ cuePoint: 6.3, baseBPM: 120, beats, downbeatPhase: 0 }),
    { snapTo: "beat", beatSync: false },
  );
  assert.ok(plan);
  close(plan.incomingStartSec, 6.5);
});

test("phase-snap: no beat grid → start stays on the anchor pick", () => {
  // Sanity: with beats=null we keep the prior behavior (cuePoint = 4).
  const plan = planFade(
    outgoing(),
    incoming({ cuePoint: 4, baseBPM: 120, beats: null }),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  assert.equal(plan.incomingStartSec, 4);
});

test("phase-snap: downbeatPhase respected when picking the nearest bar", () => {
  // Same beats, but downbeatPhase = 2 ⇒ bars at beats[2,6,10] = 5, 7, 9.
  // anchor pick = 6.3 → nearest downbeat = 7 (closer than 5).
  const beats = new Float32Array([
    4, 4.5, 5, 5.5,
    6, 6.5, 7, 7.5,
    8, 8.5, 9, 9.5,
  ]);
  const plan = planFade(
    outgoing(),
    incoming({ cuePoint: 6.3, baseBPM: 120, beats, downbeatPhase: 2 }),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  close(plan.incomingStartSec, 7);
});

test("minLead is honoured: very near current beat is skipped, not raced", () => {
  // currentTime = 0.49, beat at 0.5. With minLead = 0.05, candidate must
  // be ≥ 0.54 → next beat is 1.0.
  const beats = new Float32Array([0.5, 1.0, 1.5]);
  const plan = planFade(
    outgoing({ currentTime: 0.49, beats, baseBPM: 120 }),
    incoming(),
    { snapTo: "beat", beatSync: false, minLeadSec: 0.05 },
  );
  assert.ok(plan);
  close(plan.snapAtSec, 1.0);
});

test("beat sync without a BPM says so instead of failing silently", () => {
  const plan = planFade(outgoing(), incoming({ baseBPM: null }), {
    snapTo: "beat",
    beatSync: true,
  });
  assert.ok(plan?.status.includes("no BPM yet"));
});

test("tempo target ignores a nudge held at plan time (tempoRate, not rate)", () => {
  // Outgoing 120 BPM at +0 % tempo but a 4 % nudge held: target stays 120.
  const plan = planFade(
    outgoing({ baseBPM: 120, rate: 1.04, tempoRate: 1 }),
    incoming({ baseBPM: 122 }),
    { snapTo: "beat", beatSync: true },
  );
  assert.ok(plan);
  close(plan.tempoSyncTarget ?? 0, 120);
});

test("phase-snap: downbeat mode falls back to the nearest beat when no bar is near", () => {
  // downbeatPhase 3 ⇒ the only downbeat is beats[3] = 12, 1.7 s from
  // the 10.3 anchor (more than ½ bar = 1 s at 120 BPM).
  const beats = new Float32Array([10.5, 11, 11.5, 12, 12.5]);
  const plan = planFade(
    outgoing(),
    incoming({ cuePoint: 10.3, baseBPM: 120, beats, downbeatPhase: 3 }),
    { snapTo: "downbeat", beatSync: false },
  );
  assert.ok(plan);
  // → the nearest beat (10.5) instead of staying between beats.
  close(plan.incomingStartSec, 10.5);
});

// ── Per-bar downbeats ────────────────────────────────────────────────

/** 120 BPM grid from 0 s; bars of 4 except one 3-beat bar at beat 8. */
const ODD_BEATS = Array.from({ length: 64 }, (_, i) => i * 0.5);
const ODD_BARS = [0, 4, 8, ...Array.from({ length: 13 }, (_, k) => 11 + 4 * k)];

test("snap to the next bar follows the per-bar downbeats, not i % 4", () => {
  const plan = planFade(
    outgoing({
      currentTime: 6.1, // beat 12.2
      beats: ODD_BEATS,
      downbeats: downbeatFlags(ODD_BEATS.length, 0, ODD_BARS),
    }),
    incoming(),
    { snapTo: "downbeat", beatSync: false },
  );
  // Bars start on beats 11, 15, 19…: next is beat 15 (7.5 s); i % 4 would
  // say beat 16 (8.0 s), a beat late.
  close(plan!.snapAtSec, 7.5);
});

test("the incoming start lands on its per-bar downbeat", () => {
  const plan = planFade(
    outgoing({ baseBPM: 120 }),
    incoming({
      baseBPM: 120,
      cuePoint: 7.4, // near beat 15 (7.5 s), a downbeat after the odd bar
      beats: ODD_BEATS,
      downbeats: downbeatFlags(ODD_BEATS.length, 0, ODD_BARS),
    }),
    { snapTo: "downbeat", beatSync: false },
  );
  close(plan!.incomingStartSec, 7.5);
});

test("downbeatFlags falls back to the phase without bars", () => {
  assert.deepEqual(Array.from(downbeatFlags(9, 1)), [0, 1, 0, 0, 0, 1, 0, 0, 0]);
  assert.deepEqual(Array.from(downbeatFlags(6, 0, [0, 3, 99])), [1, 0, 0, 1, 0, 0]);
});

// ── Mix-out point ────────────────────────────────────────────────────

test("fitFadeToOutro picks whole bars near the wanted length that fit", () => {
  // 120 BPM: a bar is 2 s.
  close(fitFadeToOutro(8, 100, 200, 0.5)!, 8); // 4 bars
  close(fitFadeToOutro(13, 100, 200, 0.5)!, 16); // 8 bars is nearer than 4
  close(fitFadeToOutro(8, 100, 105, 0.5)!, 4); // only 2 bars left
  close(fitFadeToOutro(8, 100, 200, 0.5, 1.04)!, 8 / 1.04); // played 4 % faster
  assert.equal(fitFadeToOutro(8, 100, 101.5, 0.5), null); // not one bar
});

test("plans the transition at the mix-out point, fade fitted to the outro", () => {
  const plan = planFade(
    outgoing({ currentTime: 148, durationSec: 160, beats: null, baseBPM: 120 }),
    incoming({ baseBPM: 120 }),
    { snapTo: "downbeat", beatSync: true, mixOutSec: 150, fadeSec: 30 },
  );
  assert.ok(plan);
  assert.equal(plan.atMixOut, true);
  close(plan.snapAtSec, 150);
  close(plan.waitMs, 2000);
  close(plan.fadeSec, 8); // 30 s wanted, 10 s left: 4 bars
  assert.match(plan.status, /mix-out point/);
});

test("a passed or unfittable mix-out point plans as usual", () => {
  const passed = planFade(
    outgoing({ currentTime: 151, durationSec: 160 }),
    incoming(),
    { snapTo: "downbeat", beatSync: false, mixOutSec: 150, fadeSec: 8 },
  );
  assert.equal(passed!.atMixOut, false);
  assert.equal(passed!.fadeSec, 8);
  const noRoom = planFade(
    outgoing({ currentTime: 148, durationSec: 151 }),
    incoming(),
    { snapTo: "downbeat", beatSync: false, mixOutSec: 150, fadeSec: 8 },
  );
  assert.equal(noRoom!.atMixOut, false);
});
