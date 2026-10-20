import { RemoteStartingError } from "../domain/errors.ts";
import type {
  RemoteAudio,
  RemoteCheck,
  RemoteCover,
  RemoteSearchPage,
  RemoteSource,
} from "../domain/ports/remote-source.ts";
import type { WorkerLease } from "./worker-lease.ts";

/** Longest a download keeps the server held if its stream never closes. */
const HOLD_LIMIT_MS = 10 * 60_000;

/** A lease that can also be started ahead of use (`ScaledWorker`). */
export interface WarmableLease extends WorkerLease {
  warm(): void;
}

/**
 * Wraps a remote whose server runs on demand (spotify-api on Kubernetes):
 * every call holds the lease, so the server is started when needed and
 * stays up until it has been idle for a while. A call that finds it down
 * waits up to `waitMs` for it; if it still isn't ready, the call fails
 * with `RemoteStartingError` ("try again in a moment") while the start
 * carries on in the background.
 */
export class OnDemandRemoteSource implements RemoteSource {
  readonly #inner: RemoteSource;
  readonly #lease: WarmableLease;
  readonly #waitMs: number;

  constructor(inner: RemoteSource, lease: WarmableLease, waitMs: number) {
    this.#inner = inner;
    this.#lease = lease;
    this.#waitMs = waitMs;
  }

  get id(): string {
    return this.#inner.id;
  }

  get displayName(): string {
    return this.#inner.displayName;
  }

  get enabled(): boolean {
    return this.#inner.enabled;
  }

  prepare(): void {
    this.#lease.warm();
  }

  async search(query: string, offset?: number): Promise<RemoteSearchPage> {
    await this.#acquire();
    try {
      return await this.#inner.search(query, offset);
    } catch (e) {
      this.#lease.lost(); // the next call checks the server's health first
      throw e;
    } finally {
      this.#lease.release();
    }
  }

  /** Starts the server like any other call; "starting up" is a result,
   *  not an exception. */
  async check(): Promise<RemoteCheck> {
    try {
      await this.#acquire();
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : String(e),
        tracks: null,
        indexing: false,
      };
    }
    try {
      if (this.#inner.check) return await this.#inner.check();
      const page = await this.#inner.search("a");
      return { ok: true, message: `Connected (a test search found ${page.total} tracks)`, tracks: null, indexing: false };
    } catch (e) {
      this.#lease.lost();
      return {
        ok: false,
        message: (e instanceof Error ? e.message : String(e)).replace(/^remote library: /, ""),
        tracks: null,
        indexing: false,
      };
    } finally {
      this.#lease.release();
    }
  }

  async cover(remoteId: string): Promise<RemoteCover | null> {
    if (!this.#inner.cover) return null;
    await this.#acquire();
    try {
      return await this.#inner.cover(remoteId);
    } finally {
      this.#lease.release();
    }
  }

  async download(remoteId: string): Promise<RemoteAudio> {
    await this.#acquire();
    let audio: RemoteAudio;
    try {
      audio = await this.#inner.download(remoteId);
    } catch (e) {
      this.#lease.lost();
      this.#lease.release();
      throw e;
    }
    // Hold the server until the bytes have been read (or, should the
    // stream never close, for at most HOLD_LIMIT_MS).
    let held = true;
    const done = (): void => {
      if (!held) return;
      held = false;
      clearTimeout(limit);
      this.#lease.release();
    };
    const limit = setTimeout(done, HOLD_LIMIT_MS);
    limit.unref?.();
    audio.stream.once("close", done);
    return audio;
  }

  async #acquire(): Promise<void> {
    const acquired = this.#lease.acquire();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), this.#waitMs);
    });
    const ready = acquired.then(() => "ready" as const);
    ready.catch(() => {}); // a late failure is handled below, not unhandled
    try {
      const first = await Promise.race([ready, timedOut]);
      if (first === "ready") return;
    } finally {
      clearTimeout(timer);
    }
    // Still starting: let it finish on its own and hand the hold back.
    acquired.then(
      () => this.#lease.release(),
      () => {},
    );
    throw new RemoteStartingError(this.displayName);
  }
}

/** Whether a remote's base URL points at the given service: same host
 *  (or a longer DNS name of it, `spotify-api.apps.svc…`) and port. */
export function pointsAt(baseUrl: string | null, serviceUrl: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL((baseUrl ?? "").trim());
    b = new URL(serviceUrl.trim());
  } catch {
    return false;
  }
  const host = b.hostname.toLowerCase();
  const other = a.hostname.toLowerCase();
  return (other === host || other.startsWith(`${host}.`)) && a.port === b.port;
}
