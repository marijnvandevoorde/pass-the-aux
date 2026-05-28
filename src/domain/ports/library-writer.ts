import type { Readable } from "node:stream";

/** Adds a new audio file to the library. Implemented by infrastructure. */
export interface LibraryWriter {
  /**
   * Atomically write `stream` into the library under a sanitised,
   * collision-safe name derived from `desiredBaseName` + `.${ext}`.
   * Returns the new library-relative path (a valid `TrackId`). A failed
   * write must never leave a partial file in the library.
   */
  write(
    stream: Readable,
    desiredBaseName: string,
    ext: string,
  ): Promise<string>;

  /**
   * If a file already exists for `desiredBaseName` (the sanitised base
   * with any audio extension), returns its library-relative path so
   * callers can skip a redundant download; otherwise null.
   */
  existing(desiredBaseName: string): Promise<string | null>;
}
