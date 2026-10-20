import test from "node:test";
import assert from "node:assert/strict";
import { BeatThisAnalyzer } from "../../src/infrastructure/beat-this-analyzer.ts";
import { Readable } from "node:stream";
import type { WorkerLease } from "../../src/infrastructure/beat-this-analyzer.ts";
import { BEATTHIS_ANALYZER_VERSION } from "../../src/domain/beat-grid.ts";
import {
  AnalyzerUnavailableError,
  TrackAnalysisFailedError,
  TrackNotFoundError,
} from "../../src/domain/errors.ts";
import type { AudioSource } from "../../src/domain/ports/audio-source.ts";
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

const AUDIO = Buffer.from("fake audio bytes");

/** One-track library: `song.mp3` and `s.mp3` exist, anything else 404s. */
const fakeAudio: AudioSource = {
  async stat(id) {
    if (id !== "song.mp3" && id !== "s.mp3") throw new TrackNotFoundError(id);
    return { id, size: AUDIO.length, contentType: "audio/mpeg" };
  },
  createStream() {
    return Readable.from([AUDIO]);
  },
};

function fakeWorker(over: Partial<WorkerLease> = {}): WorkerLease & {
  log: string[];
} {
  const log: string[] = [];
  return {
    log,
    acquire: async () => {
      log.push("acquire");
    },
    release: () => {
      log.push("release");
    },
    lost: () => {
      log.push("lost");
    },
    ...over,
  };
}

function analyzer(
  fetchImpl: typeof fetch,
  worker: WorkerLease = fakeWorker(),
): BeatThisAnalyzer {
  return new BeatThisAnalyzer({
    baseUrl: "http://pass-the-beat:8000/",
    audio: fakeAudio,
    fallback: fakeFallback(),
    worker,
    fetchImpl,
  });
}

async function bodyBytes(init: RequestInit | undefined): Promise<Buffer> {
  return Buffer.from(await new Response(init!.body as ReadableStream).arrayBuffer());
}

test("analyzeBeats uploads the audio and maps the reply onto a grid + BPM", async () => {
  const { fetchImpl, calls } = stub(() => okResponse(SAMPLE));
  const grid = await analyzer(fetchImpl).analyzeBeats("song.mp3");

  assert.ok(grid);
  assert.equal(grid.trackId, "song.mp3");
  assert.equal(grid.durationSec, 200);
  assert.deepEqual(Array.from(grid.beats), SAMPLE.beats);
  assert.equal(grid.downbeatPhase, 0); // downbeatIndices[0] = 0 → 0 % 4
  assert.equal(grid.firstSolidBeatIndex, 4);
  assert.equal(grid.confidence, 0.82);
  assert.equal(grid.analyzerVersion, BEATTHIS_ANALYZER_VERSION);
  assert.equal(grid.bpm, 120);

  assert.equal(calls[0]!.url, "http://pass-the-beat:8000/analyze-audio");
  const headers = calls[0]!.init!.headers as Record<string, string>;
  assert.equal(headers["Content-Length"], String(AUDIO.length));
  assert.deepEqual(await bodyBytes(calls[0]!.init), AUDIO);
});

test("downbeatPhase is the first downbeat index mod 4", async () => {
  const { fetchImpl } = stub(() =>
    okResponse({ ...SAMPLE, downbeatIndices: [6, 10] }),
  );
  const grid = await analyzer(fetchImpl).analyzeBeats("s.mp3");
  assert.equal(grid?.downbeatPhase, 2); // 6 % 4
});

test("unreachable sidecar → AnalyzerUnavailableError, never a lesser grid", async () => {
  const worker = fakeWorker();
  const fetchImpl: typeof fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  await assert.rejects(
    analyzer(fetchImpl, worker).analyzeBeats("s.mp3"),
    AnalyzerUnavailableError,
  );
  assert.deepEqual(worker.log, ["acquire", "lost", "release"]);
});

test("503 (model loading) → AnalyzerUnavailableError", async () => {
  const { fetchImpl } = stub(() => new Response("loading", { status: 503 }));
  await assert.rejects(
    analyzer(fetchImpl).analyzeBeats("s.mp3"),
    AnalyzerUnavailableError,
  );
});

test("downbeatPhase from a newer sidecar wins over the first downbeat", async () => {
  const { fetchImpl } = stub(() =>
    okResponse({ ...SAMPLE, downbeatIndices: [0, 5, 9, 13], downbeatPhase: 1 }),
  );
  const grid = await analyzer(fetchImpl).analyzeBeats("s.mp3");
  assert.equal(grid?.downbeatPhase, 1);
});

test("500 (the sidecar crashed on this track) → retryable, not stored as final", async () => {
  const { fetchImpl } = stub(() => new Response("boom", { status: 500 }));
  await assert.rejects(
    analyzer(fetchImpl).analyzeBeats("s.mp3"),
    TrackAnalysisFailedError,
  );
});

for (const status of [422]) {
  test(`${status} (the file itself) → an empty grid, stored as final`, async () => {
    const { fetchImpl } = stub(() => new Response("bad", { status }));
    const grid = await analyzer(fetchImpl).analyzeBeats("s.mp3");
    assert.ok(grid);
    assert.equal(grid.beats.length, 0);
    assert.equal(grid.analyzerVersion, BEATTHIS_ANALYZER_VERSION);
    assert.equal(grid.bpm, null);
  });
}

test("no beats → an empty grid that keeps the duration", async () => {
  const { fetchImpl } = stub(() =>
    okResponse({ ...SAMPLE, beats: [], downbeatIndices: [], bpm: null }),
  );
  const grid = await analyzer(fetchImpl).analyzeBeats("s.mp3");
  assert.equal(grid?.beats.length, 0);
  assert.equal(grid?.durationSec, 200);
});

test("a garbage reply is the sidecar's fault → unavailable", async () => {
  const { fetchImpl } = stub(() => okResponse({ nope: true }));
  await assert.rejects(
    analyzer(fetchImpl).analyzeBeats("s.mp3"),
    AnalyzerUnavailableError,
  );
});

test("a missing track returns null without starting the sidecar", async () => {
  const worker = fakeWorker();
  const { fetchImpl, calls } = stub(() => okResponse(SAMPLE));
  assert.equal(await analyzer(fetchImpl, worker).analyzeBeats("gone.mp3"), null);
  assert.equal(calls.length, 0);
  assert.deepEqual(worker.log, []);
});

test("a worker that can't start propagates and sends nothing", async () => {
  const { fetchImpl, calls } = stub(() => okResponse(SAMPLE));
  const worker = fakeWorker({
    acquire: async () => {
      throw new AnalyzerUnavailableError("no room");
    },
  });
  await assert.rejects(
    analyzer(fetchImpl, worker).analyzeBeats("s.mp3"),
    AnalyzerUnavailableError,
  );
  assert.equal(calls.length, 0);
});

test("acquire and release are paired around each upload", async () => {
  const worker = fakeWorker();
  const { fetchImpl } = stub(() => okResponse(SAMPLE));
  await analyzer(fetchImpl, worker).analyzeBeats("s.mp3");
  assert.deepEqual(worker.log, ["acquire", "release"]);
});

test("analyze is local only — the sidecar is not needed to enrich a track", async () => {
  const { fetchImpl, calls } = stub(() => okResponse(SAMPLE));
  assert.deepEqual(await analyzer(fetchImpl).analyze("s.mp3"), FALLBACK_FEATURES);
  assert.equal(calls.length, 0);
});

test("beatAnalyzerVersion reports the beat-this version", () => {
  const a = analyzer(async () => new Response("{}"));
  assert.equal(a.beatAnalyzerVersion, BEATTHIS_ANALYZER_VERSION);
});
