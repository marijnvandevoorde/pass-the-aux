// Reusable XY pad: one Pointer Events path so mouse, touch and pen all
// work. Emits normalised { x, y } in 0..1 (y=1 at the top). Momentary by
// default — releasing recentres and fires onRelease; `latch` keeps it.

export interface XyPadHandlers {
  onMove(x: number, y: number): void;
  onRelease(): void;
}

export class XyPad {
  readonly #el: HTMLElement;
  readonly #dot: HTMLElement;
  readonly #h: XyPadHandlers;
  latch = false;
  #active = false;

  constructor(el: HTMLElement, dot: HTMLElement, handlers: XyPadHandlers) {
    this.#el = el;
    this.#dot = dot;
    this.#h = handlers;
    el.style.touchAction = "none"; // no scroll-jank on touch drag
    el.addEventListener("pointerdown", this.#down);
    el.addEventListener("pointermove", this.#move);
    el.addEventListener("pointerup", this.#end);
    el.addEventListener("pointercancel", this.#end);
    this.#place(0.5, 0.5);
  }

  #coords(e: PointerEvent): { x: number; y: number } {
    const r = this.#el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    return { x, y };
  }

  #place(x: number, y: number): void {
    this.#dot.style.left = `${x * 100}%`;
    this.#dot.style.top = `${(1 - y) * 100}%`;
  }

  #down = (e: PointerEvent): void => {
    this.#active = true;
    try {
      this.#el.setPointerCapture(e.pointerId);
    } catch {
      // capture is best-effort
    }
    this.#el.classList.add("active");
    const { x, y } = this.#coords(e);
    this.#place(x, y);
    this.#h.onMove(x, y);
  };

  #move = (e: PointerEvent): void => {
    if (!this.#active) return;
    const { x, y } = this.#coords(e);
    this.#place(x, y);
    this.#h.onMove(x, y);
  };

  #end = (e: PointerEvent): void => {
    if (!this.#active) return;
    this.#active = false;
    try {
      this.#el.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
    this.#el.classList.remove("active");
    if (!this.latch) {
      this.#place(0.5, 0.5);
      this.#h.onRelease();
    }
  };
}
