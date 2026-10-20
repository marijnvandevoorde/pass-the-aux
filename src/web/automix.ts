import type { DeckId, TrackInfo } from "./types.js";

/** What Automix needs from a deck. `Deck` satisfies it; tests use fakes. */
export interface AutomixDeck {
  readonly id: DeckId;
  readonly buffer: unknown;
  readonly track: TrackInfo | null;
  readonly isPlaying: boolean;
  /** Playback ran to the end of the track (not a DJ pause). */
  readonly ended: boolean;
  readonly duration: number;
  readonly currentTime: number;
  readonly rate: number;
  readonly cuePoint: number;
  readonly beatLengthSec: number | null;
  play(): void;
  seek(seconds: number): void;
  unload(): void;
}

export interface TransitionHandle {
  cancel(): void;
}

export interface AutomixUI {
  status(message: string): void;
  renderQueue(queue: readonly TrackInfo[], automix: Automix): void;
  setToggle(on: boolean, active: DeckId | null): void;
  setCrossfader(position: number): void;
  setDeckName(deck: DeckId, name: string): void;
}

export interface AutomixDeps {
  decks: Record<DeckId, AutomixDeck>;
  /** Load a track onto a deck. Resolves true when it's on the deck,
   *  false when the load failed or a newer load / eject superseded it. */
  loadToDeck(track: TrackInfo, deck: DeckId): Promise<boolean>;
  fadeSeconds(): number;
  /** Start the shared beat-aligned crossfade `from` → `to`. */
  transition(
    from: DeckId,
    to: DeckId,
    onDone: (info: { cancelled: boolean }) => void,
  ): TransitionHandle | null;
  /** Move the crossfader instantly (arming, rescue starts). */
  setCrossfade(position: number): void;
  /** supply a compatible next track when the queue is
   *  empty (returns null if auto-fill is off or nothing fits). */
  autoFill?: () => TrackInfo | null;
  ui: AutomixUI;
}

export interface NextUp {
  track: TrackInfo;
  deck: DeckId;
  /** Still downloading / decoding. */
  loading: boolean;
}

const MAX_LOAD_ATTEMPTS = 3;
const RETRY_MS = 3000;
/** Auto-fill picks a track this long before the fade is due. */
const AUTOFILL_LEAD_SEC = 30;

const other = (id: DeckId): DeckId => (id === "A" ? "B" : "A");
const sideOf = (id: DeckId): number => (id === "A" ? -1 : 1);

/**
 * Queue + auto-crossfade state machine. The active deck plays while the
 * idle deck holds the next track; a crossfade fires near the end of the
 * active track (or on demand) and the chain alternates A <-> B.
 *
 * The decks are the source of truth: every tick re-derives which deck is
 * active and whether the next track is ready from what the decks actually
 * hold, so a track started by hand, a page refresh or a failed load can't
 * leave the state machine believing something that isn't so.
 */
export class Automix {
  readonly #d: AutomixDeps;
  readonly #queue: TrackInfo[] = [];

  on = false;
  /** tempo-match + phase-align the incoming deck before a fade. */
  beatSync = true;
  #active: DeckId | null = null;
  #fade: TransitionHandle | null = null;
  /** The track being loaded onto the idle deck, if any. */
  #pending: TrackInfo | null = null;
  #prep: Promise<void> | null = null;
  /** Bumped when an in-flight preload must be forgotten (eject). */
  #prepGen = 0;
  #booting = false;
  /** After a failed preload: don't retry before this (ms since epoch). */
  #retryAt = 0;
  /** Failed attempts for the track at the head of the queue. */
  #headFailures = 0;
  /** While true, nothing auto-arms or auto-advances. Session restore
   *  sets this so re-enqueuing the saved queue can't yank its head onto
   *  the decks before the saved decks are rehydrated. */
  #suspended = false;

  readonly #now: () => number;

  constructor(deps: AutomixDeps, now: () => number = Date.now) {
    this.#d = deps;
    this.#now = now;
  }

  get queue(): readonly TrackInfo[] {
    return this.#queue;
  }

  /** The deck currently designated as the active (playing) deck, or null. */
  get activeDeck(): DeckId | null {
    return this.#active;
  }

  /** True while a transition is scheduled or running. */
  get fading(): boolean {
    return this.#fade !== null;
  }

  /** The track lined up on the idle deck (loaded or loading), if any. */
  get nextUp(): NextUp | null {
    if (this.#active === null) return null;
    const idle = other(this.#active);
    if (this.#pending) return { track: this.#pending, deck: idle, loading: true };
    const d = this.#d.decks[idle];
    if (this.#idleReady() && d.track) return { track: d.track, deck: idle, loading: false };
    return null;
  }

  enqueue(track: TrackInfo): void {
    this.#queue.push({
      ...(track.id !== undefined && { id: track.id }),
      name: track.name,
      path: track.path,
      bpm: track.bpm ?? null,
    });
    this.#render();
    if (this.#suspended) return;
    // Nothing playing and no set running → auto-arm Automix and load the
    // head onto the first free deck, PAUSED (the DJ presses play).
    const playing = this.#d.decks.A.isPlaying || this.#d.decks.B.isPlaying;
    if (!this.on && this.#active === null && !playing) {
      void this.#armFromQueue();
      return;
    }
    this.#reconcile();
  }

  /** Pause/resume auto-arm and auto-advance (session restore). */
  setSuspended(v: boolean): void {
    this.#suspended = v;
    if (!v) this.#reconcile();
  }

  /** Restore the toggle state on session reload — UI/state only. The
   *  next tick adopts whatever the rehydrated decks hold. */
  restoreOn(on: boolean): void {
    this.on = on;
    this.#syncToggle();
  }

  clear(): void {
    this.#queue.length = 0;
    this.#render();
  }

  /** Reorder: move the item at `from` to index `to` (drag & drop). */
  move(from: number, to: number): void {
    const n = this.#queue.length;
    if (from === to || from < 0 || from >= n || to < 0 || to >= n) return;
    const [item] = this.#queue.splice(from, 1);
    if (item) this.#queue.splice(to, 0, item);
    this.#render();
  }

  removeAt(i: number): void {
    if (i < 0 || i >= this.#queue.length) return;
    this.#queue.splice(i, 1);
    this.#render();
  }

  toggle(): void {
    if (this.on) this.stop();
    else void this.start();
  }

  async start(): Promise<void> {
    this.on = true;
    this.#syncToggle();
    this.#reconcile();
    if (this.#active !== null) {
      this.#d.ui.status(`automix on — Deck ${this.#active}`);
    } else if (this.#queue.length > 0) {
      await this.#armFromQueue();
    } else {
      // Armable with an empty queue: the first track added will load.
      this.#d.ui.status("automix armed — add a track to load the first deck");
    }
  }

  /** Turn Automix off. A fade already under way finishes (cutting it
   *  off halfway would leave both decks playing at half volume). */
  stop(): void {
    this.on = false;
    this.#syncToggle();
    this.#d.ui.status(
      this.#queue.length ? `${this.#queue.length} queued` : "automix off",
    );
  }

  /** Fade to the next track now (the "Fade to next" button, skip). */
  async fadeNow(): Promise<void> {
    if (!this.on) {
      this.#d.ui.status("turn automix on first");
      return;
    }
    if (this.#fade) return;
    this.#adopt();
    if (this.#active === null) {
      this.#d.ui.status("nothing playing to fade from");
      return;
    }
    if (!this.#idleReady()) {
      await this.#prepareNext(); // may auto-fill from the library
      if (this.#fade) return;
      if (!this.#idleReady()) {
        this.#d.ui.status("nothing queued to fade into");
        return;
      }
    }
    this.#beginFade();
  }

  /**
   * Eject a deck. Off Automix: just clears it. Under Automix: ejecting
   * the active deck advances the mix now; ejecting the idle deck drops
   * its (possibly still loading) track and pulls the *new* queue head
   * onto it — this is how you change your mind about the cued track.
   */
  eject(id: DeckId): void {
    const deck = this.#d.decks[id];
    if (this.on && this.#active === id && !this.#fade) {
      if (this.#idleReady() || this.#pending || this.#queue.length > 0) {
        void this.fadeNow(); // skip current → advance
        return;
      }
      deck.unload();
      this.#d.ui.setDeckName(id, "— no track —");
      this.#active = null;
      this.#syncToggle();
      this.#render();
      return;
    }
    if (this.#active !== null && id === other(this.#active) && this.#pending) {
      // Forget the in-flight preload; unload() also invalidates the
      // deck's load token so its audio never lands.
      this.#prepGen++;
      this.#pending = null;
      this.#prep = null;
    }
    this.#fade?.cancel(); // ejecting a deck mid-fade aborts the fade
    deck.unload();
    this.#d.ui.setDeckName(id, "— no track —");
    if (this.#active === id) this.#active = null;
    this.#render();
    this.#reconcile();
  }

  /** Called on a timer and every animation frame. */
  tick(): void {
    this.#reconcile();
  }

  toggleBeatSync(): boolean {
    this.beatSync = !this.beatSync;
    return this.beatSync;
  }

  // ── internals ─────────────────────────────────────────────────────

  /** The idle deck holds a track that's ready to fade into. */
  #idleReady(): boolean {
    if (this.#active === null || this.#pending) return false;
    const d = this.#d.decks[other(this.#active)];
    return !!d.buffer && !d.isPlaying && !d.ended;
  }

  /** Re-derive the active deck from what the decks are doing. */
  #adopt(): void {
    const { A, B } = this.#d.decks;
    const before = this.#active;
    if (this.#active === null) {
      if (A.isPlaying !== B.isPlaying) {
        this.#active = A.isPlaying ? "A" : "B";
      } else if (!A.isPlaying && !B.isPlaying) {
        const aLoaded = !!A.buffer && !A.ended;
        const bLoaded = !!B.buffer && !B.ended;
        if (aLoaded && !bLoaded) this.#active = "A";
        else if (bLoaded && !aLoaded) this.#active = "B";
        else if (aLoaded && bLoaded) this.#active = "A";
      }
      // Both playing: a hand mix in progress — don't guess.
    } else {
      const act = this.#d.decks[this.#active];
      const idle = this.#d.decks[other(this.#active)];
      // The DJ brought the other deck in by hand and this one stopped.
      if (!act.isPlaying && idle.isPlaying) this.#active = other(this.#active);
      // Active deck ejected / emptied while the other still has a track.
      else if (!act.buffer && idle.buffer && !this.#pending) {
        this.#active = other(this.#active);
      }
    }
    if (this.#active !== before) this.#syncToggle();
  }

  #reconcile(): void {
    if (!this.on || this.#fade || this.#booting || this.#suspended) return;
    this.#adopt();
    if (this.#active === null) {
      const { A, B } = this.#d.decks;
      if (this.#queue.length > 0 && !A.isPlaying && !B.isPlaying) {
        void this.#armFromQueue();
      }
      return;
    }
    const act = this.#d.decks[this.#active];
    const rate = act.rate > 0 ? act.rate : 1;
    const remaining = (act.duration - act.currentTime) / rate;
    // The transition waits for the next bar before it starts: trigger a
    // bar early so the fade is done by the time the track ends.
    const bar = act.beatLengthSec ? (4 * act.beatLengthSec) / rate : 2;
    const fadeAt = this.#d.fadeSeconds() + bar;

    if (!this.#idleReady() && !this.#pending && this.#now() >= this.#retryAt) {
      // Auto-fill is the last resort: only once the playing track is
      // nearly done (or has run out), so a track the DJ or a guest
      // queues in the meantime still goes first.
      const late =
        act.ended || !act.buffer || (act.isPlaying && remaining <= fadeAt + AUTOFILL_LEAD_SEC);
      void this.#prepareNext(late);
    }

    if (act.ended || !act.buffer) {
      // The active track ran out with nothing faded in (queue was dry,
      // load too slow): start the next one now rather than sit silent.
      if (this.#idleReady()) this.#startNow();
      return;
    }
    if (!act.isPlaying || !this.#idleReady()) return;
    if (remaining <= fadeAt) this.#beginFade();
  }

  /** Load the head of the queue onto the first available deck, PAUSED,
   *  and make it the active deck (no auto-play — the DJ presses play). */
  async #armFromQueue(): Promise<void> {
    if (this.#booting || this.#queue.length === 0) return;
    this.#booting = true;
    try {
      if (!this.on) {
        this.on = true;
        this.#syncToggle();
      }
      const { A: a, B: b } = this.#d.decks;
      let deck: DeckId | null = null;
      if (!a.isPlaying && !a.buffer) deck = "A";
      else if (!b.isPlaying && !b.buffer) deck = "B";
      else if (!a.isPlaying) deck = "A";
      else if (!b.isPlaying) deck = "B";
      if (deck === null) return; // both decks busy — leave it queued

      const track = this.#queue.shift()!;
      this.#render();
      this.#d.ui.status(`loading ${track.name}…`);
      const ok = await this.#d.loadToDeck(track, deck);
      if (!ok) {
        this.#d.ui.status(`couldn't load ${track.name} — skipped`);
        return;
      }
      this.#active = deck;
      this.#d.setCrossfade(sideOf(deck));
      this.#d.ui.setCrossfader(sideOf(deck));
      this.#syncToggle();
      this.#d.ui.status(`automix armed — Deck ${deck} ready (press play)`);
    } finally {
      this.#booting = false;
      this.#render();
    }
    this.#reconcile();
  }

  #prepareNext(allowAutoFill = true): Promise<void> {
    if (!this.on || this.#active === null || this.#idleReady()) {
      return Promise.resolve();
    }
    if (this.#prep) return this.#prep;

    const track =
      this.#queue.length > 0
        ? this.#queue.shift()!
        : allowAutoFill
          ? (this.#d.autoFill?.() ?? null)
          : null;
    if (!track) return Promise.resolve(); // queue empty, no auto-fill pick

    const idle = other(this.#active);
    const gen = ++this.#prepGen;
    this.#pending = track;
    this.#render();
    const run = (async () => {
      let ok = false;
      try {
        ok = await this.#d.loadToDeck(track, idle);
      } catch {
        ok = false;
      }
      if (gen !== this.#prepGen) return; // ejected while loading
      this.#pending = null;
      this.#prep = null;
      if (ok) {
        this.#headFailures = 0;
        this.#d.ui.status(`next up on Deck ${idle}: ${track.name}`);
      } else if (++this.#headFailures < MAX_LOAD_ATTEMPTS) {
        // Likely a network blip: put it back and retry shortly, rather
        // than drain the whole queue in a few ticks.
        this.#queue.unshift(track);
        this.#retryAt = this.#now() + RETRY_MS;
        this.#d.ui.status(`couldn't load ${track.name} — retrying…`);
      } else {
        this.#headFailures = 0;
        this.#d.ui.status(`couldn't load ${track.name} — skipped`);
      }
      this.#render();
    })();
    this.#prep = run;
    return run;
  }

  #beginFade(): void {
    if (this.#fade || this.#active === null || !this.#idleReady()) return;
    const from = this.#active;
    const to = other(from);
    const handle = this.#d.transition(from, to, ({ cancelled }) => {
      this.#fade = null;
      if (cancelled) {
        // The DJ took the crossfader (or ejected a deck): hand over.
        // The next tick adopts whichever deck ends up playing.
        this.#render();
        return;
      }
      // Clear the outgoing deck entirely, so a stale buffer can never be
      // faded back in if the next preload fails.
      this.#d.decks[from].unload();
      this.#d.ui.setDeckName(from, "— no track —");
      this.#active = to;
      this.#syncToggle();
      this.#render();
      this.#reconcile();
      if (this.#queue.length === 0 && !this.#pending && !this.#idleReady()) {
        this.#d.ui.status(`automix — last track playing on Deck ${to}`);
      }
    });
    if (!handle) return;
    this.#fade = handle;
    this.#render();
  }

  /** Rescue start: the active track ended; play the idle deck from its cue. */
  #startNow(): void {
    if (this.#active === null) return;
    const from = this.#active;
    const to = other(from);
    const d = this.#d.decks[to];
    d.seek(d.cuePoint);
    d.play();
    this.#d.setCrossfade(sideOf(to));
    this.#d.ui.setCrossfader(sideOf(to));
    this.#d.decks[from].unload();
    this.#d.ui.setDeckName(from, "— no track —");
    this.#active = to;
    this.#syncToggle();
    this.#render();
    this.#d.ui.status(`Deck ${from} ran out — started Deck ${to}`);
  }

  #syncToggle(): void {
    this.#d.ui.setToggle(this.on, this.#active);
  }

  #render(): void {
    this.#d.ui.renderQueue(this.#queue, this);
    if (!this.on) {
      this.#d.ui.status(
        this.#queue.length ? `${this.#queue.length} queued` : "queue empty",
      );
    }
  }
}
