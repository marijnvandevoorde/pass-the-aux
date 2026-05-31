export interface KeyRelation {
  label: "PERFECT" | "RELATIVE" | "SMOOTH" | "ENERGY" | "BOOST" | "CLASH" | "—";
  tone: "smooth" | "energy" | "clash" | "neutral";
}

function parseKey(k: string): { num: number; letter: "A" | "B" } | null {
  const m = /^(\d{1,2})([AB])$/.exec(k);
  if (!m) return null;
  return { num: parseInt(m[1]!, 10), letter: m[2]! as "A" | "B" };
}

function circDist(a: number, b: number): number {
  const d = Math.abs(a - b) % 12;
  return Math.min(d, 12 - d);
}

export function applyKeyVars(el: HTMLElement, key: string): void {
  const p = parseKey(key);
  if (!p) return;
  const hue = Math.round(((p.num - 1) / 12) * 360);
  el.style.setProperty("--k-fg", `hsl(${hue} 68% 64%)`);
  el.style.setProperty("--k-bg", `hsl(${hue} 50% 13%)`);
  el.style.setProperty("--k-bd", `hsl(${hue} 42% 30%)`);
}

export function keyHue(key: string): number | null {
  const p = parseKey(key);
  if (!p) return null;
  return Math.round(((p.num - 1) / 12) * 360);
}

export function keyRelation(ka: string, kb: string): KeyRelation {
  const a = parseKey(ka);
  const b = parseKey(kb);
  if (!a || !b) return { label: "—", tone: "neutral" };
  if (a.num === b.num && a.letter === b.letter) return { label: "PERFECT", tone: "smooth" };
  if (a.num === b.num && a.letter !== b.letter) return { label: "RELATIVE", tone: "smooth" };
  const d = circDist(a.num, b.num);
  if (a.letter === b.letter && d === 1) return { label: "SMOOTH", tone: "smooth" };
  if (a.letter === b.letter && d === 2) return { label: "ENERGY", tone: "energy" };
  const fwd = ((b.num - a.num) + 12) % 12;
  if (a.letter === b.letter && (fwd === 7 || fwd === 5)) return { label: "BOOST", tone: "energy" };
  return { label: "CLASH", tone: "clash" };
}

/** BPM delta, folding half/double-time so e.g. 64↔128 reads as 0. */
function bpmDelta(a: number, b: number): number {
  let bb = b;
  while (bb < a * 0.75) bb *= 2;
  while (bb > a * 1.5) bb /= 2;
  return Math.round(bb - a);
}

export function bpmDeltaLabel(a: number, b: number): string {
  const d = bpmDelta(a, b);
  if (d === 0) return "= beat-matched";
  return `${d > 0 ? "▲ +" : "▼ "}${d} BPM`;
}

export const TONE_VARS: Record<
  "smooth" | "energy" | "clash" | "neutral",
  { color: string; bg: string; bd: string }
> = {
  smooth:  { color: "var(--smooth)", bg: "rgba(56,224,196,0.12)",  bd: "rgba(56,224,196,0.32)" },
  energy:  { color: "var(--energy)", bg: "rgba(255,178,77,0.12)",  bd: "rgba(255,178,77,0.34)" },
  clash:   { color: "var(--clash)",  bg: "rgba(255,93,99,0.12)",   bd: "rgba(255,93,99,0.34)"  },
  neutral: { color: "var(--faint)",  bg: "var(--surface-2)",       bd: "var(--line)"            },
};
