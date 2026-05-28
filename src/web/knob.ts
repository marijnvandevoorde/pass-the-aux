/**
 * Rotary knob — a pointer/keyboard-driven control that replaces the
 * deck's tempo / EQ / volume `<input type="range">` sliders in the
 * pro-console redesign.
 *
 * The audio graph is untouched: a knob is a pure UI widget that emits a
 * value through `onChange`, exactly like the old `oninput` handlers fed
 * `deck.setTempo / setEQ / setVolume`.
 *
 * Interaction: vertical drag (up = increase), double-click / Home to
 * reset, wheel to step, Shift for 4× finer, arrow keys when focused.
 * The element is a `<div class="knob"><span class="knob-val"></span></div>`;
 * visual rotation is the CSS custom property `--deg` (±135°) so CSS owns
 * the look. `role="slider"` + the aria-value* attributes keep it
 * accessible — the one thing a native range input gave us for free.
 */

export interface KnobOptions {
  /** Inclusive value range. */
  min: number;
  max: number;
  /** Reset target (double-click / Home) and — with `detent` — the
   *  neutral position at which the indicator dims. */
  default: number;
  /** Initial value. Defaults to `default`. */
  value?: number;
  /** Wheel / arrow-key step. Shift drags & steps 4× finer. */
  step?: number;
  /** Formats the value for the chip and `aria-valuetext`. */
  format?: (value: number) => string;
  /** Dim the indicator while the knob sits at `default`. */
  detent?: boolean;
  /** Fired on every user-driven change (never on a programmatic set). */
  onChange: (value: number) => void;
}

/** Degrees of rotation each side of vertical — 270° total sweep. */
const SWEEP = 135;
/** Vertical drag (px) to cross the whole range; Shift = the fine value. */
const DRAG_RANGE_PX = 170;
const DRAG_RANGE_PX_FINE = 560;

export class Knob {
  readonly #el: HTMLElement;
  readonly #valEl: HTMLElement | null;
  readonly #min: number;
  readonly #max: number;
  readonly #default: number;
  readonly #step: number;
  readonly #detent: boolean;
  readonly #format: (value: number) => string;
  readonly #onChange: (value: number) => void;

  #value: number;
  #dragging = false;
  #lastY = 0;

  constructor(el: HTMLElement, opts: KnobOptions) {
    this.#el = el;
    this.#valEl = el.querySelector<HTMLElement>(".knob-val");
    this.#min = opts.min;
    this.#max = opts.max;
    this.#default = opts.default;
    this.#step = opts.step ?? (opts.max - opts.min) / 26;
    this.#detent = opts.detent ?? false;
    this.#format = opts.format ?? ((v) => String(Math.round(v)));
    this.#onChange = opts.onChange;
    this.#value = this.#clamp(opts.value ?? opts.default);

    el.setAttribute("role", "slider");
    if (!el.hasAttribute("tabindex")) el.tabIndex = 0;
    el.setAttribute("aria-valuemin", String(this.#min));
    el.setAttribute("aria-valuemax", String(this.#max));

    el.addEventListener("pointerdown", this.#onPointerDown);
    el.addEventListener("pointermove", this.#onPointerMove);
    el.addEventListener("pointerup", this.#onPointerEnd);
    el.addEventListener("pointercancel", this.#onPointerEnd);
    el.addEventListener("dblclick", this.#onDblClick);
    el.addEventListener("wheel", this.#onWheel, { passive: false });
    el.addEventListener("keydown", this.#onKeyDown);

    this.#render();
  }

  /** Current value. */
  get value(): number {
    return this.#value;
  }

  /** True while the user is dragging — the render loop checks this so a
   *  programmatic mirror never fights an in-progress drag. */
  get dragging(): boolean {
    return this.#dragging;
  }

  /** Set the value programmatically (SYNC, beat-sync, session restore).
   *  Silent by default; pass `silent: false` to also fire `onChange`. */
  setValue(value: number, opts: { silent?: boolean } = {}): void {
    this.#value = this.#clamp(value);
    this.#render();
    if (opts.silent === false) this.#onChange(this.#value);
  }

  #clamp(v: number): number {
    return Math.max(this.#min, Math.min(this.#max, v));
  }

  /** Apply a user-driven change: clamp, render, notify. */
  #commit(value: number): void {
    const next = this.#clamp(value);
    if (next === this.#value) return;
    this.#value = next;
    this.#render();
    this.#onChange(next);
  }

  #render(): void {
    const frac = (this.#value - this.#min) / (this.#max - this.#min);
    this.#el.style.setProperty(
      "--deg",
      `${((frac - 0.5) * 2 * SWEEP).toFixed(1)}deg`,
    );
    this.#el.setAttribute(
      "aria-valuenow",
      String(Math.round(this.#value * 1000) / 1000),
    );
    const text = this.#format(this.#value);
    this.#el.setAttribute("aria-valuetext", text);
    if (this.#valEl) this.#valEl.textContent = text;
    if (this.#detent) {
      this.#el.classList.toggle(
        "center",
        Math.abs(this.#value - this.#default) < this.#step / 2,
      );
    }
  }

  #onPointerDown = (e: PointerEvent): void => {
    this.#dragging = true;
    this.#lastY = e.clientY;
    this.#el.classList.add("active");
    try {
      this.#el.setPointerCapture(e.pointerId);
    } catch {
      /* capture unsupported — move events still track the drag */
    }
    this.#el.focus();
    e.preventDefault();
  };

  #onPointerMove = (e: PointerEvent): void => {
    if (!this.#dragging) return;
    const dy = this.#lastY - e.clientY; // drag up ⇒ increase
    this.#lastY = e.clientY;
    const px = e.shiftKey ? DRAG_RANGE_PX_FINE : DRAG_RANGE_PX;
    this.#commit(this.#value + (dy * (this.#max - this.#min)) / px);
  };

  #onPointerEnd = (e: PointerEvent): void => {
    if (!this.#dragging) return;
    this.#dragging = false;
    this.#el.classList.remove("active");
    try {
      this.#el.releasePointerCapture(e.pointerId);
    } catch {
      /* nothing was captured */
    }
  };

  #onDblClick = (): void => {
    this.#commit(this.#default);
  };

  #onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const step = e.shiftKey ? this.#step / 4 : this.#step;
    this.#commit(this.#value + (e.deltaY < 0 ? step : -step));
  };

  #onKeyDown = (e: KeyboardEvent): void => {
    const step = e.shiftKey ? this.#step / 4 : this.#step;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      this.#commit(this.#value + step);
      e.preventDefault();
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      this.#commit(this.#value - step);
      e.preventDefault();
    } else if (e.key === "Home") {
      this.#commit(this.#default);
      e.preventDefault();
    }
  };
}
