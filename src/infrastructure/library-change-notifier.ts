type Listener = () => void;

/**
 * In-process "the library changed" signal for storage that can't be
 * watched (an object-storage bucket). The library writer calls `emit()`
 * after an import; subscribers are the background sweep and the
 * browser's `/api/events` stream — the same shape `FsLibraryWatcher`
 * offers for a folder on disk.
 */
export class LibraryChangeNotifier {
  readonly #listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(): void {
    for (const l of this.#listeners) {
      try {
        l();
      } catch {
        /* one bad listener must not starve the others */
      }
    }
  }
}
