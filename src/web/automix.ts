import type { Deck } from "./deck.js";
import type { Mixer, FadeHandle } from "./mixer.js";
import type { DeckId, TrackInfo } from "./types.js";

export interface AutomixUI {
  status(message: string): void;
  renderQueue(queue: readonly TrackInfo[], automix: Automix): void;
  setToggle(on: boolean, active: DeckId | null): void;
  setCrossfader(position: number): void;
  setDeckName(deck: DeckId, name: string): void;
}

export interface AutomixDeps {
  decks: Record<DeckId, Deck>;
  mixer: Mixer;
  loadToDeck(track: TrackInfo, deck: DeckId): Promise<void>;
  fadeSeconds(): number;
  /** supply a compatible next track when the queue is
   *  empty (returns null if auto-fill is off or nothing fits). */
  autoFill?: () => TrackInfo | null;
  ui: AutomixUI;
}

const other = (id: DeckId): DeckId => (id === "A" ? "B" : "A");

/**
 * Queue + auto-crossfade state machine. The active deck plays while the
 * idle deck preloads the next track; a crossfade fires near the end of
 * the active track (or on demand) and the chain alternates A <-> B.
 */
export class Automix {
  readonly #d: AutomixDeps;
  readonly #queue: TrackInfo[] = [];

  on = false;
  /** tempo-match + phase-align the incoming deck before a fade. */
  beatSync = true;
  #active: DeckId | null = null;
  /** the fade loop now lives on Mixer.fadeFromTo. We only
   *  hold the handle here so tick() knows not to start another fade. */
  #fadeHandle: FadeHandle | null = null;
  #nextLoaded = false;
  #preparing = false;
  #prep: Promise<void> | null = null;
  #booting = false;
  /** While true, enqueue() never auto-arms a deck. Session restore
   *  sets this so re-enqueuing the saved queue can't yank its head
   *  onto the decks before the saved decks are rehydrated. */
  #suspended = false;

  constructor(deps: AutomixDeps) {
    this.#d = deps;
  }

  get queue(): readonly TrackInfo[] {
    return this.#queue;
  }

  enqueue(track: TrackInfo): void {
    this.#queue.push({
      ...(track.id !== undefined && { id: track.id }),
      name: track.name,
      path: track.path,
      bpm: track.bpm ?? null,
    });
    this.#render();
    // Nothing playing and no set running → auto-arm Automix and load the
    // head straight onto the first available deck, PAUSED (the DJ presses
    // play to roll the set).
    const playing =
      this.#d.decks.A.isPlaying || this.#d.decks.B.isPlaying;
    if (
      this.#active === null &&
      !playing &&
      !this.#booting &&
      !this.#suspended
    ) {
      void this.#armFromQueue();
    }
  }

  /** Pause/resume the enqueue() auto-arm (used during session
   *  restore so the saved queue & decks aren't disturbed). */
  setSuspended(v: boolean): void {
    this.#suspended = v;
  }

  /** Restore the toggle state on session reload — UI/state only, no
   *  arming and no playback (decks/queue are rehydrated separately;
   *  playback only resumes for decks that were playing). */
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
    this.#queue.splice(i, 1);
    this.#render();
  }

  /** The deck currently designated as the active (playing) deck, or null. */
  get activeDeck(): DeckId | null {
    return this.#active;
  }

  toggle(): void {
    if (this.on) this.stop();
    else void this.start();
  }

  async start(): Promise<void> {
    this.on = true;
    this.#syncToggle();
    if (this.#active !== null) {
      void this.#prepareNext();
      this.#d.ui.status(`automix on — Deck ${this.#active}`);
      return;
    }
    if (this.#queue.length > 0) {
      await this.#armFromQueue();
    } else {
      // Armable with an empty queue: the first track added will load.
      this.#d.ui.status("automix armed — add a track to load the first deck");
    }
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
      const a = this.#d.decks.A;
      const b = this.#d.decks.B;
      let deck: DeckId | null = null;
      if (!a.isPlaying && !a.track) deck = "A";
      else if (!b.isPlaying && !b.track) deck = "B";
      else if (!a.isPlaying) deck = "A";
      else if (!b.isPlaying) deck = "B";
      if (deck === null) return; // both decks busy — leave it queued

      const track = this.#queue.shift()!;
      this.#render();
      this.#d.ui.status(`loading ${track.name}…`);
      await this.#d.loadToDeck(track, deck);
      this.#active = deck;
      const xf = deck === "A" ? -1 : 1;
      this.#d.mixer.setCrossfade(xf);
      this.#d.ui.setCrossfader(xf);
      this.#syncToggle();
      this.#d.ui.status(`automix armed — Deck ${deck} ready (press play)`);
      void this.#prepareNext();
    } finally {
      this.#booting = false;
    }
  }

  stop(): void {
    this.on = false;
    this.#fadeHandle?.cancel();
    this.#fadeHandle = null;
    this.#syncToggle();
    this.#d.ui.status(
      this.#queue.length ? `${this.#queue.length} queued` : "automix off",
    );
  }

  async fadeNow(): Promise<void> {
    if (!this.on) {
      this.#d.ui.status("turn automix on first");
      return;
    }
    if (this.#fadeHandle) return;
    if (!this.#nextLoaded) {
      await this.#prepareNext(); // may auto-fill from the library
      if (!this.#nextLoaded) {
        this.#d.ui.status("nothing queued to fade into");
        return;
      }
    }
    if (this.#nextLoaded) this.#beginFade();
  }

  /**
   * Eject a deck. Off Automix: just clears it. Under Automix: ejecting
   * the active deck advances the mix now; ejecting the idle deck drops
   * its (possibly preloaded) track and pulls the *new* queue head onto
   * it so the chain never stalls — this is what lets you change your
   * mind about an already-cued next track.
   */
  eject(id: DeckId): void {
    const deck = this.#d.decks[id];
    if (this.on && this.#active === id) {
      if (this.#nextLoaded || this.#queue.length > 0) {
        void this.fadeNow(); // skip current → advance
        return;
      }
      deck.stop();
      deck.unload();
      this.#d.ui.setDeckName(id, "— no track —");
      this.#active = null;
      this.#syncToggle();
      this.#render();
      return;
    }
    deck.unload();
    this.#d.ui.setDeckName(id, "— no track —");
    if (this.on && this.#active !== null) {
      this.#nextLoaded = false;
      void this.#prepareNext(); // re-pull the new head onto this deck
    }
    this.#render();
  }

  /** Called every animation frame from the render loop. */
  tick(): void {
    if (!this.on || this.#active === null || this.#fadeHandle) return;
    if (
      !this.#nextLoaded &&
      !this.#preparing &&
      (this.#queue.length > 0 || this.#d.autoFill !== undefined)
    ) {
      void this.#prepareNext();
    }
    if (!this.#nextLoaded) return;
    const d = this.#d.decks[this.#active];
    if (!d.buffer || !d.isPlaying) return;
    const realRemaining = (d.duration - d.currentTime) / d.rate;
    if (realRemaining <= this.#d.fadeSeconds()) this.#beginFade();
  }

  #prepareNext(): Promise<void> {
    if (!this.on || this.#active === null || this.#nextLoaded) {
      return Promise.resolve();
    }
    if (this.#preparing) return this.#prep ?? Promise.resolve();

    const track =
      this.#queue.length > 0
        ? this.#queue.shift()!
        : (this.#d.autoFill?.() ?? null);
    if (!track) return Promise.resolve(); // queue empty, no auto-fill pick

    const idle = other(this.#active);
    this.#render();
    this.#preparing = true;
    this.#prep = (async () => {
      try {
        await this.#d.loadToDeck(track, idle);
        this.#nextLoaded = true;
        this.#d.ui.status(`next up on Deck ${idle}: ${track.name}`);
      } catch {
        this.#d.ui.status(`failed to load ${track.name}`);
      } finally {
        this.#preparing = false;
        this.#prep = null;
      }
    })();
    return this.#prep;
  }

  toggleBeatSync(): boolean {
    this.beatSync = !this.beatSync;
    return this.beatSync;
  }

  /** hook for when an external fade orchestrator (the
   *  "Fade to next" button) finishes a crossfade. Advances the queue
   *  state machine the same way the internal `#beginFade` onDone does,
   *  so the next track preloads on the now-idle deck. */
  handleExternalFadeDone(toDeck: DeckId): void {
    if (!this.on) return;
    this.#active = toDeck;
    this.#nextLoaded = false;
    this.#syncToggle();
    void this.#prepareNext();
    if (this.#queue.length === 0 && !this.#preparing) {
      this.#d.ui.status(`automix — last track playing on Deck ${toDeck}`);
    }
  }

  #beginFade(): void {
    if (
      !this.on ||
      this.#fadeHandle ||
      !this.#nextLoaded ||
      this.#active === null
    ) {
      return;
    }
    const from = this.#active;
    const to = other(from);
    const deckFrom = this.#d.decks[from];
    const deckTo = this.#d.decks[to];
    if (!deckTo.buffer) return;

    // the fade primitive (tempo-match + phase-bend ride +
    // rAF loop) now lives on Mixer.fadeFromTo so the manual "Fade to
    // next" button shares it. We keep the queue/state-machine work
    // here, plumbed in via onDone.
    this.#fadeHandle = this.#d.mixer.fadeFromTo(deckFrom, deckTo, {
      durationSec: this.#d.fadeSeconds(),
      beatSync: this.beatSync,
      onStatus: (s) => this.#d.ui.status(s),
      onCrossfade: (pos) => this.#d.ui.setCrossfader(pos),
      onDone: (info) => {
        this.#fadeHandle = null;
        if (info.cancelled) return;
        deckFrom.stop();
        this.#d.ui.setDeckName(from, "— no track —");
        this.#active = to;
        this.#nextLoaded = false;
        this.#syncToggle();
        void this.#prepareNext();
        if (this.#queue.length === 0 && !this.#preparing) {
          this.#d.ui.status(`automix — last track playing on Deck ${to}`);
        }
      },
    });
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
