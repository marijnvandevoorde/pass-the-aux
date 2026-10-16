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
  AnalyzedBeats,
  AudioAnalyzer,
  AudioFeatures,
} from "../../src/domain/ports/audio-analyzer.ts";
import { AnalyzerUnavailableError } from "../../src/domain/errors.ts";
import { GetBeatGrid } from "../../src/application/get-beat-grid.ts";

function fakeAnalyses(rows: string[]): AnalysisRepository & {
  map: Record<string, AnalysisRecord>;
} {
  const map: Record<string, AnalysisRecord> = {};
  for (const id of rows) {
    map[id] = { bpm: 120, size: 1, mtime: 1, analyzedAt: 1, key: "Am" };
  }
  return {
    map,
    async all() {
      return { ...map };
    },
    async put(_uid, id, record) {
      map[id] = { ...record, analyzedAt: 2 };
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
  beats: (id: string) => AnalyzedBeats | null,
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
  assert.deepEqual(r, { scanned: 3, built: 3, unavailable: false });
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

test("the analyzer's BPM replaces the provisional library BPM", async () => {
  const analyses = fakeAnalyses(["a.mp3", "b.mp3"]);
  const grids = fakeGrids();
  const analyzer = fakeAnalyzer((id) => ({
    ...dummyGrid(id),
    bpm: id === "a.mp3" ? 127.96 : null,
  }));
  await new BuildBeatGrids(analyses, grids, analyzer, "u1").execute();
  assert.equal(analyses.map["a.mp3"]!.bpm, 128);
  assert.equal(analyses.map["a.mp3"]!.key, "Am"); // the rest untouched
  assert.equal(analyses.map["b.mp3"]!.bpm, 120); // no BPM reported → kept
  // the stored grid carries no bpm field
  assert.equal("bpm" in (grids.store.get("u1::a.mp3") as object), false);
});

test("an unavailable analyzer ends the run and stores nothing for the rest", async () => {
  const analyses = fakeAnalyses(["a.mp3", "b.mp3", "c.mp3"]);
  const grids = fakeGrids();
  let calls = 0;
  const analyzer = fakeAnalyzer((id) => {
    calls++;
    if (id === "b.mp3") throw new AnalyzerUnavailableError();
    return dummyGrid(id);
  });
  const r = await new BuildBeatGrids(analyses, grids, analyzer, "u1").execute();
  assert.deepEqual(r, { scanned: 3, built: 1, unavailable: true });
  assert.equal(calls, 2); // c.mp3 never tried
  assert.equal(await grids.has("u1", "b.mp3"), false);
  assert.equal(analyses.map["b.mp3"]!.bpm, 120);
});

test("an empty grid is stored (not retried) but served as 'no grid'", async () => {
  const analyses = fakeAnalyses(["a.mp3"]);
  const grids = fakeGrids();
  let calls = 0;
  const analyzer = fakeAnalyzer((id) => {
    calls++;
    return { ...dummyGrid(id), beats: new Float32Array(0), bpm: null };
  });
  const uc = new BuildBeatGrids(analyses, grids, analyzer, "u1");
  await uc.execute();
  await uc.execute();
  assert.equal(calls, 1);
  assert.equal(await grids.has("u1", "a.mp3"), true);
  assert.equal(await new GetBeatGrid(grids, "u1").execute("a.mp3"), null);
});
