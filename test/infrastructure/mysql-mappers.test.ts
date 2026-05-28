import test from "node:test";
import assert from "node:assert/strict";
import { rowToAnalysisRecord } from "../../src/infrastructure/mysql-analysis-repository.ts";
import { asTrackIds } from "../../src/infrastructure/mysql-crate-repository.ts";

test("rowToAnalysisRecord coerces numbers/bigints and keeps nulls", () => {
  assert.deepEqual(
    rowToAnalysisRecord({
      bpm: 128,
      size: 4096n,
      mtime: 1_700_000_000_000n,
      analyzed_at: 1_700_000_001_000,
      key: "A",
      mode: "minor",
      camelot: "8A",
      energy: 0.7,
      artist: "Daft Punk",
      title: "Get Lucky",
    }),
    {
      bpm: 128,
      size: 4096,
      mtime: 1_700_000_000_000,
      analyzedAt: 1_700_000_001_000,
      key: "A",
      mode: "minor",
      camelot: "8A",
      energy: 0.7,
      artist: "Daft Punk",
      title: "Get Lucky",
    },
  );
});

test("rowToAnalysisRecord: legacy row with null extras", () => {
  const r = rowToAnalysisRecord({
    bpm: 90,
    size: 1,
    mtime: 2,
    analyzed_at: 3,
    key: null,
    mode: null,
    camelot: null,
    energy: null,
  });
  assert.equal(r.key, null);
  assert.equal(r.energy, null);
  assert.equal(r.bpm, 90);
});

test("asTrackIds accepts arrays, JSON strings; rejects junk", () => {
  assert.deepEqual(asTrackIds(["a.mp3", "b.mp3"]), ["a.mp3", "b.mp3"]);
  assert.deepEqual(asTrackIds('["x.mp3"]'), ["x.mp3"]);
  assert.deepEqual(asTrackIds([1, "ok", null, "y"]), ["ok", "y"]);
  assert.deepEqual(asTrackIds("not json"), []);
  assert.deepEqual(asTrackIds(null), []);
  assert.deepEqual(asTrackIds(42), []);
});
