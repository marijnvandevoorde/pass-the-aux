import { TrackId } from "../domain/track-id.ts";
import type { Waveform } from "../domain/waveform.ts";
import type { WaveformSource } from "../domain/ports/waveform-source.ts";

/** Waveforms kept per account; each is ~1 KB. */
const CACHE_SIZE = 500;

/** A track's overview waveform for the mobile DJ and the crowd screen.
 *  Computing one decodes the whole file, so results are cached (most
 *  recently used kept) and concurrent requests for the same track share
 *  one decode. Unreadable tracks aren't cached: the file may still be
 *  arriving. */
export class GetWaveform {
  readonly #source: WaveformSource;
  readonly #cache = new Map<string, Waveform>();
  readonly #inFlight = new Map<string, Promise<Waveform | null>>();

  constructor(source: WaveformSource) {
    this.#source = source;
  }

  async execute(rawPath: unknown): Promise<Waveform | null> {
    const id = new TrackId(rawPath).value; // throws on traversal → 403
    const hit = this.#cache.get(id);
    if (hit) {
      this.#cache.delete(id); // refresh its place as most recent
      this.#cache.set(id, hit);
      return hit;
    }
    const pending = this.#inFlight.get(id);
    if (pending) return pending;
    const p = this.#source
      .waveform(id)
      .then((w) => {
        if (w && w.peaks.length > 0) {
          this.#cache.set(id, w);
          if (this.#cache.size > CACHE_SIZE) {
            const oldest = this.#cache.keys().next().value;
            if (oldest !== undefined) this.#cache.delete(oldest);
          }
          return w;
        }
        return null;
      })
      .finally(() => this.#inFlight.delete(id));
    this.#inFlight.set(id, p);
    return p;
  }
}
