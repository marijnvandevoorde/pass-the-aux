import { Crate } from "../domain/crate.ts";
import { InvalidRequestError } from "../domain/errors.ts";
import type { CrateRepository } from "../domain/ports/crate-repository.ts";

export interface CrateView {
  name: string;
  trackIds: string[];
}

/** Lists, saves and removes user crates, validating all input. */
export class ManageCrates {
  readonly #crates: CrateRepository;
  readonly #userId: string;

  constructor(crates: CrateRepository, userId = "") {
    this.#crates = crates;
    this.#userId = userId;
  }

  async list(): Promise<CrateView[]> {
    const all = await this.#crates.all(this.#userId);
    return Object.entries(all)
      .map(([name, trackIds]) => ({
        name,
        trackIds: Array.isArray(trackIds) ? trackIds : [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async save(
    rawName: unknown,
    rawTrackIds: unknown,
  ): Promise<{ name: string; count: number }> {
    const crate = new Crate(rawName, rawTrackIds);
    await this.#crates.put(this.#userId, crate.name, crate.trackIds);
    return { name: crate.name, count: crate.trackIds.length };
  }

  async remove(rawName: unknown): Promise<{ name: string }> {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (name === "") {
      throw new InvalidRequestError("crate name is required");
    }
    await this.#crates.remove(this.#userId, name);
    return { name };
  }
}
