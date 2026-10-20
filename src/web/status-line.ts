// One status line for the desktop app. Two kinds of message share it:
// - feedback on what the DJ just did ("Deck A cue set"), shown for a few
//   seconds;
// - the automix state ("next up on Deck B: …"), which stays until it
//   changes and comes back when the feedback times out. Without an
//   automix state, feedback (an error, say) stays until the next message.
// DOM-free so it's unit-tested; app.ts passes the element writer.

export interface StatusLineDeps {
  show(text: string, kind: "feedback" | "automix"): void;
  /** How long feedback stays before the automix state returns. */
  holdMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export class StatusLine {
  readonly #d: Required<StatusLineDeps>;
  #automix = "";
  #timer: unknown = null;

  constructor(deps: StatusLineDeps) {
    this.#d = {
      holdMs: 6000,
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      ...deps,
    };
  }

  /** Feedback on an action; "" clears it (back to the automix state). */
  feedback(text: string): void {
    this.#cancel();
    if (text === "") {
      this.#d.show(this.#automix, "automix");
      return;
    }
    this.#d.show(text, "feedback");
    if (this.#automix === "") return;
    this.#timer = this.#d.setTimer(() => {
      this.#timer = null;
      this.#d.show(this.#automix, "automix");
    }, this.#d.holdMs);
  }

  /** The automix state. Shown now unless feedback is still up. */
  automix(text: string): void {
    this.#automix = text;
    if (this.#timer === null) this.#d.show(text, "automix");
  }

  #cancel(): void {
    if (this.#timer !== null) this.#d.clearTimer(this.#timer);
    this.#timer = null;
  }
}
