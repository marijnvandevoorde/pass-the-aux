/** Keeps a sidecar running while it is needed. `acquire` resolves once
 *  it is ready to take requests (or throws); every `acquire` is paired
 *  with one `release`. `lost` reports that the sidecar went away
 *  mid-use, so the next `acquire` waits for it again. */
export interface WorkerLease {
  acquire(): Promise<void>;
  release(): void;
  lost(): void;
}

/** For a sidecar that simply runs all the time (docker compose). */
export const ALWAYS_UP: WorkerLease = {
  acquire: async () => {},
  release: () => {},
  lost: () => {},
};
