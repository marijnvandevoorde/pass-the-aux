import type { Deck } from "./deck.js";
import type { DeckId } from "./types.js";
import {
  beatFraction,
  gridBeatFraction,
  octaveMatchedTarget,
  phaseBend,
  phaseError,
  tempoPercentFor,
  withinRange,
} from "./beatsync.js";

export interface FadeOpts {
  durationSec: number;
  beatSync: boolean;
  /** Fired every animation frame with the current crossfader position. */
  onCrossfade?: (pos: number) => void;
  /** Free-text status updates (UI surfaces them). */
  onStatus?: (status: string) => void;
  /** Fired exactly once when the fade reaches 1.0 (or is cancelled). */
  onDone?: (info: { cancelled: boolean }) => void;
}

export interface FadeHandle {
  cancel(): void;
}

/** Two-channel mixer: equal-power crossfader feeding a master gain stage. */
export class Mixer {
  readonly ctx: AudioContext;
  readonly #gainA: GainNode;
  readonly #gainB: GainNode;
  readonly #master: GainNode;
  readonly #sampleBus: GainNode;
  readonly #limiter: DynamicsCompressorNode;
  readonly #meter: AnalyserNode;
  readonly #meterBuf: Float32Array<ArrayBuffer>;
  // Headphone cue / PFL bus — never reaches master/destination.
  readonly #cue: Record<DeckId, GainNode>;
  readonly #cueBlend: GainNode; // optional master → cue mix-in
  readonly #cueVol: GainNode; // headphone volume
  readonly #masterDest: MediaStreamAudioDestinationNode; // selectable sink
  readonly #cueDest: MediaStreamAudioDestinationNode;
  readonly #recordDest: MediaStreamAudioDestinationNode; // always-on mix tap

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.#gainA = ctx.createGain();
    this.#gainB = ctx.createGain();
    this.#master = ctx.createGain();
    this.#meter = ctx.createAnalyser();
    this.#meter.fftSize = 256;
    this.#meterBuf = new Float32Array(this.#meter.fftSize);

    // Brick-wall-ish safety limiter so layered FX/samples can't clip.
    this.#limiter = ctx.createDynamicsCompressor();
    this.#limiter.threshold.value = -1;
    this.#limiter.knee.value = 0;
    this.#limiter.ratio.value = 20;
    this.#limiter.attack.value = 0.003;
    this.#limiter.release.value = 0.25;

    // Samples bypass the crossfader but still pass the master limiter.
    this.#sampleBus = ctx.createGain();
    this.#sampleBus.gain.value = 0.85;

    // Cue / PFL bus: per-deck pre-crossfader sends + an optional taste
    // of master, summed to a MediaStreamDestination for a 2nd <audio>
    // sink. Default sends 0 (PFL off); never connected to #master.
    this.#cue = { A: ctx.createGain(), B: ctx.createGain() };
    this.#cue.A.gain.value = 0;
    this.#cue.B.gain.value = 0;
    this.#cueBlend = ctx.createGain();
    this.#cueBlend.gain.value = 0;
    this.#cueVol = ctx.createGain();
    this.#cueVol.gain.value = 0.8;
    this.#cueDest = ctx.createMediaStreamDestination();
    this.#cue.A.connect(this.#cueBus());
    this.#cue.B.connect(this.#cueBus());
    this.#masterDest = ctx.createMediaStreamDestination();

    this.#gainA.connect(this.#master);
    this.#gainB.connect(this.#master);
    this.#sampleBus.connect(this.#master);
    this.#master.connect(this.#limiter);
    // Default: straight to the system sink (lowest latency). App may
    // switch to the stream sink for a selectable device.
    this.#limiter.connect(ctx.destination);
    this.#limiter.connect(this.#meter); // post-limiter tap
    // always-on post-limiter tap for the mix recorder. Passive —
    // an extra MediaStreamDestination doesn't alter the audible output —
    // so the recorder can attach/detach a MediaRecorder at any time.
    this.#recordDest = ctx.createMediaStreamDestination();
    this.#limiter.connect(this.#recordDest);
    this.#master.connect(this.#cueBlend); // optional cue⇄master blend
    this.#cueBlend.connect(this.#cueVol);
    this.#cueVol.connect(this.#cueDest);

    this.setCrossfade(0);
    this.setMaster(0.9);
  }

  #cueBus(): GainNode {
    return this.#cueVol;
  }

  connectDeck(deck: Deck): void {
    deck.output.connect(deck.id === "A" ? this.#gainA : this.#gainB);
    deck.output.connect(this.#cue[deck.id]); // pre-fader PFL tap
  }

  /** Toggle a deck's headphone pre-listen (PFL). */
  setPFL(id: DeckId, on: boolean): void {
    this.#cue[id].gain.setTargetAtTime(
      on ? 1 : 0,
      this.ctx.currentTime,
      0.02,
    );
  }

  /** Headphone volume (0..1). */
  setCueVolume(v: number): void {
    this.#cueVol.gain.setTargetAtTime(
      Math.max(0, Math.min(1, v)),
      this.ctx.currentTime,
      0.02,
    );
  }

  /** How much master to fold into the cue (0 = cue only, 1 = full). */
  setCueBlend(v: number): void {
    this.#cueBlend.gain.setTargetAtTime(
      Math.max(0, Math.min(1, v)),
      this.ctx.currentTime,
      0.02,
    );
  }

  /** The cue bus as a MediaStream, for a 2nd `<audio>`/setSinkId sink. */
  cueStream(): MediaStream {
    return this.#cueDest.stream;
  }

  /** Master as a MediaStream, for a selectable-device `<audio>` sink. */
  masterStream(): MediaStream {
    return this.#masterDest.stream;
  }

  /** Post-limiter master as a MediaStream, for the mix recorder.
   *  Independent of `routeMasterToStream` — always carries the full
   *  mix the audience hears. */
  recordingStream(): MediaStream {
    return this.#recordDest.stream;
  }

  /** send master to the stream sink (a selectable device
   *  via <audio>.setSinkId) instead of the direct system output. */
  routeMasterToStream(): void {
    try {
      this.#limiter.disconnect(this.ctx.destination);
    } catch {
      // already detached
    }
    this.#limiter.connect(this.#masterDest);
  }

  /** Revert master to the direct system output (fallback / unsupported). */
  routeMasterToDefault(): void {
    try {
      this.#limiter.disconnect(this.#masterDest);
    } catch {
      // already detached
    }
    this.#limiter.connect(this.ctx.destination);
  }

  /** Bus for sample one-shots (post-crossfader, pre-limiter). */
  sampleBus(): AudioNode {
    return this.#sampleBus;
  }

  /** position: -1 (full A) .. 0 (center) .. +1 (full B) */
  setCrossfade(position: number): void {
    const p = (Math.max(-1, Math.min(1, position)) + 1) / 2;
    const now = this.ctx.currentTime;
    this.#gainA.gain.setTargetAtTime(Math.cos((p * Math.PI) / 2), now, 0.01);
    this.#gainB.gain.setTargetAtTime(Math.sin((p * Math.PI) / 2), now, 0.01);
  }

  setMaster(v: number): void {
    this.#master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /**
   * One-shot crossfade from `from` to `to` with optional
   * tempo-match + phase-bend ride. Owns the fade loop (was on Automix);
   * Automix and the manual "Fade to next" button both call this so the
   * mechanic is identical in both modes.
   *
   * Returns null when the incoming deck has no audio loaded.
   */
  fadeFromTo(from: Deck, to: Deck, opts: FadeOpts): FadeHandle | null {
    if (!to.buffer) return null;

    // ---- Tempo-match + phase-align (lifted from Automix.#beginFade) ----
    let synced = false;
    if (opts.beatSync) {
      const ref = from.effectiveBPM;
      const inB = to.baseBPM;
      if (ref && inB) {
        const target = octaveMatchedTarget(ref, inB);
        const pct = tempoPercentFor(inB, target);
        if (withinRange(pct, 8) && to.syncTo(target)) {
          synced = true;
        } else {
          opts.onStatus?.(`beat-sync skipped (tempo out of range) — plain fade`);
        }
      }
    }

    to.play();

    if (synced) {
      const beatIn = to.beatLengthSec;
      const beatOut = from.beatLengthSec ?? beatIn;
      if (beatIn && beatOut) {
        // Prefer the actual beat grid as the phase anchor — the older
        // `cuePoint`-based math silently returned wrong fractions
        // whenever the cue wasn't on a real beat (the default cue is
        // 0, which is rarely on the grid). With grids present, the
        // planner has already seek-aligned both decks to a beat; the
        // bend just rides out any setTimeout/audio-scheduling jitter.
        const fOut = from.beats
          ? gridBeatFraction(from.beats, from.currentTime, beatOut)
          : beatFraction(from.currentTime, from.cuePoint, beatOut);
        const fIn = to.beats
          ? gridBeatFraction(to.beats, to.currentTime, beatIn)
          : beatFraction(to.currentTime, to.cuePoint, beatIn);
        const errBeats = phaseError(fIn, fOut);
        const effBeatSec = 60 / (to.effectiveBPM || 120);
        const { bend, durationMs } = phaseBend(errBeats, effBeatSec, 2);
        to.bend(bend);
        setTimeout(() => to.endBend(), durationMs);
      }
      opts.onStatus?.(`beat-synced Deck ${to.id} → fading…`);
    } else {
      opts.onStatus?.(`fading Deck ${from.id} → Deck ${to.id}…`);
    }

    // ---- Fade loop (rAF-driven; was on Automix.#tickFade) ----
    const startMs = performance.now();
    const durMs = Math.max(50, opts.durationSec * 1000);
    const fromPos = from.id === "A" ? -1 : 1;
    const toPos = to.id === "A" ? -1 : 1;
    let cancelled = false;
    let finished = false;
    const step = (): void => {
      if (cancelled || finished) return;
      const t = Math.min(1, (performance.now() - startMs) / durMs);
      const pos = fromPos + (toPos - fromPos) * t;
      this.setCrossfade(pos);
      opts.onCrossfade?.(pos);
      if (t < 1) {
        requestAnimationFrame(step);
        return;
      }
      finished = true;
      opts.onDone?.({ cancelled: false });
    };
    requestAnimationFrame(step);

    return {
      cancel: (): void => {
        if (finished) return;
        cancelled = true;
        opts.onDone?.({ cancelled: true });
      },
    };
  }

  /** Post-master output level, 0..1 (RMS, lightly scaled). */
  masterLevel(): number {
    this.#meter.getFloatTimeDomainData(this.#meterBuf);
    let sum = 0;
    for (let i = 0; i < this.#meterBuf.length; i++) {
      const v = this.#meterBuf[i]!;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.#meterBuf.length) * 1.8);
  }
}
