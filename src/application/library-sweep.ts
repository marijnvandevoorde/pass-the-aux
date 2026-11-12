/** Background library sweep: runs the per-user library work (enrich,
 *  analyse, grid) for every account, on boot, on library changes and on
 *  a slow timer.
 *
 *  `run()` never rejects. It is fired from timers, where a rejection is
 *  unhandled and kills the process: a database outage (MySQL maintenance,
 *  ECONNREFUSED) once crash-looped the pod that way. A failure is logged
 *  and the next call retries. */
export interface LibrarySweepDeps {
  /** Account ids to sweep; empty means a legacy flat library (uid ""). */
  userIds(): Promise<string[]>;
  sweepUser(uid: string): Promise<void>;
  log?: (message: string) => void;
}

export class LibrarySweep {
  readonly #deps: LibrarySweepDeps;
  #sweeping = false;
  #pending = false;

  constructor(deps: LibrarySweepDeps) {
    this.#deps = deps;
  }

  async run(): Promise<void> {
    // Coalesce instead of drop: a change arriving mid-sweep must not
    // be lost. Sweeps are long (enrich + ffmpeg per user), so a plain
    // `if (sweeping) return` silently discarded files dropped in while
    // a pass was running.
    if (this.#sweeping) {
      this.#pending = true;
      return;
    }
    this.#sweeping = true;
    try {
      do {
        this.#pending = false;
        let real: string[];
        try {
          real = await this.#deps.userIds();
        } catch (err) {
          // Storage is down: give up this pass, the next one retries.
          this.#log(`library sweep: could not list users: ${message(err)}`);
          return;
        }
        // CRITICAL: sweep ONLY real user ids; "" only when there are no
        // accounts at all (see main.ts).
        const ids = real.length > 0 ? real : [""];
        for (const uid of ids) {
          try {
            await this.#deps.sweepUser(uid);
          } catch {
            /* per-user best-effort — next sweep retries */
          }
        }
      } while (this.#pending); // a change landed during the pass — re-run
    } catch (err) {
      this.#log(`library sweep failed: ${message(err)}`);
    } finally {
      this.#sweeping = false;
    }
  }

  #log(m: string): void {
    (this.#deps.log ?? console.error)(m);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
