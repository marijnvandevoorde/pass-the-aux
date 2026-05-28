import {
  BEATTHIS_ANALYZER_VERSION,
  type BeatGrid,
} from "../domain/beat-grid.ts";
import type {
  AudioAnalyzer,
  AudioFeatures,
} from "../domain/ports/audio-analyzer.ts";

/** Wire shape of the pass-the-beat sidecar's `POST /analyze` response. */
interface AnalyzeResponse {
  beats: number[];
  downbeatIndices: number[];
  bpm: number | null;
  confidence: number;
  duration: number;
  firstSolidBeat: number;
}

export interface BeatThisAnalyzerOptions {
  /** Base URL of the pass-the-beat sidecar (trailing slashes are trimmed). */
  baseUrl: string;
  /** This user's subdir relative to the shared music root — the sidecar
   *  reads `<musicSubdir>/<trackId>` under its own `/music` mount. `""`
   *  for the flat (auth-off) layout. */
  musicSubdir: string;
  /** Local analyzer for key/mode/camelot/energy — pass-the-beat is rhythm-
   *  only — and the fallback when the sidecar can't be reached. */
  fallback: AudioAnalyzer;
  /** Injectable `fetch` (defaults to the global) — used by unit tests. */
  fetchImpl?: typeof fetch;
}

/**
 * `AudioAnalyzer` backed by the self-hosted pass-the-beat sidecar. pass-the-beat
 * is a learned beat tracker with far better recall than the in-house
 * Ellis-DP DSP on quiet intros / ballads / sparse percussion.
 *
 * It does rhythm only, so this adapter wraps a local `FfmpegAudioAnalyzer`
 * for key/mode/energy. The wrapped analyzer is also the graceful fallback:
 * if the sidecar is unreachable, `analyze()` still returns local features
 * and `analyzeBeats()` returns null (no grid — exactly the contract the
 * local analyzer uses when ffmpeg is absent).
 */
export class BeatThisAnalyzer implements AudioAnalyzer {
  readonly beatAnalyzerVersion = BEATTHIS_ANALYZER_VERSION;
  readonly #base: string;
  readonly #subdir: string;
  readonly #fallback: AudioAnalyzer;
  readonly #fetch: typeof fetch;

  constructor(opts: BeatThisAnalyzerOptions) {
    this.#base = opts.baseUrl.trim().replace(/\/+$/, "");
    this.#subdir = opts.musicSubdir;
    this.#fallback = opts.fallback;
    this.#fetch = opts.fetchImpl ?? globalThis.fetch;
  }

  /** BPM from pass-the-beat (a steadier tempo than the local estimate);
   *  key/mode/camelot/energy from the local DSP. Sidecar down ⇒ the
   *  local features stand on their own. */
  async analyze(trackId: string): Promise<AudioFeatures | null> {
    const local = await this.#fallback.analyze(trackId);
    const res = await this.#post(trackId);
    if (res === null) return local;
    return {
      bpm: res.bpm ?? local?.bpm ?? null,
      key: local?.key ?? null,
      mode: local?.mode ?? null,
      camelot: local?.camelot ?? null,
      energy: local?.energy ?? null,
    };
  }

  async analyzeBeats(
    trackId: string,
  ): Promise<Omit<BeatGrid, "analyzedAt"> | null> {
    const res = await this.#post(trackId);
    if (res === null) return null; // unreachable / failed — graceful skip
    if (res.beats.length === 0) return null; // no trackable pulse

    // pass-the-beat emits explicit per-beat downbeats; the browser still
    // models a rigid 4/4 grid (`downbeatPhase`), so collapse to the
    // phase of the first downbeat. Faithful for 4/4 dance music — the
    // explicit downbeat array is a deliberate future enhancement.
    const firstDownbeat = res.downbeatIndices[0] ?? 0;
    const downbeatPhase = (((firstDownbeat % 4) + 4) % 4) as 0 | 1 | 2 | 3;

    return {
      trackId,
      durationSec: res.duration,
      beats: Float32Array.from(res.beats),
      downbeatPhase,
      firstSolidBeatIndex: res.firstSolidBeat,
      confidence: res.confidence,
      analyzerVersion: BEATTHIS_ANALYZER_VERSION,
    };
  }

  #workerPath(trackId: string): string {
    return this.#subdir ? `${this.#subdir}/${trackId}` : trackId;
  }

  /** POST to the sidecar; null on any unreachable/non-OK/garbage result
   *  so every caller degrades gracefully. */
  async #post(trackId: string): Promise<AnalyzeResponse | null> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: this.#workerPath(trackId) }),
      });
    } catch {
      return null; // sidecar unreachable
    }
    if (!res.ok) return null; // 4xx/5xx — treat as "no grid"
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    return parseAnalyze(json);
  }
}

const numbers = (v: unknown): number[] =>
  Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];

/** Defensive parse — the sidecar is trusted, but a version skew should
 *  degrade to "no grid", never throw. */
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
  };
}
