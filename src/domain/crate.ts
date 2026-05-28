import { InvalidRequestError } from "./errors.ts";
import { TrackId } from "./track-id.ts";

export const MAX_CRATE_NAME = 80;

/**
 * A named, ordered collection of library tracks the user has saved for
 * later — persisted beyond the live automix queue. Identity is `name`;
 * each entry is a validated library-relative `TrackId`.
 */
export class Crate {
  readonly name: string;
  readonly trackIds: string[];

  constructor(rawName: unknown, rawTrackIds: unknown) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name === "") {
      throw new InvalidRequestError("crate name is required");
    }
    if (name.length > MAX_CRATE_NAME) {
      throw new InvalidRequestError(
        `crate name exceeds ${MAX_CRATE_NAME} characters`,
      );
    }
    if (!Array.isArray(rawTrackIds)) {
      throw new InvalidRequestError("crate trackIds must be an array");
    }
    // Re-validate every id through TrackId so a stored crate can never
    // smuggle a traversal path back in (defence in depth).
    this.name = name;
    this.trackIds = rawTrackIds.map((id) => new TrackId(id).value);
  }

  toJSON(): { name: string; trackIds: string[] } {
    return { name: this.name, trackIds: this.trackIds };
  }
}
