import type { TrackRepository } from "../domain/ports/track-repository.ts";
import type {
  AnalysisRecord,
  AnalysisRepository,
} from "../domain/ports/analysis-repository.ts";
import type { TagReader } from "../domain/ports/tag-reader.ts";
import type {
  CoverArtSource,
  CoverStore,
} from "../domain/ports/cover-art.ts";
import type { BpmSource } from "../domain/ports/bpm-source.ts";
import { parseTrackName } from "../domain/track-naming.ts";

const NO_TAGS: TagReader = {
  read: async () => null,
  readCover: async () => null,
};

/**
 * Server-side enrichment: for every library track that has no analysis
 * row yet, persist what we *can* without the browser — artist/title
 * (tags → filename), key & bpm from ID3 TKEY/TBPM when present (bpm
 * null otherwise), and a fetched cover. Never touches tracks that
 * already have a row, so a client-measured BPM is never clobbered.
 */
export class EnrichLibrary {
  readonly #tracks: TrackRepository;
  readonly #analyses: AnalysisRepository;
  readonly #tags: TagReader;
  readonly #userId: string;
  readonly #coverSource: CoverArtSource | null;
  readonly #coverStore: CoverStore | null;
  readonly #bpmSource: BpmSource | null;

  constructor(
    tracks: TrackRepository,
    analyses: AnalysisRepository,
    userId = "",
    tags: TagReader = NO_TAGS,
    coverSource: CoverArtSource | null = null,
    coverStore: CoverStore | null = null,
    bpmSource: BpmSource | null = null,
  ) {
    this.#tracks = tracks;
    this.#analyses = analyses;
    this.#tags = tags;
    this.#userId = userId;
    this.#coverSource = coverSource;
    this.#coverStore = coverStore;
    this.#bpmSource = bpmSource;
  }

  async execute(): Promise<{ scanned: number; enriched: number }> {
    const [tracks, existing] = await Promise.all([
      this.#tracks.list(),
      this.#analyses.all(this.#userId),
    ]);
    let enriched = 0;
    for (const track of tracks) {
      const prev = existing[track.id];

      // A <base>.jpg sidecar is the cover of record (served as a fast
      // static file by GetCover). Embedded ID3 art only *displays* via
      // GetCover's fallback — it is NOT a sidecar, so without this a
      // track with embedded art never gets a .jpg written to disk.
      // energy/mood is browser-only (no zero-dep server source) so it
      // never gates a re-scan.
      const hasSidecar = this.#coverStore
        ? await this.#coverStore.has(track.id)
        : true; // no store wired → requirement vacuously satisfied
      const haveBpm = !!prev && prev.bpm != null;
      const haveKey = !!prev && !!prev.key;
      if (prev && haveBpm && haveKey && hasSidecar) continue; // complete

      const tags = await this.#tags.read(track.id).catch(() => null);
      const parsed = parseTrackName(track.name);
      const artist =
        prev?.artist ?? (tags?.artist?.trim() || null) ?? parsed.artist;
      const title =
        prev?.title ?? (tags?.title?.trim() || null) ?? parsed.title;

      // Existing real values always win (never clobber a client BPM);
      // then embedded tags; then the metadata service for the gaps.
      let bpm = prev?.bpm ?? (typeof tags?.bpm === "number" ? tags.bpm : null);
      let key = prev?.key ?? (tags?.key?.trim() || null);
      if ((bpm === null || !key) && this.#bpmSource) {
        const looked = await this.#bpmSource
          .lookup(artist ?? null, title)
          .catch(() => null);
        if (looked) {
          bpm = bpm ?? looked.bpm;
          key = key ?? looked.key;
        }
      }

      const record: Omit<AnalysisRecord, "analyzedAt"> = {
        bpm,
        size: track.size,
        mtime: track.mtime,
        key,
        mode: prev?.mode ?? null,
        camelot: prev?.camelot ?? null,
        energy: prev?.energy ?? null,
        artist,
        title,
      };
      await this.#analyses.put(this.#userId, track.id, record);
      if (!hasSidecar) {
        await this.#ensureCover(track.id, artist, title);
      }
      enriched++;
    }
    return { scanned: tracks.length, enriched };
  }

  // Caller verified there's no sidecar yet. Create one: embedded ID3
  // art wins (no network, the exact album image); otherwise fetch it
  // from the cover service. Either way a <base>.jpg ends up next to
  // the mp3 so it's served as a static file from then on.
  async #ensureCover(
    id: string,
    artist: string | null | undefined,
    title: string | null | undefined,
  ): Promise<void> {
    if (!this.#coverStore) return;
    try {
      const embedded = await this.#tags.readCover(id).catch(() => null);
      if (embedded && embedded.data.byteLength > 0) {
        await this.#coverStore.write(id, embedded.data);
        return;
      }
      if (!this.#coverSource || !title) return;
      const bytes = await this.#coverSource.fetch(artist ?? null, title);
      if (bytes) await this.#coverStore.write(id, bytes);
    } catch {
      // best-effort — a later scan/analyse retries
    }
  }
}
