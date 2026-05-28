/** The kinds of remote record stores a user can add. */
export type RemoteLibraryKind = "pta" | "jamendo" | "fma";

export const REMOTE_LIBRARY_KINDS: ReadonlyArray<RemoteLibraryKind> = [
  "pta",
  "jamendo",
  "fma",
];

export function isRemoteLibraryKind(v: unknown): v is RemoteLibraryKind {
  return (
    typeof v === "string" &&
    (REMOTE_LIBRARY_KINDS as ReadonlyArray<string>).includes(v)
  );
}

/** One configured remote record store, scoped to a user. */
export interface RemoteLibraryRow {
  id: string;
  userId: string;
  kind: RemoteLibraryKind;
  name: string;
  /** Required for `pta`. Ignored for `jamendo`/`fma` (they have fixed endpoints). */
  baseUrl: string | null;
  /** Bearer secret (pta) or API key (jamendo/fma). Never returned over HTTP. */
  apiKey: string | null;
  isActive: boolean;
  createdAt: number;
}

/** Caller-supplied fields when creating a new remote. */
export interface NewRemoteLibrary {
  kind: RemoteLibraryKind;
  name: string;
  baseUrl?: string | null;
  apiKey?: string | null;
}

/** Persistence port for remote-library configuration. */
export interface RemoteLibrariesRepository {
  /** All remotes owned by `uid`, ordered by createdAt asc. */
  listForUser(uid: string): Promise<RemoteLibraryRow[]>;

  /** The single active remote for `uid`, or `null`. */
  getActive(uid: string): Promise<RemoteLibraryRow | null>;

  /** Insert a new row. If it's the first remote for the user, it
   *  becomes active automatically. */
  create(uid: string, input: NewRemoteLibrary): Promise<RemoteLibraryRow>;

  /** Patch an existing row. `null` if the row doesn't exist or isn't
   *  owned by `uid`. */
  update(
    uid: string,
    id: string,
    patch: Partial<NewRemoteLibrary>,
  ): Promise<RemoteLibraryRow | null>;

  /** Returns `true` iff a row was deleted. If the deleted row was
   *  active, another remote (the oldest remaining) is promoted. */
  delete(uid: string, id: string): Promise<boolean>;

  /** Atomically mark `id` active and every other row of this user
   *  inactive. Returns `false` if `id` doesn't exist for this user. */
  setActive(uid: string, id: string): Promise<boolean>;
}
