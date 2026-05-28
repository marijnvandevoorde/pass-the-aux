import test from "node:test";
import assert from "node:assert/strict";
import { BeatThisAnalyzer } from "../../src/infrastructure/beat-this-analyzer.ts";
import { BEATTHIS_ANALYZER_VERSION } from "../../src/domain/beat-grid.ts";
import type {
  AudioAnalyzer,
  AudioFeatures,
} from "../../src/domain/ports/audio-analyzer.ts";

type Call = { url: string; init: RequestInit | undefined };

function stub(response: () => Response): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return response();
  };
  return { fetchImpl, calls };
}

const FALLBACK_FEATURES: AudioFeatures = {
  bpm: 100,
  key: "C",
  mode: "major",
  camelot: "8B",
  energy: 0.5,
};

/** The local analyzer beat-this wraps for key/energy + as the fallback. */
function fakeFallback(over: Partial<AudioAnalyzer> = {}): AudioAnalyzer {
  return {
    beatAnalyzerVersion: 1,
    analyze: async () => FALLBACK_FEATURES,
    analyzeBeats: async () => null,
    ...over,
  };
}

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE = {
  beats: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
  downbeatIndices: [0, 4],
  bpm: 120,
  confidence: 0.82,
  duration: 200,
  firstSolidBeat: 4,
};

function analyzer(
  fetchImpl: typeof fetch,
  musicSubdir = "",
): BeatThisAnalyzer {
  return new BeatThisAnalyzer({
    baseUrl: "http://pass-the-beat:8000",
    musicSubdir,
    fallback: fakeFallback(),
    fetchImpl,
  });
}

test("analyzeBeats maps a sidecar response onto a BeatGrid", async () => {
  const { fetchImpl, calls } = stub(() => okResponse(SAMPLE));
  const grid = await analyzer(fetchImpl, "u1").analyzeBeats("song.mp3");

  assert.ok(grid);
  assert.equal(grid.trackId, "song.mp3");
  assert.equal(grid.durationSec, 200);
  assert.deepEqual(Array.from(grid.beats), SAMPLE.beats);
  assert.equal(grid.downbeatPhase, 0); // downbeatIndices[0] = 0 → 0 % 4
  assert.equal(grid.firstSolidBeatIndex, 4);
  assert.equal(grid.confidence, 0.82);
  assert.equal(grid.analyzerVersion, BEATTHIS_ANALYZER_VERSION);

  // The worker path is prefixed with the user's music subdir.
  const body = JSON.parse(String(calls[0]!.init!.body)) as { path: string };
  assert.equal(body.path, "u1/song.mp3");
});

test("downbeatPhase is the first downbeat index mod 4", async () => {
  const { fetchImpl } = stub(() =>
    okResponse({ ...SAMPLE, downbeatIndices: [6, 10] }),
  );
  const grid = await analyzer(fetchImpl).analyzeBeats("s.mp3");
  assert.equal(grid?.downbeatPhase, 2); // 6 % 4
});

test("analyzeBeats returns null when the sidecar is unreachable", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.equal(await analyzer(fetchImpl).analyzeBeats("s.mp3"), null);
});

test("analyzeBeats returns null on a non-OK response", async () => {
  const { fetchImpl } = stub(() => new Response("nope", { status: 500 }));
  assert.equal(await analyzer(fetchImpl).analyzeBeats("s.mp3"), null);
});

test("analyzeBeats returns null when the grid has no beats", async () => {
  const { fetchImpl } = stub(() =>
    okResponse({ ...SAMPLE, beats: [], downbeatIndices: [] }),
  );
  assert.equal(await analyzer(fetchImpl).analyzeBeats("s.mp3"), null);
});

test("analyze uses sidecar BPM, delegates key/mode/energy to the fallback", async () => {
  const { fetchImpl } = stub(() => okResponse(SAMPLE));
  const f = await analyzer(fetchImpl).analyze("s.mp3");
  assert.deepEqual(f, {
    bpm: 120, // from beat-this
    key: "C", // the rest from the local fallback
    mode: "major",
    camelot: "8B",
    energy: 0.5,
  });
});

test("analyze falls back to local features when the sidecar is down", async () => {
  const fetchImpl: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  assert.deepEqual(await analyzer(fetchImpl).analyze("s.mp3"), FALLBACK_FEATURES);
});

test("beatAnalyzerVersion reports the beat-this version", () => {
  const a = analyzer(async () => new Response("{}"));
  assert.equal(a.beatAnalyzerVersion, BEATTHIS_ANALYZER_VERSION);
});

test("no music subdir → the worker path has no prefix", async () => {
  const { fetchImpl, calls } = stub(() => okResponse(SAMPLE));
  await analyzer(fetchImpl).analyzeBeats("song.mp3");
  const body = JSON.parse(String(calls[0]!.init!.body)) as { path: string };
  assert.equal(body.path, "song.mp3");
});
