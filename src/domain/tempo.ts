import { InvalidTempoError } from "./errors.ts";

/**
 * Value object for a beats-per-minute tempo. Validates a sane range and
 * normalises to one decimal place (the precision the UI works in).
 */
export class Tempo {
  readonly bpm: number;

  constructor(value: unknown) {
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0 || n > 400) {
      throw new InvalidTempoError(value);
    }
    this.bpm = Math.round(n * 10) / 10;
  }

  toJSON(): number {
    return this.bpm;
  }
}
