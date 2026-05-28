// Party soundboard. Real one-shot files (public/samples/*.mp3) are
// preloaded into AudioBuffers and triggered polyphonically through the
// mixer sample bus → master limiter. Files/labels are operator-curated
// (drop more into assets/ → public/samples). Keys are clustered on an
// AZERTY keyboard (a z e / q s d / w x c) and shown on each pad.

export interface SamplePad {
  name: string;
  file: string;
  key: string; // single AZERTY letter
  color: string;
}

export const SAMPLES: readonly SamplePad[] = [
  {name: "Airhorn", file: "airhorn.mp3", key: "a", color: "#7c4dff"},
  {name: "Siren", file: "siren-short.mp3", key: "z", color: "#c0476b"},
  {
    name: "Inception",
    file: "boat-inception.mp3",
    key: "e",
    color: "#8a6d3b",
  },
  {
    name: "Blijvenzitten",
    file: "blijvenzitten.mp3",
    key: "q",
    color: "#c25b8a",
  },
] as const;

const cache = new Map<string, AudioBuffer>();

// one live source per pad (monophonic — re-tap restarts, no
// stacking) plus a registry of everything playing for Stop-all.
const activeByPad = new Map<string, AudioBufferSourceNode>();
const live = new Set<AudioBufferSourceNode>();

function safeStop(src: AudioBufferSourceNode): void {
  try {
    src.onended = null;
    src.stop();
  } catch {
    /* not started / already stopped — fine */
  }
}

/** Preload every soundboard file. Failures are silent (pad just no-ops). */
export async function loadSamples(ctx: AudioContext): Promise<void> {
  await Promise.all(
    SAMPLES.map(async (s) => {
      try {
        const res = await fetch(`/samples/${s.file}`);
        if (!res.ok) return;
        cache.set(s.name, await ctx.decodeAudioData(await res.arrayBuffer()));
      } catch {
        // unreadable / undecodable — leave uncached, pad stays silent
      }
    }),
  );
}

/** Fire a one-shot. Monophonic per pad: re-tapping the same
 *  pad stops its previous instance and restarts — no stacking. */
export function playSample(
  ctx: AudioContext,
  dest: AudioNode,
  name: string,
): void {
  const buf = cache.get(name);
  if (!buf) return;
  const prev = activeByPad.get(name);
  if (prev) {
    safeStop(prev);
    live.delete(prev);
    activeByPad.delete(name);
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(dest);
  src.onended = (): void => {
    live.delete(src);
    if (activeByPad.get(name) === src) activeByPad.delete(name);
  };
  activeByPad.set(name, src);
  live.add(src);
  src.start();
  src.stop(ctx.currentTime + buf.duration + 0.05);
}

/** instantly kill every playing sample without touching the
 *  main audio (decks/master keep going). */
export function stopAllSamples(): void {
  for (const src of live) safeStop(src);
  live.clear();
  activeByPad.clear();
}

/** A decoded sample buffer by pad name (e.g. for the alarm FX bed). */
export function getSampleBuffer(name: string): AudioBuffer | undefined {
  return cache.get(name);
}

/** Map an AZERTY letter to a sample name, or null. */
export function sampleForKey(key: string): string | null {
  const k = key.toLowerCase();
  return SAMPLES.find((s) => s.key === k)?.name ?? null;
}
