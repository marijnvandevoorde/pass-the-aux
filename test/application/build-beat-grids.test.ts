import test from "node:test";
import assert from "node:assert/strict";
import { BuildBeatGrids } from "../../src/application/build-beat-grids.ts";
import {
  BEAT_GRID_ANALYZER_VERSION,
  type BeatGrid,
} from "../../src/domain/beat-grid.ts";
import type {
  AnalysisRecord,
  AnalysisRepository,
  LibraryPage,
  LibraryQuery,
} from "../../src/domain/ports/analysis-repository.ts";
import type { BeatGridRepository } from "../../src/domain/ports/beat-grid-repository.ts";
import type {
  AudioAnalyzer,
  AudioFeatures,
} from "../../src/domain/ports/audio-analyzer.ts";

function fakeAnalyses(rows: string[]): AnalysisRepository {
  const map: Record<string, AnalysisRecord> = {};
  for (const id of rows) {
    map[id] = { bpm: 120, size: 1, mtime: 1, analyzedAt: 1 };
  }
  return {
    async all() {
      return map;
    },
    async put() {
      /* not used here */
    },
    async page(_uid: string, _q: LibraryQuery): Promise<LibraryPage> {
      return { items: [], total: 0 };
    },
  };
}

function fakeGrids(): BeatGridRepository & {
  store: Map<string, BeatGrid>;
} {
  const store = new Map<string, BeatGrid>();
  return {
    store,
    async get(uid, id) {
      return store.get(`${uid}::${id}`) ?? null;
    },
    async put(uid, grid) {
      store.set(`${uid}::${grid.trackId}`, {
        ...grid,
        analyzedAt: Date.now(),
      } as BeatGrid);
    },
    async has(uid, id) {
      return store.has(`${uid}::${id}`);
    },
  };
}

function fakeAnalyzer(
  beats: (id: string) => Omit<BeatGrid, "analyzedAt"> | null,
): AudioAnalyzer {
  return {
    beatAnalyzerVersion: BEAT_GRID_ANALYZER_VERSION,
    async analyze(): Promise<AudioFeatures | null> {
      return null;
    },
    async analyzeBeats(id: string) {
      return beats(id);
    },
  };
}

function dummyGrid(id: string): Omit<BeatGrid, "analyzedAt"> {
  return {
    trackId: id,
    durationSec: 60,
    beats: new Float32Array([0.5, 1, 1.5, 2]),
    downbeatPhase: 0,
    firstSolidBeatIndex: 0,
    confidence: 0.7,
    analyzerVersion: BEAT_GRID_ANALYZER_VERSION,
  };
}

test("builds grids for every track that lacks one", async () => {
  const analyses = fakeAnalyses(["a.mp3", "b.mp3", "c.mp3"]);
  const grids = fakeGrids();
  const analyzer = fakeAnalyzer((id) => dummyGrid(id));
  const uc = new BuildBeatGrids(analyses, grids, analyzer, "u1");
  const r = await uc.execute();
  assert.deepEqual(r, { scanned: 3, built: 3 });
  assert.equal(grids.store.size, 3);
});

test("skips tracks that already have a current-version grid", async () => {
  const analyses = fakeAnalyses(["a.mp3", "b.mp3"]);
  const grids = fakeGrids();
  // Pre-seed b.mp3 with a current grid; only a.mp3 should be (re-)built.
  await grids.put("u1", dummyGrid("b.mp3"));
  let calls = 0;
  const analyzer = fakeAnalyzer((id) => {
    calls++;
    return dummyGrid(id);
  });
  const uc = new BuildBeatGrids(analyses, grids, analyzer, "u1");
  const r = await uc.execute();
  assert.equal(r.scanned, 2);
  assert.equal(r.built, 1);
  assert.equal(calls, 1);
});

test("re-builds tracks whose stored analyzerVersion is older", async () => {
  const analyses = fakeAnalyses(["a.mp3"]);
  const grids = fakeGrids();
  await grids.put("u1", {
    ...dummyGrid("a.mp3"),
    analyzerVersion: BEAT_GRID_ANALYZER_VERSION - 1,
  });
  const analyzer = fakeAnalyzer((id) => dummyGrid(id));
  const uc = new BuildBeatGrids(analyses, grids, analyzer, "u1");
  const r = await uc.execute();
  assert.equal(r.built, 1);
  const stored = await grids.get("u1", "a.mp3");
  assert.equal(stored?.analyzerVersion, BEAT_GRID_ANALYZER_VERSION);
});

test("a null analyzeBeats result is silently skipped (not a write)", async () => {
  const analyses = fakeAnalyses(["a.mp3", "b.mp3", "c.mp3"]);
  const grids = fakeGrids();
  const analyzer = fakeAnalyzer((id) => (id === "b.mp3" ? null : dummyGrid(id)));
  const uc = new BuildBeatGrids(analyses, grids, analyzer, "u1");
  const r = await uc.execute();
  assert.equal(r.built, 2);
  assert.equal(grids.store.size, 2);
  assert.equal(await grids.has("u1", "b.mp3"), false);
});

test("a thrown analyzeBeats does not abort the run", async () => {
  const analyses = fakeAnalyses(["a.mp3", "b.mp3", "c.mp3"]);
  const grids = fakeGrids();
  const analyzer = fakeAnalyzer((id) => {
    if (id === "b.mp3") throw new Error("boom");
    return dummyGrid(id);
  });
  const uc = new BuildBeatGrids(analyses, grids, analyzer, "u1");
  const r = await uc.execute();
  assert.equal(r.built, 2);
  assert.equal(await grids.has("u1", "a.mp3"), true);
  assert.equal(await grids.has("u1", "b.mp3"), false);
  assert.equal(await grids.has("u1", "c.mp3"), true);
});
