import { TrackId } from "../domain/track-id.ts";
import { Tempo } from "../domain/tempo.ts";
import { TrackNotFoundError } from "../domain/errors.ts";
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
import { parseTrackName } from "../domain/track-naming.ts";

const NO_TAGS: TagReader = {
  read: async () => null,
  readCover: async () => null,
};

export interface SavedAnalysis {
  path: string;
  bpm: number;
}

export interface RawFeatures {
  key?: unknown;
  mode?: unknown;
  camelot?: unknown;
  energy?: unknown;
}

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s === "" || s.length > 16 ? null : s;
}

function unit(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v)
    ? Math.min(1, Math.max(0, v))
    : null;
}

/** Persists a client-computed BPM for a track, after validating both. */
export class SaveAnalysis {
  readonly #tracks: TrackRepository;
  readonly #analyses: AnalysisRepository;
  readonly #tags: TagReader;
  readonly #userId: string;
  readonly #coverSource: CoverArtSource | null;
  readonly #coverStore: CoverStore | null;

  constructor(
    tracks: TrackRepository,
    analyses: AnalysisRepository,
    userId = "",
    tags: TagReader = NO_TAGS,
    coverSource: CoverArtSource | null = null,
    coverStore: CoverStore | null = null,
  ) {
    this.#tracks = tracks;
    this.#analyses = analyses;
    this.#tags = tags;
    this.#userId = userId;
    this.#coverSource = coverSource;
    this.#coverStore = coverStore;
  }

  async execute(
    rawPath: unknown,
    rawBpm: unknown,
    rawFeatures?: RawFeatures,
  ): Promise<SavedAnalysis> {
    const id = new TrackId(rawPath).value;
    const track = await this.#tracks.findById(id);
    if (track === null) {
      throw new TrackNotFoundError(id);
    }
    const tempo = new Tempo(rawBpm);
    const record = {
      bpm: tempo.bpm,
      size: track.size,
      mtime: track.mtime,
    } as Omit<AnalysisRecord, "analyzedAt">;
    // Only attach feature keys when provided, so legacy callers persist
    // exactly { bpm, size, mtime }.
    if (rawFeatures) {
      record.key = str(rawFeatures.key);
      record.mode = str(rawFeatures.mode);
      record.camelot = str(rawFeatures.camelot);
      record.energy = unit(rawFeatures.energy);
    }
    // persist artist/title — embedded tags win, else the
    // filename ("Artist - Title" on the first " - ", else the name).
    const tags = await this.#tags.read(id).catch(() => null);
    const parsed = parseTrackName(track.name);
    record.artist = (tags?.artist?.trim() || null) ?? parsed.artist;
    record.title = (tags?.title?.trim() || null) ?? parsed.title;
    await this.#analyses.put(this.#userId, id, record);

    // Cover at analysis time (best-effort, never fails the analyse):
    // only when there's no embedded art and we haven't already stored
    // one. Fetched once → reused on every later load.
    if (this.#coverSource && this.#coverStore) {
      void this.#ensureCover(id, record.artist, record.title);
    }
    return { path: id, bpm: tempo.bpm };
  }

  async #ensureCover(
    id: string,
    artist: string | null | undefined,
    title: string | null | undefined,
  ): Promise<void> {
    if (!this.#coverSource || !this.#coverStore || !title) return;
    try {
      if (await this.#coverStore.has(id)) return;
      const embedded = await this.#tags.readCover(id).catch(() => null);
      if (embedded) return; // embedded art is served directly
      const bytes = await this.#coverSource.fetch(artist ?? null, title);
      if (bytes) await this.#coverStore.write(id, bytes);
    } catch {
      // network/store hiccup — a later analyse can retry
    }
  }
}
