import test from "node:test";
import assert from "node:assert/strict";
import { trackBeats } from "../../src/web/beat-grid.ts";

const SR = 22_050;

/** Decaying impulse with a short kick-like spectrum. */
function kick(buf: Float32Array, atSec: number, gain = 1, decaySec = 0.04): void {
  const start = Math.round(atSec * SR);
  const lenSamples = Math.round(decaySec * SR);
  for (let i = 0; i < lenSamples; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    // Damped 60 Hz sine — kick-band energy so the low-band detector sees it.
    const t = i / SR;
    const env = Math.exp(-t * 35);
    const s = Math.sin(2 * Math.PI * 60 * t) * env * gain;
    buf[idx] = (buf[idx] ?? 0) + s;
  }
}

/** Hi-hat-ish tick (broadband, no kick energy) so the low band stays cool. */
function hat(buf: Float32Array, atSec: number, gain = 0.5): void {
  const start = Math.round(atSec * SR);
  const lenSamples = Math.round(0.01 * SR);
  for (let i = 0; i < lenSamples; i++) {
    const idx = start + i;
    if (idx >= buf.length) break;
    // White-ish noise burst
    buf[idx] = (buf[idx] ?? 0) + (Math.random() * 2 - 1) * gain * Math.exp(-i / 30);
  }
}

function makeClickTrack(
  bpm: number,
  durationSec: number,
  opts: { downbeatGain?: number; weakOddBeats?: boolean } = {},
): Float32Array {
  const buf = new Float32Array(SR * durationSec);
  const beatLen = 60 / bpm;
  const beats = Math.floor(durationSec / beatLen);
  for (let i = 0; i < beats; i++) {
    const at = i * beatLen;
    const isDown = i % 4 === 0;
    let gain = isDown && opts.downbeatGain ? opts.downbeatGain : 0.8;
    if (opts.weakOddBeats && i % 2 === 1) gain *= 0.25;
    kick(buf, at, gain);
  }
  return buf;
}

test("120 BPM click train: every beat lands within audible flam (±25 ms)", () => {
  const dur = 30;
  const bpm = 120;
  const audio = makeClickTrack(bpm, dur, { downbeatGain: 1.2 });
  const grid = trackBeats(audio, SR, bpm);

  assert.ok(grid, "expected a grid for a clean click train");
  const beatLen = 60 / bpm;
  const expectedBeats = Math.floor(dur / beatLen);
  assert.ok(
    grid.beats.length >= expectedBeats - 4 && grid.beats.length <= expectedBeats + 4,
    `got ${grid.beats.length} beats, expected ~${expectedBeats}`,
  );

  // Match every detected beat against the nearest expected beat. The
  // detected times can drift up to a few ms behind the click's onset
  // (envelope's peak lags the click attack), but the *relative* spacing
  // is what matters for phase-aligned crossfades, so we accept ±25 ms
  // — well below the ~50 ms human flam threshold.
  let worstErrSec = 0;
  for (const b of grid.beats) {
    const nearest = Math.round(b / beatLen) * beatLen;
    worstErrSec = Math.max(worstErrSec, Math.abs(b - nearest));
  }
  assert.ok(
    worstErrSec < 0.025,
    `worst beat error ${(worstErrSec * 1000).toFixed(2)} ms exceeds 25 ms`,
  );
});

test("downbeat phase points to the loud kicks (any phase 0..3)", () => {
  // The DP can start its chain on any of the four phases depending on
  // where it locks. What matters is that the *detected* downbeats land
  // on the loud kicks: in track time, those are at multiples of 4·beat.
  const bpm = 128;
  const beatLen = 60 / bpm;
  const audio = makeClickTrack(bpm, 24, { downbeatGain: 2.5 });
  const grid = trackBeats(audio, SR, bpm);
  assert.ok(grid);
  // Look at the first detected downbeat (index `downbeatPhase` in the grid).
  // Its track time should be near an integer multiple of `4·beatLen`.
  const t = grid.beats[grid.downbeatPhase]!;
  const beatsFromZero = t / beatLen;
  const closestQuarterMul = Math.round(beatsFromZero / 4) * 4;
  assert.ok(
    Math.abs(beatsFromZero - closestQuarterMul) < 0.6,
    `first downbeat at beat ${beatsFromZero.toFixed(2)} is not near a loud-kick beat (multiple of 4)`,
  );
});

test("silence: trackBeats returns null", () => {
  const audio = new Float32Array(SR * 5);
  const grid = trackBeats(audio, SR, 120);
  assert.equal(grid, null);
});

test("zero / non-finite seed BPM returns null", () => {
  const audio = makeClickTrack(120, 10);
  assert.equal(trackBeats(audio, SR, 0), null);
  assert.equal(trackBeats(audio, SR, Number.NaN), null);
  assert.equal(trackBeats(audio, SR, -120), null);
});

test("clip shorter than 1 s returns null", () => {
  const audio = new Float32Array(Math.floor(SR * 0.5));
  assert.equal(trackBeats(audio, SR, 120), null);
});

test("first-solid cue lands past an 8-beat silent intro", () => {
  const dur = 30;
  const bpm = 120;
  const audio = new Float32Array(SR * dur);
  const beatLen = 60 / bpm;
  const introBeats = 8;
  // No clicks for the first 8 beats; full kicks afterwards.
  for (let i = introBeats; i < Math.floor(dur / beatLen); i++) {
    kick(audio, i * beatLen, 1.0);
    hat(audio, i * beatLen + beatLen / 2, 0.3);
  }
  const grid = trackBeats(audio, SR, bpm);
  assert.ok(grid);
  assert.ok(
    grid.firstSolidBeatIndex >= 0,
    "expected a first-solid index, got -1",
  );
  const firstSolidSec = grid.beats[grid.firstSolidBeatIndex]!;
  assert.ok(
    firstSolidSec >= introBeats * beatLen - 0.3,
    `first-solid at ${firstSolidSec.toFixed(2)}s is inside the silent intro`,
  );
});

test("tempo-double trap: 200 BPM with weak odd beats → halved (~100 BPM)", () => {
  // Seed at the double-time tempo so the DP locks onto every transient
  // and trackBeats must then halve. weakOddBeats makes every other beat
  // notably quieter so the heuristic fires.
  const audio = makeClickTrack(200, 25, { weakOddBeats: true });
  const grid = trackBeats(audio, SR, 200);
  assert.ok(grid);
  // Effective BPM derived from inter-beat intervals.
  const intervals: number[] = [];
  for (let i = 1; i < grid.beats.length; i++) {
    intervals.push(grid.beats[i]! - grid.beats[i - 1]!);
  }
  intervals.sort((a, b) => a - b);
  const medianInterval = intervals[Math.floor(intervals.length / 2)]!;
  const effBpm = 60 / medianInterval;
  assert.ok(
    Math.abs(effBpm - 100) < 6,
    `expected ~100 BPM after halving, got ${effBpm.toFixed(1)}`,
  );
});

test("beats are strictly ascending in seconds", () => {
  const audio = makeClickTrack(125, 20);
  const grid = trackBeats(audio, SR, 125);
  assert.ok(grid);
  for (let i = 1; i < grid.beats.length; i++) {
    assert.ok(
      grid.beats[i]! > grid.beats[i - 1]!,
      `beat ${i} is not after beat ${i - 1}`,
    );
  }
});
