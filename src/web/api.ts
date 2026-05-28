import type {
  BeatGridResponse,
  CratesResponse,
  LibraryResponse,
  RemoteImportResponse,
  RemoteSearchResponse,
  RemoteStatusResponse,
  RemoteStoreInput,
  RemoteStorePublic,
} from "./types.js";

/** Thin client for the server API. */
export const api = {
  audioUrl(path: string): string {
    return "/api/audio?path=" + encodeURIComponent(path);
  },

  /** server-side searched/sorted/paginated library. `session`
   *  scopes to a DJ's library for the crowd page. */
  async getLibrary(
    opts: {
      q?: string;
      sort?: string;
      dir?: string;
      limit?: number;
      offset?: number;
      session?: string;
    } = {},
  ): Promise<LibraryResponse> {
    const p = new URLSearchParams();
    if (opts.q) p.set("q", opts.q);
    if (opts.sort) p.set("sort", opts.sort);
    if (opts.dir) p.set("dir", opts.dir);
    if (opts.limit != null) p.set("limit", String(opts.limit));
    if (opts.offset != null) p.set("offset", String(opts.offset));
    if (opts.session) p.set("s", opts.session);
    const qs = p.toString();
    const res = await fetch("/api/library" + (qs ? `?${qs}` : ""));
    if (!res.ok) throw new Error(`library request failed (${res.status})`);
    return (await res.json()) as LibraryResponse;
  },

  async getAudio(path: string): Promise<ArrayBuffer> {
    const res = await fetch(this.audioUrl(path));
    if (!res.ok) throw new Error(`audio request failed (${res.status})`);
    return res.arrayBuffer();
  },

  /** per-track beat grid. Returns null when no grid exists
   *  yet (background analysis hasn't reached this track), 404, or
   *  on any error — callers fall back to BPM-only math. */
  async getBeatGrid(path: string): Promise<BeatGridResponse | null> {
    try {
      const res = await fetch(
        "/api/beat-grid?path=" + encodeURIComponent(path),
      );
      if (res.status === 404) return null;
      if (!res.ok) return null;
      return (await res.json()) as BeatGridResponse;
    } catch {
      return null;
    }
  },

  async saveAnalysis(
    path: string,
    bpm: number,
    features?: {
      key: string | null;
      mode: string | null;
      camelot: string | null;
      energy: number | null;
    },
  ): Promise<void> {
    await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, bpm, ...features }),
    });
  },

  /** Kick off backend bulk analysis of every track missing any
   *  bpm/key/mode/camelot/energy (whole per-user library). */
  async analyzeAll(): Promise<void> {
    const res = await fetch("/api/analyze-all", { method: "POST" });
    if (!res.ok) throw new Error(`analyze-all failed (${res.status})`);
  },

  async getCrates(): Promise<CratesResponse> {
    const res = await fetch("/api/crates");
    if (!res.ok) throw new Error(`crates request failed (${res.status})`);
    return (await res.json()) as CratesResponse;
  },

  async saveCrate(name: string, trackIds: string[]): Promise<void> {
    const res = await fetch("/api/crates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, trackIds }),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error ?? `save failed (${res.status})`);
    }
  },

  async deleteCrate(name: string): Promise<void> {
    await fetch("/api/crates/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
  },

  async remoteStatus(): Promise<RemoteStatusResponse> {
    try {
      const res = await fetch("/api/remote-status");
      if (!res.ok) return { enabled: false };
      return (await res.json()) as RemoteStatusResponse;
    } catch {
      return { enabled: false };
    }
  },

  async remoteSearch(
    q: string,
    offset = 0,
    signal?: AbortSignal,
    session?: string,
  ): Promise<RemoteSearchResponse> {
    const res = await fetch(
      `/api/remote-search?q=${encodeURIComponent(q)}&offset=${offset}` +
        (session ? `&s=${encodeURIComponent(session)}` : ""),
      { signal },
    );
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error ?? `remote search failed (${res.status})`);
    }
    return (await res.json()) as RemoteSearchResponse;
  },

  /** CRUD for the user's remote record stores (Settings → Remote
   *  record stores). The server hides `apiKey` from list responses. */
  remoteStores: {
    async list(): Promise<RemoteStorePublic[]> {
      const res = await fetch("/api/remote/sources");
      if (!res.ok) throw new Error(`list failed (${res.status})`);
      const body = (await res.json()) as { items: RemoteStorePublic[] };
      return body.items;
    },
    async add(input: RemoteStoreInput): Promise<RemoteStorePublic> {
      const res = await fetch("/api/remote/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `add failed (${res.status})`);
      }
      return (await res.json()) as RemoteStorePublic;
    },
    async update(
      id: string,
      patch: Partial<RemoteStoreInput>,
    ): Promise<RemoteStorePublic> {
      const res = await fetch(
        "/api/remote/sources?id=" + encodeURIComponent(id),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `update failed (${res.status})`);
      }
      return (await res.json()) as RemoteStorePublic;
    },
    async remove(id: string): Promise<void> {
      const res = await fetch(
        "/api/remote/sources?id=" + encodeURIComponent(id),
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`delete failed (${res.status})`);
    },
    async setActive(id: string): Promise<void> {
      const res = await fetch("/api/remote/active", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error(`set active failed (${res.status})`);
    },
  },

  async remoteImport(
    remoteId: string,
    name: string,
  ): Promise<RemoteImportResponse> {
    const res = await fetch("/api/remote-import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteId, name }),
    });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error ?? `import failed (${res.status})`);
    }
    return (await res.json()) as RemoteImportResponse;
  },

  async createSession(
    config: {
      automix: boolean;
      autoFill: boolean;
      beatSync: boolean;
      fadeSeconds: number;
    },
    id?: string,
  ): Promise<{ id: string; url: string }> {
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config, id }),
    });
    if (!res.ok) throw new Error(`session create failed (${res.status})`);
    return (await res.json()) as { id: string; url: string };
  },

  /** DJ poll: report what we've played, receive crowd adds since the
   *  last poll. Best-effort — returns [] on any failure. */
  async syncSession(
    id: string,
    played: string[],
  ): Promise<SessionQueueItem[]> {
    try {
      const res = await fetch("/api/session/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, played }),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { pending?: SessionQueueItem[] };
      return Array.isArray(body.pending) ? body.pending : [];
    } catch {
      return [];
    }
  },

  /** Reset the played-tracks dedup set on a running session. Returns
   *  true on success; false when the session doesn't exist or the
   *  caller isn't the owning DJ. */
  async clearSessionPlayed(id: string): Promise<boolean> {
    try {
      const res = await fetch("/api/session/clear-played", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      return res.ok;
    } catch {
      return false;
    }
  },

  async getSession(id: string): Promise<SessionSnapshot | null> {
    try {
      const res = await fetch(
        "/api/session?id=" + encodeURIComponent(id),
      );
      if (!res.ok) return null;
      return (await res.json()) as SessionSnapshot;
    } catch {
      return null;
    }
  },

  /** Crowd add. Resolves to a status the page can show. */
  async queueToSession(body: {
    id: string;
    name: string;
    path?: string;
    bpm?: number | null;
    remoteId?: string;
  }): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
    try {
      const res = await fetch("/api/session/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) return { ok: true };
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      return {
        ok: false,
        status: res.status,
        error: e.error ?? `failed (${res.status})`,
      };
    } catch {
      return { ok: false, status: 0, error: "network error" };
    }
  },
};

export interface SessionQueueItem {
  name: string;
  path: string;
  bpm: number | null;
}

export interface SessionSnapshot {
  id: string;
  config: {
    automix: boolean;
    autoFill: boolean;
    beatSync: boolean;
    fadeSeconds: number;
  };
  pending: SessionQueueItem[];
  played: string[];
}
