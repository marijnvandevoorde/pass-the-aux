import { InvalidRequestError, RemoteDisabledError } from "../domain/errors.ts";
import type {
  RemoteCover,
  RemoteSearchPage,
  RemoteSource,
} from "../domain/ports/remote-source.ts";

/** Resolves the user's currently-active remote source, or `null` if
 *  none is configured / the kind isn't supported yet. */
export type RemoteSourceResolver = () => Promise<RemoteSource | null>;

/** Searches the user's active remote record store. */
export class SearchRemote {
  readonly #resolve: RemoteSourceResolver;

  constructor(resolve: RemoteSourceResolver) {
    this.#resolve = resolve;
  }

  /** Whether the user has an enabled active remote. Async because the
   *  resolver typically hits the DB. The client asks this when the app
   *  loads, so an enabled source is also told to get ready. */
  async enabled(): Promise<boolean> {
    const s = await this.#resolve();
    if (s === null || !s.enabled) return false;
    s.prepare?.();
    return true;
  }

  /** A result's cover fetched through the active source (for results
   *  marked `coverViaSource`); null when there's none. */
  async cover(remoteId: unknown): Promise<RemoteCover | null> {
    const id = typeof remoteId === "string" ? remoteId.trim() : "";
    if (id === "" || id.length > 200) return null;
    const source = await this.#resolve();
    if (source === null || !source.enabled || !source.cover) return null;
    return source.cover(id).catch(() => null);
  }

  /** Validates input, then returns one page of remote results. */
  async execute(query: unknown, offset?: unknown): Promise<RemoteSearchPage> {
    const source = await this.#resolve();
    if (source === null || !source.enabled) throw new RemoteDisabledError();
    const q = typeof query === "string" ? query.trim() : "";
    if (q === "") throw new InvalidRequestError("missing search query");
    const n = Number(offset);
    const off =
      Number.isFinite(n) && n > 0 ? Math.min(1000, Math.floor(n)) : 0;
    return source.search(q, off);
  }
}
