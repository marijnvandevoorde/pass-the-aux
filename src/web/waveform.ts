// Bar waveform for the mobile DJ and the crowd screen, drawn from the
// track's real levels (GET /api/waveform). The desktop decks draw their
// own on a canvas from the decoded buffer.
//
// States: empty (no track: a flat, quiet line), loading (low bars with a
// soft pulse), levels (the track), and unavailable (flat, no pulse: we
// don't pretend).

import { resampleLevels } from "./waveform-levels.js";

const DEFAULT_BARS = 58;
/** Lowest bar, as a share of the height: silence still draws a line. */
const FLOOR = 0.1;
const FLAT = 0.14;
const LOADING = 0.22;

export interface WaveformHandle {
  setProgress(ratio: number): void;
  /** Show a track: `levels` (0–1 or 0–100, any length) when known, null
   *  while loading. Same `key` in the same state is a no-op. */
  show(key: string, levels: number[] | null): void;
  /** The track has no waveform: flat bars, no loading pulse. */
  unavailable(key: string): void;
  /** No track. */
  clear(): void;
}

export function createWaveform(
  container: HTMLElement,
  opts: {
    seekable?: boolean;
    onSeek?: (ratio: number) => void;
    bars?: number;
  } = {},
): WaveformHandle {
  const { seekable = false, onSeek, bars: count = DEFAULT_BARS } = opts;
  const bars: HTMLElement[] = [];
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) {
    const b = document.createElement("div");
    b.className = "wave-bar";
    frag.appendChild(b);
    bars.push(b);
  }
  container.innerHTML = "";
  container.appendChild(frag);

  let shown: string | null = null;

  function setHeights(levels: number[] | null, fallback: number): void {
    bars.forEach((b, i) => {
      const v = levels ? FLOOR + (1 - FLOOR) * (levels[i] ?? 0) : fallback;
      b.style.height = `${Math.round(v * 1000) / 10}%`;
    });
  }

  function setState(state: "empty" | "loading" | "levels"): void {
    container.classList.toggle("wave-loading", state === "loading");
    container.classList.toggle("wave-empty", state === "empty");
    container.setAttribute("aria-busy", String(state === "loading"));
  }

  function setProgress(ratio: number): void {
    const idx = ratio * bars.length;
    bars.forEach((b, i) => {
      b.classList.toggle("played", i < idx);
      b.classList.toggle("cursor", Math.abs(i - idx) < 0.6);
    });
  }

  if (seekable && onSeek) {
    let scrubbing = false;
    const seek = (clientX: number): void => {
      const r = container.getBoundingClientRect();
      onSeek(Math.max(0, Math.min(1, (clientX - r.left) / r.width)));
    };
    container.addEventListener("pointerdown", (e) => {
      scrubbing = true;
      container.setPointerCapture(e.pointerId);
      seek(e.clientX);
    });
    container.addEventListener("pointermove", (e) => { if (scrubbing) seek(e.clientX); });
    container.addEventListener("pointerup", () => { scrubbing = false; });
    container.addEventListener("pointercancel", () => { scrubbing = false; });
  }

  setHeights(null, FLAT);
  setState("empty");

  return {
    setProgress,
    show(key: string, levels: number[] | null): void {
      const id = `${key}|${levels ? "levels" : "loading"}`;
      if (id === shown) return;
      shown = id;
      if (levels && levels.length > 0) {
        setHeights(resampleLevels(levels, bars.length), FLAT);
        setState("levels");
      } else {
        setHeights(null, LOADING);
        setState("loading");
      }
    },
    unavailable(key: string): void {
      const id = `${key}|none`;
      if (id === shown) return;
      shown = id;
      setHeights(null, FLAT);
      setState("empty");
    },
    clear(): void {
      if (shown === null) return;
      shown = null;
      setHeights(null, FLAT);
      setState("empty");
      setProgress(0);
    },
  };
}
