import test from "node:test";
import assert from "node:assert/strict";
import {
  Automix,
  type AutomixDeck,
  type AutomixDeps,
} from "../../src/web/automix.ts";
import type { DeckId, TrackInfo } from "../../src/web/types.ts";
import { TempoGlide } from "../../src/web/tempo-glide.ts";

class FakeDeck implements AutomixDeck {
  readonly id: DeckId;
  buffer: unknown = null;
  track: TrackInfo | null = null;
  isPlaying = false;
  ended = false;
  duration = 0;
  currentTime = 0;
  rate = 1;
  cuePoint = 0;
  beatLengthSec: number | null = 0.5;
  mixOutSec: number | null = null;
  tempoPercent = 0;
  unloads = 0;
  constructor(id: DeckId) {
    this.id = id;
  }
  load(track: TrackInfo, duration = 200): void {
    this.buffer = {};
    this.track = track;
    this.duration = duration;
    this.currentTime = 0;
    this.ended = false;
    this.isPlaying = false;
  }
  play(): void {
    if (this.buffer) this.isPlaying = true;
  }
  seek(s: number): void {
    this.currentTime = s;
  }
  setTempo(p: number): void {
    this.tempoPercent = p;
  }
  unload(): void {
    this.unloads++;
    this.mixOutSec = null;
    this.buffer = null;
    this.track = null;
    this.isPlaying = false;
    this.ended = false;
    this.duration = 0;
    this.currentTime = 0;
  }
}

interface Deferred {
  track: TrackInfo;
  deck: DeckId;
  resolve(ok: boolean): void;
}

function setup(
  opts: {
    autoResolve?: boolean;
    autoFill?: () => TrackInfo | null;
    glide?: TempoGlide;
  } = {},
) {
  const decks = { A: new FakeDeck("A"), B: new FakeDeck("B") };
  const loads: Deferred[] = [];
  const transitions: Array<{
    from: DeckId;
    to: DeckId;
    done(cancelled?: boolean): void;
    cancelled: boolean;
    mixOutSec: number | null;
  }> = [];
  const statuses: string[] = [];
  let clock = 0;
  const deps: AutomixDeps = {
    decks,
    loadToDeck: (track, deck) =>
      new Promise<boolean>((resolve) => {
        const d: Deferred = {
          track,
          deck,
          resolve: (ok) => {
            if (ok) decks[deck].load(track);
            resolve(ok);
          },
        };
        loads.push(d);
        if (opts.autoResolve) d.resolve(true);
      }),
    fadeSeconds: () => 8,
    transition: (from, to, onDone, topts) => {
      const t = {
        from,
        to,
        mixOutSec: topts?.mixOutSec ?? null,
        cancelled: false,
        done: (cancelled = false) => {
          if (!cancelled) {
            decks[to].isPlaying = true;
            decks[from].isPlaying = false;
          }
          onDone({ cancelled });
        },
      };
      transitions.push(t);
      return { cancel: () => { t.cancelled = true; onDone({ cancelled: true }); } };
    },
    setCrossfade: () => {},
    ...(opts.autoFill && { autoFill: opts.autoFill }),
    ...(opts.glide && { glide: opts.glide }),
    ui: {
      status: (m) => statuses.push(m),
      renderQueue: () => {},
      setToggle: () => {},
      setCrossfader: () => {},
      setDeckName: () => {},
    },
  };
  const mix = new Automix(deps, () => clock);
  return {
    mix,
    decks,
    loads,
    transitions,
    statuses,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const T = (name: string): TrackInfo => ({ name, path: `u/${name}.mp3`, bpm: 120 });
const flush = () => new Promise<void>((r) => setImmediate(r));

test("adopts a deck the DJ started by hand and preloads the queue onto the other", async () => {
  const { mix, decks, loads } = setup();
  decks.A.load(T("manual"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("next"));
  assert.equal(mix.activeDeck, "A");
  assert.equal(loads.length, 1);
  assert.equal(loads[0]!.deck, "B");
  assert.equal(loads[0]!.track.name, "next");
});

test("after a refresh (on restored, decks rehydrated) the set keeps going", async () => {
  const { mix, decks, transitions } = setup();
  mix.setSuspended(true);
  mix.restoreOn(true);
  decks.A.load(T("playing"));
  decks.A.play();
  decks.B.load(T("lined-up"));
  mix.setSuspended(false);
  assert.equal(mix.activeDeck, "A");
  assert.equal(mix.nextUp?.track.name, "lined-up");
  decks.A.currentTime = decks.A.duration - 9; // within fade + 1 bar
  mix.tick();
  assert.equal(transitions.length, 1);
  assert.deepEqual([transitions[0]!.from, transitions[0]!.to], ["A", "B"]);
});

test("a failed preload is retried after a back-off, then skipped", async () => {
  const { mix, decks, loads, advance, statuses } = setup();
  decks.A.load(T("playing"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("broken"));
  mix.enqueue(T("good"));
  loads[0]!.resolve(false);
  await flush();
  assert.equal(mix.nextUp, null);
  assert.equal(mix.queue[0]!.name, "broken", "put back at the head");
  mix.tick();
  assert.equal(loads.length, 1, "no retry before the back-off");
  advance(3000);
  mix.tick();
  assert.equal(loads.length, 2);
  loads[1]!.resolve(false);
  await flush();
  advance(3000);
  mix.tick();
  loads[2]!.resolve(false);
  await flush();
  assert.ok(statuses.some((s) => s.includes("broken — skipped")));
  advance(3000);
  mix.tick();
  assert.equal(loads[3]!.track.name, "good");
});

test("a completed fade unloads the outgoing deck so it can't be replayed", async () => {
  const { mix, decks, transitions } = setup({ autoResolve: true });
  decks.A.load(T("one"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("two"));
  await flush();
  await mix.fadeNow();
  transitions[0]!.done();
  assert.equal(decks.A.buffer, null);
  assert.equal(mix.activeDeck, "B");
});

test("ejecting the lined-up track while it loads drops it for good", async () => {
  const { mix, decks, loads } = setup();
  decks.A.load(T("playing"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("changed-my-mind"));
  mix.enqueue(T("this-one"));
  assert.equal(loads[0]!.track.name, "changed-my-mind");
  mix.eject("B");
  // The new head is pulled straight away…
  assert.equal(loads[1]!.track.name, "this-one");
  // …and the stale load finishing late changes nothing.
  loads[0]!.resolve(false); // (loadToDeck reports superseded loads as false)
  await flush();
  loads[1]!.resolve(true);
  await flush();
  assert.equal(mix.nextUp?.track.name, "this-one");
});

test("Fade to next during an automatic fade doesn't start a second one", async () => {
  const { mix, decks, transitions } = setup({ autoResolve: true });
  decks.A.load(T("one"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("two"));
  await flush();
  await mix.fadeNow();
  decks.A.currentTime = decks.A.duration - 3;
  mix.tick();
  await mix.fadeNow();
  assert.equal(transitions.length, 1);
});

test("when the track ran out with nothing lined up, a late-queued track starts by itself", async () => {
  const { mix, decks, loads } = setup();
  decks.A.load(T("last"));
  decks.A.play();
  await mix.start();
  mix.tick();
  // Track ends: queue was dry.
  decks.A.isPlaying = false;
  decks.A.ended = true;
  mix.tick();
  mix.enqueue(T("crowd-request"));
  loads[0]!.resolve(true);
  await flush();
  mix.tick();
  assert.equal(decks.B.isPlaying, true);
  assert.equal(mix.activeDeck, "B");
  assert.equal(decks.A.buffer, null);
});

test("a fade the DJ took over (cancelled) doesn't advance the queue", async () => {
  const { mix, decks, transitions } = setup({ autoResolve: true });
  decks.A.load(T("one"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("two"));
  await flush();
  await mix.fadeNow();
  transitions[0]!.done(true);
  assert.equal(mix.activeDeck, "A");
  assert.equal(decks.A.unloads, 0);
  assert.equal(mix.fading, false);
});

test("switching Automix off mid-fade lets the fade finish and clean up", async () => {
  const { mix, decks, transitions } = setup({ autoResolve: true });
  decks.A.load(T("one"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("two"));
  await flush();
  await mix.fadeNow();
  mix.stop();
  assert.equal(transitions[0]!.cancelled, false);
  transitions[0]!.done();
  assert.equal(decks.A.buffer, null);
  assert.equal(mix.activeDeck, "B");
});

test("enqueue with nothing loaded arms Automix and cues the first deck", async () => {
  const { mix, loads } = setup({ autoResolve: true });
  mix.enqueue(T("first"));
  await flush();
  assert.equal(mix.on, true);
  assert.equal(mix.activeDeck, "A");
  assert.equal(loads[0]!.deck, "A");
});

test("the automatic fade fires a bar before fade-length from the end", async () => {
  const { mix, decks, transitions } = setup({ autoResolve: true });
  decks.A.load(T("one"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("two"));
  await flush();
  decks.A.currentTime = decks.A.duration - 10.1; // 8 s fade + 2 s bar
  mix.tick();
  assert.equal(transitions.length, 0);
  decks.A.currentTime = decks.A.duration - 9.9;
  mix.tick();
  assert.equal(transitions.length, 1);
});

test("auto-fill waits until the playing track is nearly done", async () => {
  let picks = 0;
  const { mix, decks, loads } = setup({
    autoFill: () => T(`fill${++picks}`),
  });
  decks.A.load(T("playing"));
  decks.A.play();
  await mix.start();
  mix.tick();
  assert.equal(picks, 0, "plenty of time left: no auto-fill yet");
  assert.equal(loads.length, 0);
  // A guest's request queued in the meantime still goes first.
  mix.enqueue(T("guest-request"));
  assert.equal(loads[0]!.track.name, "guest-request");
  loads[0]!.resolve(true);
  await flush();
  // Next round: queue dry, track nearly over → auto-fill kicks in.
  decks.B.unload();
  decks.A.currentTime = decks.A.duration - 35;
  mix.tick();
  assert.equal(picks, 1);
});

// ── Mix-out point ────────────────────────────────────────────────────

async function playingWithNext(mixOutSec: number | null) {
  const h = setup({ autoResolve: true });
  h.decks.A.load(T("one")); // 200 s, beat 0.5 s → bar 2 s
  h.decks.A.mixOutSec = mixOutSec;
  h.decks.A.play();
  await h.mix.start();
  h.mix.enqueue(T("two"));
  await flush();
  return h;
}

test("with a mix-out point the transition starts there, a bar ahead, not near the end", async () => {
  const { mix, decks, transitions } = await playingWithNext(150);
  decks.A.currentTime = 147.9; // 2.1 s to go: more than a bar
  mix.tick();
  assert.equal(transitions.length, 0);
  assert.ok(Math.abs(mix.secondsToMix! - 0.1) < 1e-6);
  decks.A.currentTime = 148.1;
  mix.tick();
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!.mixOutSec, 150);
});

test("a mix-out point that already passed falls back to the end of the track", async () => {
  const { mix, decks, transitions } = await playingWithNext(150);
  decks.A.currentTime = 160; // the DJ jumped past it
  mix.tick();
  assert.equal(transitions.length, 0);
  decks.A.currentTime = decks.A.duration - 9.9;
  mix.tick();
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!.mixOutSec, null);
});

test("a mix-out point with less than a bar left is ignored", async () => {
  const { mix, decks, transitions } = await playingWithNext(199);
  decks.A.currentTime = 185;
  mix.tick();
  assert.equal(transitions.length, 0, "not 14 s early on account of the point");
  decks.A.currentTime = decks.A.duration - 9.9;
  mix.tick();
  assert.equal(transitions[0]!.mixOutSec, null);
});

test("Fade to next (a manual choice) goes now, not at the mix-out point", async () => {
  const { mix, decks, transitions } = await playingWithNext(150);
  decks.A.currentTime = 60;
  await mix.fadeNow();
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]!.mixOutSec, null);
});

test("auto-fill counts down to the mix-out point, not the end", async () => {
  let picks = 0;
  const h = setup({ autoFill: () => T(`fill${++picks}`) });
  h.decks.A.load(T("playing"));
  h.decks.A.mixOutSec = 100;
  h.decks.A.play();
  await h.mix.start();
  h.decks.A.currentTime = 60; // 40 s to the point (38 s to the trigger)
  h.mix.tick();
  assert.equal(picks, 0);
  h.decks.A.currentTime = 75;
  h.mix.tick();
  assert.equal(picks, 1);
});

// ── Tempo drift ──────────────────────────────────────────────────────

test("after a fade the new track glides back to its own tempo", async () => {
  const glide = new TempoGlide();
  const { mix, decks, transitions, advance } = setup({ autoResolve: true, glide });
  decks.A.load(T("one"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("two"));
  await flush();
  await mix.fadeNow();
  decks.B.tempoPercent = 4; // synced to Deck A during the fade
  transitions[0]!.done();
  assert.equal(glide.state, "gliding");
  advance(1000);
  mix.tick();
  assert.ok(decks.B.tempoPercent < 4 && decks.B.tempoPercent > 3.9, `${decks.B.tempoPercent}`);
  advance(60_000); // 4 % → 16 bars of 2 s = 32 s
  mix.tick();
  assert.equal(decks.B.tempoPercent, 0);
  assert.equal(glide.state, "idle");
});

test("the DJ touching the tempo, or the next transition, stops the glide", async () => {
  const glide = new TempoGlide();
  const { mix, decks, transitions, advance } = setup({ autoResolve: true, glide });
  decks.A.load(T("one"));
  decks.A.play();
  await mix.start();
  mix.enqueue(T("two"));
  await flush();
  await mix.fadeNow();
  decks.B.tempoPercent = -6;
  transitions[0]!.done();
  advance(5000);
  mix.tick();
  decks.B.tempoPercent = 1.5; // by hand
  advance(5000);
  mix.tick();
  assert.equal(decks.B.tempoPercent, 1.5);
  assert.equal(glide.state, "idle");

  // A new glide, interrupted by the next transition: tempo holds.
  glide.start(decks.B, 10);
  mix.enqueue(T("three"));
  await flush();
  await mix.fadeNow();
  assert.equal(glide.state, "idle");
  assert.equal(decks.B.tempoPercent, 1.5);
});
