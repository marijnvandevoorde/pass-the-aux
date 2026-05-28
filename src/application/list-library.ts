import { Track } from "../domain/track.ts";
import type {
  AnalysisRecord,
  AnalysisRepository,
  LibraryQuery,
} from "../domain/ports/analysis-repository.ts";

function toTrack(id: string, r: AnalysisRecord): Track {
  const dot = id.lastIndexOf(".");
  return new Track({
    id,
    name: id,
    dir: "",
    ext: dot > 0 ? id.slice(dot).toLowerCase() : "",
    size: r.size,
    mtime: r.mtime,
    bpm: r.bpm ?? null,
    title: r.title ?? null,
    artist: r.artist ?? null,
    key: r.key ?? null,
    mode: r.mode ?? null,
    camelot: r.camelot ?? null,
    energy: r.energy ?? null,
  });
}

/**
 * The user's library, served straight from the analysis store — no
 * per-request filesystem scan or tag extraction (DB is the source of
 * truth; the scan + background watch job keep it in sync). `page()`
 * is the index-backed, server-side searched/sorted/paginated view
 *; `execute()` returns the whole library.
 */
export class ListLibrary {
  readonly #analyses: AnalysisRepository;
  readonly #userId: string;

  constructor(analyses: AnalysisRepository, userId = "") {
    this.#analyses = analyses;
    this.#userId = userId;
  }

  async execute(): Promise<Track[]> {
    const all = await this.#analyses.all(this.#userId);
    return Object.entries(all)
      .map(([id, r]) => toTrack(id, r))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async page(
    query: LibraryQuery,
  ): Promise<{ tracks: Track[]; total: number; offset: number; limit: number }> {
    const { items, total } = await this.#analyses.page(this.#userId, query);
    return {
      tracks: items.map(({ id, record }) => toTrack(id, record)),
      total,
      offset: query.offset,
      limit: query.limit,
    };
  }
}
