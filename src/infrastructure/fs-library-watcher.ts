import fs from "node:fs";
import path from "node:path";

type Listener = () => void;

/**
 * Whether a raw fs.watch filename should trigger a library refresh.
 * Sidecar JSON and dotfiles are ignored so our own cache/crate writes
 * don't cause a feedback loop. Pure, so it is unit-tested directly.
 */
export function isRelevantChange(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const name = path.basename(filename.toString());
  return !name.startsWith(".pass-the-aux") && !name.startsWith(".");
}

/**
 * Watches the music directory and notifies subscribers (debounced) when
 * audio files appear/change/disappear. Sidecar JSON files are ignored so
 * our own cache/crate writes don't cause a feedback loop.
 *
 * Note: `fs.watch({ recursive: true })` is supported on macOS and Windows
 * but not on Linux — there only top-level changes are detected.
 */
export class FsLibraryWatcher {
  readonly #listeners = new Set<Listener>();
  readonly #dir: string;
  #watcher: fs.FSWatcher | null = null;
  #timer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    this.#dir = dir;
  }

  #ensureWatching(): void {
    if (this.#watcher) return;
    try {
      this.#watcher = fs.watch(
        this.#dir,
        { recursive: true },
        (_event, filename) => {
          if (isRelevantChange(filename)) this.#schedule();
        },
      );
    } catch {
      this.#watcher = null; // directory missing / unsupported — stay quiet
    }
  }

  #schedule(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      for (const l of this.#listeners) l();
    }, 400);
  }

  subscribe(listener: Listener): () => void {
    this.#ensureWatching();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#watcher) {
        this.#watcher.close();
        this.#watcher = null;
      }
    };
  }
}
