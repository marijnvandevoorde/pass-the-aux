const WAVE_BARS = 58;

function genWave(seedStr: string): number[] {
  let seed = 0;
  for (const c of seedStr) seed = ((seed * 31 + c.charCodeAt(0)) >>> 0);
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const out: number[] = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    const t = i / WAVE_BARS;
    const env = 0.45 + 0.55 * Math.sin(t * Math.PI);
    const beat = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 9));
    out.push(Math.max(0.14, Math.min(1, env * beat * (0.6 + 0.4 * rnd()))));
  }
  return out;
}

export interface WaveformHandle {
  setProgress(ratio: number): void;
  rebuild(seedStr: string): void;
}

export function createWaveform(
  container: HTMLElement,
  opts: {
    seekable?: boolean;
    onSeek?: (ratio: number) => void;
    minH?: number;
    maxH?: number;
  } = {},
): WaveformHandle {
  const { seekable = false, onSeek, minH = 12, maxH = 26 } = opts;
  let bars: HTMLElement[] = [];

  let builtSeed: string | null = null;

  function build(peaks: number[]): void {
    container.innerHTML = "";
    const frag = document.createDocumentFragment();
    bars = peaks.map((h) => {
      const b = document.createElement("div");
      b.className = "wave-bar";
      b.style.height = `${minH + h * maxH}px`;
      frag.appendChild(b);
      return b;
    });
    container.appendChild(frag);
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

  build(genWave(""));
  builtSeed = "";

  return {
    setProgress(ratio: number): void {
      const idx = ratio * bars.length;
      bars.forEach((b, i) => {
        b.classList.toggle("played", i < idx);
        b.classList.toggle("cursor", Math.abs(i - idx) < 0.6);
      });
    },
    rebuild(seedStr: string): void {
      if (seedStr === builtSeed) return; // same track → keep existing bars
      builtSeed = seedStr;
      build(genWave(seedStr));
    },
  };
}
