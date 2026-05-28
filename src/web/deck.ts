import type { DeckId, TrackInfo } from "./types.js";
import { bitcrushCurve } from "./bitcrush.js";
import { beatIndexAfter as pureBeatIndexAfter, nextDownbeatAfter as pureNextDownbeatAfter } from "./beatsync.js";

export type EqBand = "low" | "mid" | "high";

/** A single playback deck: load, play/pause/cue, vinyl tempo, 3-band EQ. */
export class Deck {
  readonly ctx: AudioContext;
  readonly id: DeckId;

  buffer: AudioBuffer | null = null;
  track: TrackInfo | null = null;
  peaks: Float32Array | null = null;

  isPlaying = false;
  baseBPM: number | null = null;
  tempoPercent = 0;
  cuePoint = 0;

  /** per-track beat grid (server-computed). When present,
   *  the auto-mix scheduler aligns the fade to a real beat/downbeat
   *  rather than the BPM-only `cuePoint + n·beatLength` extrapolation. */
  beats: Float32Array | null = null;
  /** Which (i % 4) in `beats` marks the bar's downbeat. */
  downbeatPhase: 0 | 1 | 2 | 3 = 0;
  /** "Start the mix here" anchor in track seconds, or null when none. */
  firstSolidCueSec: number | null = null;

  /** Active loop region in buffer seconds (null = not set). */
  loopStartSec: number | null = null;
  loopEndSec: number | null = null;
  loopActive = false;
  /** Four hot-cue slots, each a position in seconds or null. */
  readonly hotCues: (number | null)[] = [null, null, null, null];
  /** Whether to draw the BPM-derived beatgrid (phase anchored at cue). */
  showBeatgrid = true;
  /** Keylock: hold pitch constant while tempo changes (granular shift). */
  keylock = false;
  #keylockNode: AudioWorkletNode | null = null;

  source: AudioBufferSourceNode | null = null;

  #startCtxTime = 0;
  #startOffset = 0;
  #pausedOffset = 0;
  #bend = 1;

  readonly #eqLow: BiquadFilterNode;
  readonly #eqMid: BiquadFilterNode;
  readonly #eqHigh: BiquadFilterNode;
  readonly #volume: GainNode;
  readonly output: GainNode;

  readonly #fxFilter: BiquadFilterNode;
  readonly #delay: DelayNode;
  readonly #delayFb: GainNode;
  readonly #delayWet: GainNode;
  readonly #reverb: ConvolverNode;
  readonly #reverbWet: GainNode;
  readonly #gate: GainNode;
  readonly #gateLfo: OscillatorNode;
  readonly #gateAmt: GainNode;
  readonly #flanger: DelayNode;
  readonly #flangerFb: GainNode;
  readonly #flangerLfo: OscillatorNode;
  readonly #flangerDepth: GainNode;
  readonly #flangerWet: GainNode;
  readonly #phaserWet: GainNode;
  readonly #phaserLfo: OscillatorNode;
  readonly #phaserSweep: GainNode;
  readonly #crush: WaveShaperNode;
  readonly #crushWet: GainNode;
  #crushBits = 16;
  readonly #alarmGain: GainNode;
  #alarmSrc: AudioBufferSourceNode | null = null;

  readonly #meter: AnalyserNode;
  readonly #meterBuf: Float32Array<ArrayBuffer>;

  constructor(ctx: AudioContext, id: DeckId) {
    this.ctx = ctx;
    this.id = id;

    this.#eqLow = ctx.createBiquadFilter();
    this.#eqLow.type = "lowshelf";
    this.#eqLow.frequency.value = 250;

    this.#eqMid = ctx.createBiquadFilter();
    this.#eqMid.type = "peaking";
    this.#eqMid.frequency.value = 1200;
    this.#eqMid.Q.value = 0.8;

    this.#eqHigh = ctx.createBiquadFilter();
    this.#eqHigh.type = "highshelf";
    this.#eqHigh.frequency.value = 4000;

    this.#volume = ctx.createGain();
    this.output = ctx.createGain();

    // Per-channel FX: a bipolar filter as an insert, plus delay & reverb
    // sends mixed back into the deck output (all wet gains start at 0).
    this.#fxFilter = ctx.createBiquadFilter();
    this.#fxFilter.type = "lowpass";
    this.#fxFilter.frequency.value = 20000;
    this.#fxFilter.Q.value = 1;

    this.#delay = ctx.createDelay(1);
    this.#delay.delayTime.value = 0.4;
    this.#delayFb = ctx.createGain();
    this.#delayFb.gain.value = 0.35;
    this.#delayWet = ctx.createGain();
    this.#delayWet.gain.value = 0;

    this.#reverb = ctx.createConvolver();
    this.#reverb.buffer = this.#buildReverbIR(3.2, 1.8);
    this.#reverbWet = ctx.createGain();
    this.#reverbWet.gain.value = 0;

    this.#eqLow.connect(this.#eqMid);
    this.#eqMid.connect(this.#eqHigh);
    this.#eqHigh.connect(this.#volume);

    // FX bus → rhythmic gate → output (gate chops dry + wet alike).
    this.#gate = ctx.createGain();
    this.#gate.gain.value = 1;
    this.#gateLfo = ctx.createOscillator();
    this.#gateLfo.type = "square";
    this.#gateLfo.frequency.value = 4;
    this.#gateAmt = ctx.createGain();
    this.#gateAmt.gain.value = 0; // 0 = gate off (pass-through)
    this.#gateLfo.connect(this.#gateAmt);
    this.#gateAmt.connect(this.#gate.gain);
    this.#gateLfo.start();

    this.#volume.connect(this.#fxFilter);
    this.#fxFilter.connect(this.#gate); // dry / filtered insert

    this.#fxFilter.connect(this.#delay);
    this.#delay.connect(this.#delayFb);
    this.#delayFb.connect(this.#delay); // feedback loop
    this.#delay.connect(this.#delayWet);
    this.#delayWet.connect(this.#gate);

    this.#fxFilter.connect(this.#reverb);
    this.#reverb.connect(this.#reverbWet);
    this.#reverbWet.connect(this.#gate);

    // Flanger: short modulated delay + feedback (parallel wet send).
    this.#flanger = ctx.createDelay(0.05);
    this.#flanger.delayTime.value = 0.005;
    this.#flangerFb = ctx.createGain();
    this.#flangerFb.gain.value = 0.35;
    this.#flangerLfo = ctx.createOscillator();
    this.#flangerLfo.type = "sine";
    this.#flangerLfo.frequency.value = 0.5;
    this.#flangerDepth = ctx.createGain();
    this.#flangerDepth.gain.value = 0.002;
    this.#flangerWet = ctx.createGain();
    this.#flangerWet.gain.value = 0;
    this.#flangerLfo.connect(this.#flangerDepth);
    this.#flangerDepth.connect(this.#flanger.delayTime);
    this.#fxFilter.connect(this.#flanger);
    this.#flanger.connect(this.#flangerFb);
    this.#flangerFb.connect(this.#flanger);
    this.#flanger.connect(this.#flangerWet);
    this.#flangerWet.connect(this.#gate);
    this.#flangerLfo.start();

    // Phaser: 4 cascaded all-pass filters swept by an LFO.
    this.#phaserWet = ctx.createGain();
    this.#phaserWet.gain.value = 0;
    this.#phaserLfo = ctx.createOscillator();
    this.#phaserLfo.type = "sine";
    this.#phaserLfo.frequency.value = 0.4;
    this.#phaserSweep = ctx.createGain();
    this.#phaserSweep.gain.value = 700;
    this.#phaserLfo.connect(this.#phaserSweep);
    let ap: AudioNode = this.#fxFilter;
    for (let i = 0; i < 4; i++) {
      const stage = ctx.createBiquadFilter();
      stage.type = "allpass";
      stage.frequency.value = 500 + i * 300;
      this.#phaserSweep.connect(stage.frequency);
      ap.connect(stage);
      ap = stage;
    }
    ap.connect(this.#phaserWet);
    this.#phaserWet.connect(this.#gate);
    this.#phaserLfo.start();

    // Bit-crusher: WaveShaper quantiser (parallel wet send).
    this.#crush = ctx.createWaveShaper();
    this.#crush.curve = bitcrushCurve(this.#crushBits);
    this.#crushWet = ctx.createGain();
    this.#crushWet.gain.value = 0;
    this.#fxFilter.connect(this.#crush);
    this.#crush.connect(this.#crushWet);
    this.#crushWet.connect(this.#gate);

    // Air-raid / "incoming" siren bed, faded in by the pad (not program).
    // A real looping sample is supplied via setAlarmBuffer();
    // until then the bed is silent (no synth fallback — the synth one
    // sounded fake).
    this.#alarmGain = ctx.createGain();
    this.#alarmGain.gain.value = 0;
    this.#alarmGain.connect(this.#gate);

    this.#gate.connect(this.output);

    this.#meter = ctx.createAnalyser();
    this.#meter.fftSize = 256;
    this.#meterBuf = new Float32Array(this.#meter.fftSize);
    this.output.connect(this.#meter); // passive tap
  }

  /** Current output level, 0..1 (RMS, lightly scaled for a usable meter). */
  getLevel(): number {
    this.#meter.getFloatTimeDomainData(this.#meterBuf);
    let sum = 0;
    for (let i = 0; i < this.#meterBuf.length; i++) {
      const v = this.#meterBuf[i]!;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / this.#meterBuf.length) * 1.8);
  }

  #buildReverbIR(seconds: number, decay: number): AudioBuffer {
    const rate = this.ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * seconds));
    const ir = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return ir;
  }

  get rate(): number {
    return (1 + this.tempoPercent / 100) * this.#bend;
  }

  get duration(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  get currentTime(): number {
    if (!this.buffer) return 0;
    if (!this.isPlaying) return this.#pausedOffset;
    let t =
      this.#startOffset +
      (this.ctx.currentTime - this.#startCtxTime) * this.rate;
    // Mirror the native source's loop wrap so the playhead/UI stays inside
    // the loop region (loop points are buffer-time, unaffected by rate).
    if (this.loopActive && this.loopStartSec !== null && this.loopEndSec !== null) {
      const a = this.loopStartSec;
      const b = this.loopEndSec;
      if (b > a && t > a) t = a + ((t - a) % (b - a));
    }
    return Math.min(t, this.duration);
  }

  get effectiveBPM(): number | null {
    return this.baseBPM ? this.baseBPM * this.rate : null;
  }

  /** Seconds between beats in track time (from BPM), or null without one. */
  get beatLengthSec(): number | null {
    return this.baseBPM ? 60 / this.baseBPM : null;
  }

  toggleBeatgrid(): void {
    this.showBeatgrid = !this.showBeatgrid;
  }

  async loadArrayBuffer(
    arrayBuffer: ArrayBuffer,
    track: TrackInfo | null,
  ): Promise<AudioBuffer> {
    const decoded = await this.ctx.decodeAudioData(arrayBuffer);
    this.stop();
    this.buffer = decoded;
    this.track = track;
    this.baseBPM = track && track.bpm ? track.bpm : null;
    this.#pausedOffset = 0;
    this.cuePoint = 0;
    this.loopStartSec = null;
    this.loopEndSec = null;
    this.loopActive = false;
    this.hotCues.fill(null);
    this.peaks = computePeaks(decoded, 2000);
    this.beats = null;
    this.downbeatPhase = 0;
    this.firstSolidCueSec = null;
    return decoded;
  }

  /** Apply a server-computed beat grid. Called after a
   *  successful `loadArrayBuffer`; safe to drop on a later eject. */
  applyBeatGrid(g: {
    beats: ArrayLike<number>;
    downbeatPhase: 0 | 1 | 2 | 3;
    firstSolidCueSec: number | null;
  }): void {
    this.beats = new Float32Array(g.beats);
    this.downbeatPhase = g.downbeatPhase;
    this.firstSolidCueSec = g.firstSolidCueSec;
  }

  /** Binary search: index of the first beat strictly after `posSec`,
   *  or -1 when none. Returns -1 when no grid is loaded. */
  beatIndexAfter(posSec: number): number {
    return this.beats ? pureBeatIndexAfter(this.beats, posSec) : -1;
  }

  /** Track time of the next beat strictly after `posSec`, or null. */
  nextBeatAfter(posSec: number): number | null {
    const i = this.beatIndexAfter(posSec);
    return i < 0 ? null : (this.beats?.[i] ?? null);
  }

  /** Track time of the next downbeat strictly after `posSec`, or null. */
  nextDownbeatAfter(posSec: number): number | null {
    return this.beats
      ? pureNextDownbeatAfter(this.beats, posSec, this.downbeatPhase)
      : null;
  }

  #makeSource(offset: number): void {
    if (!this.buffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.#chainInput);
    src.onended = () => {
      if (src !== this.source) return;
      this.isPlaying = false;
      this.#pausedOffset = this.duration;
      this.source = null;
    };
    src.start(0, Math.max(0, Math.min(offset, this.duration - 0.01)));
    this.source = src;
    this.#startCtxTime = this.ctx.currentTime;
    this.#startOffset = offset;
    this.#applyLoop();
  }

  play(): void {
    if (!this.buffer || this.isPlaying) return;
    this.#makeSource(this.#pausedOffset);
    this.isPlaying = true;
  }

  pause(): void {
    if (!this.isPlaying) return;
    this.#pausedOffset = this.currentTime;
    this.stop();
  }

  stop(): void {
    if (this.source) {
      const s = this.source;
      this.source = null;
      try {
        s.onended = null;
        s.stop();
      } catch {
        // already stopped
      }
    }
    this.isPlaying = false;
  }

  togglePlay(): void {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  /** Eject: stop and clear the loaded track and all per-track state.
   *  Mixer/FX/keylock settings are intentionally preserved. */
  unload(): void {
    this.stop();
    this.buffer = null;
    this.track = null;
    this.peaks = null;
    this.baseBPM = null;
    this.#pausedOffset = 0;
    this.cuePoint = 0;
    this.loopStartSec = null;
    this.loopEndSec = null;
    this.loopActive = false;
    this.hotCues.fill(null);
    this.beats = null;
    this.downbeatPhase = 0;
    this.firstSolidCueSec = null;
  }

  seek(seconds: number): void {
    const wasPlaying = this.isPlaying;
    this.stop();
    this.#pausedOffset = Math.max(0, Math.min(seconds, this.duration));
    if (wasPlaying) this.play();
  }

  setCue(): void {
    this.cuePoint = this.currentTime;
  }

  goToCue(): void {
    this.stop();
    this.#pausedOffset = this.cuePoint;
  }

  // --- Loops -------------------------------------------------------------

  /** Push current loop state onto the live source node. */
  #applyLoop(): void {
    if (!this.source) return;
    if (
      this.loopActive &&
      this.loopStartSec !== null &&
      this.loopEndSec !== null &&
      this.loopEndSec > this.loopStartSec
    ) {
      this.source.loopStart = this.loopStartSec;
      this.source.loopEnd = this.loopEndSec;
      this.source.loop = true;
    }
  }

  /** Re-anchor playback to the wrapped position before leaving a loop, so
   *  `currentTime` stays continuous once native looping is turned off. */
  #leaveLoop(): void {
    if (this.isPlaying) {
      this.#startOffset = this.currentTime;
      this.#startCtxTime = this.ctx.currentTime;
    }
    this.loopActive = false;
    if (this.source) this.source.loop = false;
  }

  setLoopIn(): void {
    this.loopStartSec = this.currentTime;
    if (this.loopEndSec !== null && this.loopEndSec <= this.loopStartSec) {
      this.loopEndSec = null;
    }
  }

  setLoopOut(): void {
    if (this.loopStartSec === null) return;
    const end = this.currentTime;
    if (end <= this.loopStartSec) return;
    this.loopEndSec = end;
    this.loopActive = true;
    this.#applyLoop();
  }

  /** Set an N-beat loop starting at the playhead (needs a known BPM). */
  setBeatLoop(beats: number): boolean {
    if (!this.baseBPM || !this.buffer) return false;
    const start = this.currentTime;
    const len = (beats * 60) / this.baseBPM;
    const end = Math.min(start + len, this.duration);
    if (end <= start) return false;
    this.loopStartSec = start;
    this.loopEndSec = end;
    this.loopActive = true;
    this.#applyLoop();
    return true;
  }

  toggleLoop(): void {
    if (this.loopStartSec === null || this.loopEndSec === null) return;
    if (this.loopActive) {
      this.#leaveLoop();
    } else {
      this.loopActive = true;
      this.#applyLoop();
    }
  }

  clearLoop(): void {
    this.#leaveLoop();
    this.loopStartSec = null;
    this.loopEndSec = null;
  }

  // --- Hot cues ----------------------------------------------------------

  setHotCue(slot: number): void {
    if (!this.buffer || slot < 0 || slot >= this.hotCues.length) return;
    this.hotCues[slot] = this.currentTime;
  }

  /** Jump to a hot cue and play from it (performance-pad behaviour). */
  triggerHotCue(slot: number): void {
    const pos = this.hotCues[slot];
    if (pos === null || pos === undefined || !this.buffer) return;
    this.seek(pos);
    if (!this.isPlaying) this.play();
  }

  clearHotCue(slot: number): void {
    if (slot < 0 || slot >= this.hotCues.length) return;
    this.hotCues[slot] = null;
  }

  setTempo(percent: number): void {
    this.#reanchor();
    this.tempoPercent = percent;
    if (this.source) this.source.playbackRate.value = this.rate;
    this.#updateKeylock();
  }

  bend(multiplier: number): void {
    this.#reanchor();
    this.#bend = multiplier;
    if (this.source) this.source.playbackRate.value = this.rate;
    this.#updateKeylock();
  }

  endBend(): void {
    this.bend(1);
  }

  #reanchor(): void {
    if (this.isPlaying) {
      this.#startOffset = this.currentTime;
      this.#startCtxTime = this.ctx.currentTime;
    }
  }

  // --- Keylock (tempo without pitch) -------------------------------------
  // Purely a routing/gain concern: the timing model (rate, currentTime,
  // loops, automix) is intentionally untouched and unaware of keylock.

  /** Where a freshly created source connects: through the keylock node
   *  when engaged, otherwise straight into the EQ (pristine vinyl). */
  get #chainInput(): AudioNode {
    return this.keylock && this.#keylockNode
      ? this.#keylockNode
      : this.#eqLow;
  }

  get keylockAvailable(): boolean {
    return this.#keylockNode !== null;
  }

  /** Wire up the keylock worklet node (its module must already be added
   *  to this AudioContext). Safe to call once; failures leave it off. */
  enableKeylock(): void {
    if (this.#keylockNode) return;
    try {
      const node = new AudioWorkletNode(this.ctx, "keylock");
      node.connect(this.#eqLow);
      this.#keylockNode = node;
    } catch {
      this.#keylockNode = null; // unsupported — button stays disabled
    }
  }

  #updateKeylock(): void {
    const shift = this.#keylockNode?.parameters.get("shift");
    if (shift) {
      shift.setTargetAtTime(
        this.keylock ? 1 / this.rate : 1,
        this.ctx.currentTime,
        0.01,
      );
    }
  }

  toggleKeylock(): void {
    if (!this.#keylockNode) return;
    this.keylock = !this.keylock;
    this.#updateKeylock();
    // Re-route the live source through the new chain input in place.
    if (this.isPlaying) this.seek(this.currentTime);
  }

  syncTo(targetBPM: number): boolean {
    if (!this.baseBPM || !targetBPM) return false;
    const percent = (targetBPM / this.baseBPM - 1) * 100;
    if (Math.abs(percent) > 50) return false;
    this.setTempo(Math.round(percent * 100) / 100);
    return true;
  }

  setVolume(v: number): void {
    this.#volume.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setEQ(band: EqBand, db: number): void {
    const node = { low: this.#eqLow, mid: this.#eqMid, high: this.#eqHigh }[
      band
    ];
    node.gain.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }

  // --- Per-channel FX ----------------------------------------------------

  /** Bipolar DJ filter: 0 = open, <0 sweeps a lowpass down, >0 a highpass up. */
  setFilter(x: number): void {
    const now = this.ctx.currentTime;
    const v = Math.max(-1, Math.min(1, x));
    if (Math.abs(v) < 0.02) {
      this.#fxFilter.type = "lowpass";
      this.#fxFilter.frequency.setTargetAtTime(20000, now, 0.02);
    } else if (v < 0) {
      this.#fxFilter.type = "lowpass";
      this.#fxFilter.frequency.setTargetAtTime(
        20000 * Math.pow(120 / 20000, -v), // 20 kHz → 120 Hz
        now,
        0.02,
      );
    } else {
      this.#fxFilter.type = "highpass";
      this.#fxFilter.frequency.setTargetAtTime(
        20 * Math.pow(8000 / 20, v), // 20 Hz → 8 kHz
        now,
        0.02,
      );
    }
  }

  setDelay(wet: number): void {
    this.#delayWet.gain.setTargetAtTime(
      Math.max(0, Math.min(1.6, wet)),
      this.ctx.currentTime,
      0.02,
    );
  }

  /** Echo feedback (repeats). Hard-capped < 1 so it can't run away. */
  setDelayFeedback(fb: number): void {
    this.#delayFb.gain.setTargetAtTime(
      Math.max(0, Math.min(0.88, fb)),
      this.ctx.currentTime,
      0.02,
    );
  }

  setReverb(wet: number): void {
    this.#reverbWet.gain.setTargetAtTime(
      Math.max(0, Math.min(1.8, wet)),
      this.ctx.currentTime,
      0.02,
    );
  }

  /** Echo delay time in seconds (clamped to the 1 s line; beat-synced
   *  by the caller). */
  setDelayTime(sec: number): void {
    const t = Math.max(0.02, Math.min(1, sec));
    this.#delay.delayTime.setTargetAtTime(t, this.ctx.currentTime, 0.02);
  }

  /** Rhythmic gate: depth 0..1 (0 = off), rate in Hz. */
  setGate(depth: number, rateHz: number): void {
    const now = this.ctx.currentTime;
    const d = Math.max(0, Math.min(1, depth));
    this.#gate.gain.setTargetAtTime(1 - d * 0.5, now, 0.01);
    this.#gateAmt.gain.setTargetAtTime(d * 0.5, now, 0.01);
    if (rateHz > 0) {
      this.#gateLfo.frequency.setTargetAtTime(
        Math.max(0.1, Math.min(40, rateHz)),
        now,
        0.02,
      );
    }
  }

  /** Hard rhythmic strobe: full 0↔1 chop with near-instant edges
   *  (punchier than the soft Gate). amount 0 = off. Shares gate nodes. */
  setStrobe(amount: number, rateHz: number): void {
    const now = this.ctx.currentTime;
    const a = Math.max(0, Math.min(1, amount));
    // base 1-a/2 ± amt a/2 with a square LFO → swings 1-a … 1, so a=1
    // gives a full 0…1 hard chop. Tiny time constant = sharp edges.
    this.#gate.gain.setTargetAtTime(1 - a * 0.5, now, 0.0015);
    this.#gateAmt.gain.setTargetAtTime(a * 0.5, now, 0.0015);
    if (rateHz > 0) {
      this.#gateLfo.frequency.setTargetAtTime(
        Math.max(0.1, Math.min(60, rateHz)),
        now,
        0.005,
      );
    }
  }

  setFlanger(wet: number, rateHz: number, depthSec: number): void {
    const now = this.ctx.currentTime;
    this.#flangerWet.gain.setTargetAtTime(
      Math.max(0, Math.min(1.4, wet)),
      now,
      0.02,
    );
    if (rateHz > 0) {
      this.#flangerLfo.frequency.setTargetAtTime(
        Math.max(0.05, Math.min(8, rateHz)),
        now,
        0.05,
      );
    }
    this.#flangerDepth.gain.setTargetAtTime(
      Math.max(0.0005, Math.min(0.008, depthSec)),
      now,
      0.05,
    );
  }

  setPhaser(wet: number, rateHz: number): void {
    const now = this.ctx.currentTime;
    this.#phaserWet.gain.setTargetAtTime(
      Math.max(0, Math.min(1.4, wet)),
      now,
      0.02,
    );
    if (rateHz > 0) {
      this.#phaserLfo.frequency.setTargetAtTime(
        Math.max(0.05, Math.min(8, rateHz)),
        now,
        0.05,
      );
    }
  }

  /** Bit-crusher wet + bit depth (lower = grittier). */
  setBitcrush(wet: number, bits: number): void {
    const b = Math.max(1, Math.min(16, Math.round(bits)));
    if (b !== this.#crushBits) {
      this.#crushBits = b;
      this.#crush.curve = bitcrushCurve(b);
    }
    this.#crushWet.gain.setTargetAtTime(
      Math.max(0, Math.min(1.2, wet)),
      this.ctx.currentTime,
      0.02,
    );
  }

  /** Supply the looping alarm sample. Call once; starts a
   *  silent looping source that setAlarm() fades in. */
  setAlarmBuffer(buf: AudioBuffer): void {
    if (this.#alarmSrc) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.#alarmGain);
    src.start();
    this.#alarmSrc = src;
  }

  /** Alarm siren bed: level 0..1 (0 = silent); pitch scales playback
   *  rate (700 Hz ≈ natural). Silent until setAlarmBuffer() is called. */
  setAlarm(level: number, pitchHz: number): void {
    const now = this.ctx.currentTime;
    this.#alarmGain.gain.setTargetAtTime(
      Math.max(0, Math.min(0.7, level)),
      now,
      0.03,
    );
    if (pitchHz > 0 && this.#alarmSrc) {
      const rate = Math.max(0.5, Math.min(2, pitchHz / 700));
      this.#alarmSrc.playbackRate.setTargetAtTime(rate, now, 0.05);
    }
  }

  /** Return every performance FX to fully dry (momentary release). */
  fxReset(): void {
    this.setFilter(0);
    this.setDelay(0);
    this.setReverb(0);
    this.setGate(0, 0);
    this.setFlanger(0, 0, 0.002);
    this.setPhaser(0, 0);
    this.setBitcrush(0, this.#crushBits);
    this.setAlarm(0, 0);
  }
}

function computePeaks(buffer: AudioBuffer, buckets: number): Float32Array {
  const ch = buffer.getChannelData(0);
  const size = Math.floor(ch.length / buckets) || 1;
  const peaks = new Float32Array(buckets);
  for (let b = 0; b < buckets; b++) {
    let max = 0;
    const start = b * size;
    for (let i = 0; i < size; i++) {
      const v = Math.abs(ch[start + i] ?? 0);
      if (v > max) max = v;
    }
    peaks[b] = max;
  }
  return peaks;
}
