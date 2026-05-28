import test from "node:test";
import assert from "node:assert/strict";
import { AnalyzeLibrary } from "../../src/application/analyze-library.ts";
import type {
  AnalysisRecord,
  AnalysisRepository,
} from "../../src/domain/ports/analysis-repository.ts";
import type {
  AudioAnalyzer,
  AudioFeatures,
} from "../../src/domain/ports/audio-analyzer.ts";

const rec = (p: Partial<AnalysisRecord>): AnalysisRecord => ({
  bpm: null,
  size: 1,
  mtime: 2,
  analyzedAt: 3,
  key: null,
  mode: null,
  camelot: null,
  energy: null,
  artist: "A",
  title: "T",
  ...p,
});

function setup(rows: Record<string, AnalysisRecord>, analyzer: AudioAnalyzer) {
  const db = { ...rows };
  const analyses: AnalysisRepository = {
    all: async () => db,
    put: async (_u, id, r) => {
      db[id] = { ...r, analyzedAt: 9 };
    },
    page: async () => ({ items: [], total: 0 }),
  };
  return { uc: new AnalyzeLibrary(analyses, analyzer, "u1"), db };
}

const full: AudioFeatures = {
  bpm: 128,
  key: "A",
  mode: "minor",
  camelot: "8A",
  energy: 0.6,
};

test("analyses every row missing ANY field; fills, never clobbers", async () => {
  const { uc, db } = setup(
    {
      "no-anything.mp3": rec({}),
      "has-bpm-no-energy.mp3": rec({ bpm: 120, key: "C", mode: "major", camelot: "8B" }),
      "complete.mp3": rec({ bpm: 90, key: "D", mode: "minor", camelot: "7A", energy: 0.4 }),
    },
    { beatAnalyzerVersion: 1, analyze: async () => full, analyzeBeats: async () => null },
  );
  const r = await uc.execute();
  assert.equal(r.scanned, 3);
  assert.equal(r.analyzed, 2); // complete.mp3 skipped

  // missing-everything → filled from analyzer
  assert.equal(db["no-anything.mp3"]!.bpm, 128);
  assert.equal(db["no-anything.mp3"]!.energy, 0.6);
  // had a bpm/key already → kept; only the missing energy filled
  assert.equal(db["has-bpm-no-energy.mp3"]!.bpm, 120); // NOT 128
  assert.equal(db["has-bpm-no-energy.mp3"]!.key, "C"); // NOT "A"
  assert.equal(db["has-bpm-no-energy.mp3"]!.energy, 0.6); // filled
  // already complete → untouched
  assert.equal(db["complete.mp3"]!.bpm, 90);
});

test("unreadable track is skipped, the rest still processed", async () => {
  const { uc, db } = setup(
    { "bad.mp3": rec({}), "good.mp3": rec({}) },
    {
      beatAnalyzerVersion: 1,
      analyze: async (id) => (id === "bad.mp3" ? null : full),
      analyzeBeats: async () => null,
    },
  );
  const r = await uc.execute();
  assert.equal(r.analyzed, 1);
  assert.equal(db["bad.mp3"]!.bpm, null); // left as-is
  assert.equal(db["good.mp3"]!.bpm, 128);
});
