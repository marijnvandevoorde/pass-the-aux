import { ForbiddenPathError } from "./errors.ts";

/**
 * Value object for a track's identity: a library-relative path. Enforces
 * the core security invariant — the path may not be absolute or traverse
 * outside the library — independently of any filesystem.
 */
export class TrackId {
  readonly value: string;

  constructor(raw: unknown) {
    const input = typeof raw === "string" ? raw : "";
    const normalised = input.replace(/\\/g, "/").trim();
    if (
      normalised === "" ||
      normalised.startsWith("/") ||
      /(^|\/)\.\.(\/|$)/.test(normalised)
    ) {
      throw new ForbiddenPathError(input);
    }
    this.value = normalised;
  }

  toString(): string {
    return this.value;
  }
}
