export interface AnalysisRecord {
  /** Null when no BPM could be detected (untagged + not yet analysed
   *  by the browser). The other fields are still persisted. */
  bpm: number | null;
  size: number;
  mtime: number;
  analyzedAt: number;
  // Optional extended features. Absent on legacy entries.
  key?: string | null;
  mode?: string | null;
  camelot?: string | null;
  energy?: number | null;
  // persisted artist/title (from tags, else filename split).
  artist?: string | null;
  title?: string | null;
}

export type LibrarySort = "title" | "bpm" | "energy";

export interface LibraryQuery {
  q: string;
  sort: LibrarySort;
  dir: "asc" | "desc";
  limit: number;
  offset: number;
}

export interface LibraryPage {
  items: Array<{ id: string; record: AnalysisRecord }>;
  total: number;
}

/** Persistence for BPM/feature analysis. Scoped by user — the
 *  track id is the bare filename within that user's library, never a
 *  path with a `<uid>/` prefix. `userId` is "" when auth is disabled. */
export interface AnalysisRepository {
  all(userId: string): Promise<Record<string, AnalysisRecord>>;
  put(
    userId: string,
    id: string,
    record: Omit<AnalysisRecord, "analyzedAt">,
  ): Promise<void>;
  /** index-backed, paginated/searched/sorted library page. */
  page(userId: string, query: LibraryQuery): Promise<LibraryPage>;
}
