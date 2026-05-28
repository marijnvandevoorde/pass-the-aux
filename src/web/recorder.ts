// records the mixer's master output to a downloadable file.
// Browser-only (MediaRecorder + Web Audio) — not unit-tested headlessly,
// per CLAUDE.md; the pure bits (mime pick, filename) are kept trivial.

/** Container/codec preference order. Opus-in-WebM is the broadest
 *  modern support; Ogg is the Firefox-era fallback. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
];

/** First MediaRecorder mime the browser supports, or "" to let it
 *  choose its own default. */
export function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

/** File extension for a recording's mime type. */
export function extForMime(mime: string): string {
  return mime.includes("ogg") ? "ogg" : "webm";
}

/** A `dj-mix-YYYY-MM-DD-HHMM.<ext>` filename for `at` (defaults: now). */
export function recordingFileName(ext: string, at: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}`;
  return `dj-mix-${stamp}.${ext}`;
}

/**
 * Wraps a MediaRecorder over the mixer's master MediaStream. Buffers
 * chunks in memory and assembles them into a single Blob on stop —
 * a DJ set is tens of MB at Opus bitrates, well within memory.
 */
export class MixRecorder {
  readonly #stream: MediaStream;
  #recorder: MediaRecorder | null = null;
  #chunks: Blob[] = [];
  #startedAt = 0;

  constructor(stream: MediaStream) {
    this.#stream = stream;
  }

  /** Whether this browser can record at all. */
  static get supported(): boolean {
    return typeof MediaRecorder !== "undefined";
  }

  get recording(): boolean {
    return this.#recorder !== null && this.#recorder.state === "recording";
  }

  /** Seconds since the current recording began (0 when idle). */
  get elapsedSec(): number {
    return this.recording ? (Date.now() - this.#startedAt) / 1000 : 0;
  }

  start(): void {
    if (this.recording) return;
    const mime = pickRecordingMime();
    this.#chunks = [];
    this.#recorder = new MediaRecorder(
      this.#stream,
      mime ? { mimeType: mime } : undefined,
    );
    this.#recorder.ondataavailable = (e): void => {
      if (e.data.size > 0) this.#chunks.push(e.data);
    };
    this.#recorder.start();
    this.#startedAt = Date.now();
  }

  /** Stop and resolve with the assembled recording. Resolves with an
   *  empty Blob if nothing was captured. */
  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      const rec = this.#recorder;
      if (!rec || rec.state === "inactive") {
        resolve(new Blob(this.#chunks));
        return;
      }
      rec.onstop = (): void => {
        resolve(new Blob(this.#chunks, { type: rec.mimeType || "audio/webm" }));
        this.#recorder = null;
      };
      rec.stop();
    });
  }
}
