import { Readable } from "node:stream";
import { BEATTHIS_ANALYZER_VERSION } from "../domain/beat-grid.ts";
import {
  AnalyzerUnavailableError,
  TrackAnalysisFailedError,
} from "../domain/errors.ts";
import type {
  AnalyzedBeats,
  AudioAnalyzer,
  AudioFeatures,
} from "../domain/ports/audio-analyzer.ts";
import type { AudioSource } from "../domain/ports/audio-source.ts";
import { ALWAYS_UP, type WorkerLease } from "./worker-lease.ts";

export { ALWAYS_UP, type WorkerLease };

/** Wire shape of the pass-the-beat sidecar's analyze response. */
interface AnalyzeResponse {
  beats: number[];
  downbeatIndices: number[];
  bpm: number | null;
  confidence: number;
  duration: number;
  firstSolidBeat: number;
  /** Whole-track bar phase (pass-the-beat ≥ analyzerVersion 2). Older
   *  sidecars omit it. */
  downbeatPhase: 0 | 1 | 2 | 3 | null;
}

export interface BeatThisAnalyzerOptions {
  /** Base URL of the pass-the-beat sidecar (trailing slashes are trimmed). */
  baseUrl: string;
  /** This user's audio; each track is uploaded to the sidecar, which has
   *  no access to the library itself. */
  audio: AudioSource;
  /** Local analyzer for key/mode/camelot/energy — pass-the-beat is rhythm-
   *  only. Its provisional BPM is replaced when the grid is built. */
  fallback: AudioAnalyzer;
  /** Starts/stops the sidecar on demand. Default: assume it is up. */
  worker?: WorkerLease;
  /** Injectable `fetch` (defaults to the global) — used by unit tests. */
  fetchImpl?: typeof fetch;
}

/**
 * `AudioAnalyzer` backed by the self-hosted pass-the-beat sidecar. pass-the-beat
 * is a learned beat tracker with far better recall than the in-house
 * Ellis-DP DSP on quiet intros / ballads / sparse percussion.
 *
 * `analyze()` is purely local (key/mode/energy and a provisional BPM), so
 * enriching a new track never needs the sidecar. `analyzeBeats()` is the
 * only sidecar call; it returns the grid together with the sidecar's BPM,
 * which `BuildBeatGrids` stores in place of the provisional one. When the
 * sidecar is unreachable it throws `AnalyzerUnavailableError` instead of
 * returning a lesser result, so nothing is recorded as done.
 */
export class BeatThisAnalyzer implements AudioAnalyzer {
  readonly beatAnalyzerVersion = BEATTHIS_ANALYZER_VERSION;
  readonly #base: string;
  readonly #audio: AudioSource;
  readonly #fallback: AudioAnalyzer;
  readonly #worker: WorkerLease;
  readonly #fetch: typeof fetch;

  constructor(opts: BeatThisAnalyzerOptions) {
    this.#base = opts.baseUrl.trim().replace(/\/+$/, "");
    this.#audio = opts.audio;
    this.#fallback = opts.fallback;
    this.#worker = opts.worker ?? ALWAYS_UP;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  analyze(trackId: string): Promise<AudioFeatures | null> {
    return this.#fallback.analyze(trackId);
  }

  async analyzeBeats(trackId: string): Promise<AnalyzedBeats | null> {
    let stat;
    try {
      stat = await this.#audio.stat(trackId);
    } catch {
      return null; // gone / not audio — nothing to analyse
    }
    await this.#worker.acquire();
    try {
      const res = await this.#post(trackId, stat.size);
      if (res === null) return emptyGrid(trackId, 0); // undecodable: final
      if (res.beats.length === 0) return emptyGrid(trackId, res.duration);

      // The browser models a rigid 4/4 grid (`downbeatPhase`). Newer
      // sidecars send the whole-track bar phase (a majority vote over all
      // downbeats); older ones only the downbeats, so fall back to the
      // phase of the first one, which is wrong when that one is an
      // outlier.
      const firstDownbeat = res.downbeatIndices[0] ?? 0;
      const downbeatPhase =
        res.downbeatPhase ??
        ((((firstDownbeat % 4) + 4) % 4) as 0 | 1 | 2 | 3);

      return {
        trackId,
        durationSec: res.duration,
        beats: Float32Array.from(res.beats),
        downbeatPhase,
        firstSolidBeatIndex: res.firstSolidBeat,
        confidence: res.confidence,
        analyzerVersion: BEATTHIS_ANALYZER_VERSION,
        bpm: res.bpm,
      };
    } finally {
      this.#worker.release();
    }
  }

  /** Uploads the track. Null when the sidecar rejects the audio itself
   *  (a permanent property of the file); throws AnalyzerUnavailableError
   *  when the sidecar can't do the work right now. */
  async #post(trackId: string, size: number): Promise<AnalyzeResponse | null> {
    let res: Response;
    try {
      const body = Readable.toWeb(this.#audio.createStream(trackId)) as ReadableStream;
      res = await this.#fetch(`${this.#base}/analyze-audio`, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(size),
          "X-Track-Name": encodeURIComponent(trackId),
        },
        body,
        duplex: "half",
      } as RequestInit);
    } catch (e) {
      this.#worker.lost();
      throw new AnalyzerUnavailableError(
        `pass-the-beat unreachable: ${(e as Error).message}`,
      );
    }
    if (res.status === 500) {
      // The sidecar crashed on this track (a bug, out of memory): may not
      // repeat, so don't record it as "no grid"; BuildBeatGrids retries.
      await res.body?.cancel();
      throw new TrackAnalysisFailedError(`pass-the-beat HTTP 500 for ${trackId}`);
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 404 && res.status !== 408 && res.status !== 429) {
      // 422 undecodable, 413 too big: properties of the file, so retrying
      // would only fail again.
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      // 503 still loading, 502/504 proxy, 404 an old sidecar without
      // /analyze-audio: the sidecar, not the track — try again later.
      await res.body?.cancel();
      this.#worker.lost();
      throw new AnalyzerUnavailableError(`pass-the-beat HTTP ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new AnalyzerUnavailableError("pass-the-beat sent garbage");
    }
    const parsed = parseAnalyze(json);
    if (parsed === null) {
      throw new AnalyzerUnavailableError("pass-the-beat sent an unexpected shape");
    }
    return parsed;
  }
}

/** "Analysed by beat-this, no pulse" — stored so the track is not sent
 *  again; the beat-grid endpoint treats it as "no grid". */
function emptyGrid(trackId: string, durationSec: number): AnalyzedBeats {
  return {
    trackId,
    durationSec,
    beats: new Float32Array(0),
    downbeatPhase: 0,
    firstSolidBeatIndex: -1,
    confidence: 0,
    analyzerVersion: BEATTHIS_ANALYZER_VERSION,
    bpm: null,
  };
}

const numbers = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];

/** Defensive parse — the sidecar is trusted, but a version skew must not
 *  throw from deep inside. */
function parseAnalyze(json: unknown): AnalyzeResponse | null {
  if (json === null || typeof json !== "object") return null;
  const j = json as Record<string, unknown>;
  if (!Array.isArray(j["beats"])) return null;
  return {
    beats: numbers(j["beats"]),
    downbeatIndices: numbers(j["downbeatIndices"]),
    bpm: typeof j["bpm"] === "number" ? j["bpm"] : null,
    confidence: typeof j["confidence"] === "number" ? j["confidence"] : 0,
    duration: typeof j["duration"] === "number" ? j["duration"] : 0,
    firstSolidBeat:
      typeof j["firstSolidBeat"] === "number" ? j["firstSolidBeat"] : -1,
    downbeatPhase:
      j["downbeatPhase"] === 0 ||
      j["downbeatPhase"] === 1 ||
      j["downbeatPhase"] === 2 ||
      j["downbeatPhase"] === 3
        ? j["downbeatPhase"]
        : null,
  };
}
