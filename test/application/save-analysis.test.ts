import test from "node:test";
import assert from "node:assert/strict";
import { SaveAnalysis } from "../../src/application/save-analysis.ts";
import { Track } from "../../src/domain/track.ts";
import {
  ForbiddenPathError,
  InvalidTempoError,
  TrackNotFoundError,
} from "../../src/domain/errors.ts";
import type { TrackRepository } from "../../src/domain/ports/track-repository.ts";
import type {
  AnalysisRecord,
  AnalysisRepository,
} from "../../src/domain/ports/analysis-repository.ts";

function setup(found: Track | null) {
  const puts: Array<{ id: string; record: Omit<AnalysisRecord, "analyzedAt"> }> =
    [];
  const tracks: TrackRepository = {
    list: async () => [],
    findById: async () => found,
  };
  const analyses: AnalysisRepository = {
    all: async () => ({}),
    page: async () => ({ items: [], total: 0 }),
    put: async (_userId, id, record) => {
      puts.push({ id, record });
    },
  };
  return { useCase: new SaveAnalysis(tracks, analyses), puts };
}

const fixture = new Track({
  id: "a.mp3",
  name: "a.mp3",
  dir: "",
  ext: ".mp3",
  size: 555,
  mtime: 99,
  bpm: null,
});

test("persists a rounded BPM with the track's size and mtime", async () => {
  const { useCase, puts } = setup(fixture);
  const result = await useCase.execute("a.mp3", 128.06);
  assert.deepEqual(result, { path: "a.mp3", bpm: 128.1 });
  assert.equal(puts.length, 1);
  assert.deepEqual(puts[0], {
    id: "a.mp3",
    // artist/title are derived & persisted too (no tags here →
    // filename: "a.mp3" has no " - " → title "a", artist null).
    record: { bpm: 128.1, size: 555, mtime: 99, artist: null, title: "a" },
  });
});

test("rejects a traversal path before touching repositories", async () => {
  const { useCase, puts } = setup(fixture);
  await assert.rejects(() => useCase.execute("../x.mp3", 120), ForbiddenPathError);
  assert.equal(puts.length, 0);
});

test("rejects when the track does not exist", async () => {
  const { useCase } = setup(null);
  await assert.rejects(() => useCase.execute("missing.mp3", 120), TrackNotFoundError);
});

test("rejects an invalid tempo", async () => {
  const { useCase, puts } = setup(fixture);
  await assert.rejects(() => useCase.execute("a.mp3", -1), InvalidTempoError);
  assert.equal(puts.length, 0);
});
