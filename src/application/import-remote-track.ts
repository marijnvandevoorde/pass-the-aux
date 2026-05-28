import { InvalidRequestError, RemoteDisabledError } from "../domain/errors.ts";
import type { LibraryWriter } from "../domain/ports/library-writer.ts";
import type { RemoteSourceResolver } from "./search-remote.ts";

/** Downloads a remote track and writes it into the local library.
 *  Audio quality is the remote operator's choice — there's no client
 *  setting any more. */
export class ImportRemoteTrack {
  readonly #resolve: RemoteSourceResolver;
  readonly #writer: LibraryWriter;

  constructor(resolve: RemoteSourceResolver, writer: LibraryWriter) {
    this.#resolve = resolve;
    this.#writer = writer;
  }

  /** Returns the new library-relative path of the imported file. */
  async execute(remoteId: unknown, name?: unknown): Promise<{ path: string }> {
    const source = await this.#resolve();
    if (source === null || !source.enabled) throw new RemoteDisabledError();
    const id = typeof remoteId === "string" ? remoteId.trim() : "";
    if (id === "") throw new InvalidRequestError("missing remoteId");

    const base =
      typeof name === "string" && name.trim() !== "" ? name.trim() : id;

    // if we already have this track, reuse it — no download.
    const had = await this.#writer.existing(base);
    if (had !== null) return { path: had };

    const audio = await source.download(id);
    const path = await this.#writer.write(audio.stream, base, audio.ext);
    return { path };
  }
}
