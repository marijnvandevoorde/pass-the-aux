import type { Deck } from "./deck.js";
import type { DeckId } from "./types.js";

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
  #xfGen = 0;
  #xfPos = 0;

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

  /** position: -1 (full A) .. 0 (center) .. +1 (full B). Cancels any
   *  scheduled crossfade (the DJ's hand wins). */
  setCrossfade(position: number): void {
    const clamped = Math.max(-1, Math.min(1, position));
    const p = (clamped + 1) / 2;
    const now = this.ctx.currentTime;
    for (const [g, target] of [
      [this.#gainA, Math.cos((p * Math.PI) / 2)],
      [this.#gainB, Math.sin((p * Math.PI) / 2)],
    ] as const) {
      const v = g.gain.value;
      g.gain.cancelScheduledValues(0);
      g.gain.setValueAtTime(v, now);
      g.gain.setTargetAtTime(target, now, 0.01);
    }
    this.#xfPos = clamped;
    this.#xfGen++;
  }

  setMaster(v: number): void {
    this.#master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  /** Bumped by every crossfader change; a scheduled fade compares it to
   *  see whether the DJ took the crossfader over mid-fade. */
  get crossfadeGeneration(): number {
    return this.#xfGen;
  }

  /** Current crossfader position (-1 .. +1) as last set or scheduled. */
  get crossfadePosition(): number {
    return this.#xfPos;
  }

  /**
   * Schedule an equal-power crossfade from `fromPos` to `toPos` on the
   * audio clock, starting at `when` (AudioContext time) and lasting
   * `durationSec`. Runs on the audio thread, so it completes even when
   * the tab is hidden and `requestAnimationFrame` is paused. Returns the
   * crossfade generation the fade owns.
   */
  scheduleCrossfade(
    fromPos: number,
    toPos: number,
    when: number,
    durationSec: number,
  ): number {
    const now = this.ctx.currentTime;
    const start = Math.max(now, when);
    const dur = Math.max(0.05, durationSec);
    const n = 64;
    const curveA = new Float32Array(n);
    const curveB = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const pos = fromPos + ((toPos - fromPos) * i) / (n - 1);
      const p = (Math.max(-1, Math.min(1, pos)) + 1) / 2;
      curveA[i] = Math.cos((p * Math.PI) / 2);
      curveB[i] = Math.sin((p * Math.PI) / 2);
    }
    for (const [g, c] of [
      [this.#gainA, curveA],
      [this.#gainB, curveB],
    ] as const) {
      const v = g.gain.value;
      g.gain.cancelScheduledValues(0);
      g.gain.setValueAtTime(v, now);
      g.gain.setValueAtTime(c[0] ?? v, start);
      g.gain.setValueCurveAtTime(c, start, dur);
    }
    this.#xfPos = toPos;
    return ++this.#xfGen;
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
