import test from "node:test";
import assert from "node:assert/strict";
import {
  beatGridToRow,
  rowToBeatGrid,
} from "../../src/infrastructure/mysql-beat-grid-repository.ts";
import {
  BEAT_GRID_ANALYZER_VERSION,
  type BeatGrid,
} from "../../src/domain/beat-grid.ts";

function sampleGrid(): BeatGrid {
  return {
    trackId: "Artist/Song.mp3",
    durationSec: 180.5,
    beats: new Float32Array([0.232, 0.732, 1.232, 1.732, 2.232]),
    downbeatPhase: 2,
    firstSolidBeatIndex: 4,
    confidence: 0.91,
    analyzedAt: 1_700_000_000_000,
    analyzerVersion: BEAT_GRID_ANALYZER_VERSION,
  };
}

test("beatGridToRow → rowToBeatGrid round-trips via a Float32 LE blob", () => {
  const grid = sampleGrid();
  const params = beatGridToRow("u1", grid);
  // Simulate what the driver would hand us back:
  const back = rowToBeatGrid({
    track_id: grid.trackId,
    duration_sec: grid.durationSec,
    beat_count: BigInt(grid.beats.length),
    downbeat_phase: grid.downbeatPhase,
    first_solid_index: BigInt(grid.firstSolidBeatIndex),
    confidence: grid.confidence,
    analyzer_version: grid.analyzerVersion,
    analyzed_at: BigInt(grid.analyzedAt),
    beats_blob: params.beats,
  });
  assert.ok(back);
  assert.equal(back.trackId, grid.trackId);
  assert.equal(back.durationSec, grid.durationSec);
  assert.equal(back.downbeatPhase, grid.downbeatPhase);
  assert.equal(back.firstSolidBeatIndex, grid.firstSolidBeatIndex);
  assert.equal(back.confidence, grid.confidence);
  assert.equal(back.analyzedAt, grid.analyzedAt);
  assert.equal(back.analyzerVersion, grid.analyzerVersion);
  assert.equal(back.beats.length, grid.beats.length);
  for (let i = 0; i < grid.beats.length; i++) {
    assert.ok(Math.abs(back.beats[i]! - grid.beats[i]!) < 1e-5);
  }
});

test("rowToBeatGrid rejects an invalid downbeat_phase", () => {
  const buf = Buffer.allocUnsafe(8);
  buf.writeFloatLE(0.1, 0);
  buf.writeFloatLE(0.6, 4);
  assert.equal(
    rowToBeatGrid({
      track_id: "x.mp3",
      duration_sec: 10,
      beat_count: 2,
      downbeat_phase: 9, // invalid
      first_solid_index: 0,
      confidence: 0.5,
      analyzer_version: 1,
      analyzed_at: 1,
      beats_blob: buf,
    }),
    null,
  );
});

test("rowToBeatGrid rejects when blob size doesn't match beat_count", () => {
  const buf = Buffer.allocUnsafe(8); // 2 floats
  buf.writeFloatLE(0.1, 0);
  buf.writeFloatLE(0.6, 4);
  assert.equal(
    rowToBeatGrid({
      track_id: "x.mp3",
      duration_sec: 10,
      beat_count: 5, // mismatch — blob has 2 floats not 5
      downbeat_phase: 0,
      first_solid_index: 0,
      confidence: 0.5,
      analyzer_version: 1,
      analyzed_at: 1,
      beats_blob: buf,
    }),
    null,
  );
});

test("empty beats array round-trips (zero-length blob)", () => {
  const empty: BeatGrid = { ...sampleGrid(), beats: new Float32Array(0) };
  const params = beatGridToRow("u1", empty);
  assert.equal(params.beats.length, 0);
  const back = rowToBeatGrid({
    track_id: empty.trackId,
    duration_sec: empty.durationSec,
    beat_count: 0,
    downbeat_phase: empty.downbeatPhase,
    first_solid_index: empty.firstSolidBeatIndex,
    confidence: empty.confidence,
    analyzer_version: empty.analyzerVersion,
    analyzed_at: empty.analyzedAt,
    beats_blob: params.beats,
  });
  assert.ok(back);
  assert.equal(back.beats.length, 0);
});

test("rowToBeatGrid coerces bigint columns to numbers", () => {
  const params = beatGridToRow("u1", sampleGrid());
  const back = rowToBeatGrid({
    track_id: "x.mp3",
    duration_sec: 5,
    beat_count: 5n,
    downbeat_phase: 0,
    first_solid_index: 4n,
    confidence: 0.5,
    analyzer_version: 1,
    analyzed_at: 1_700_000_000_000n,
    beats_blob: params.beats,
  });
  assert.ok(back);
  assert.equal(typeof back.firstSolidBeatIndex, "number");
  assert.equal(typeof back.analyzedAt, "number");
  assert.equal(back.analyzedAt, 1_700_000_000_000);
});
