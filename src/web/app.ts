import { Deck } from "./deck.js";
import { Knob } from "./knob.js";
import { Mixer } from "./mixer.js";
import { analyzeFeatures, detectBPM } from "./bpm.js";
import { Automix } from "./automix.js";
import { fadeToNext, type SnapTo } from "./fade-to-next.js";
import { api } from "./api.js";
import { SessionHistory } from "./session-history.js";
import { pickNext, type FeatureTrack } from "./auto-select.js";
import { energyLabel } from "./energy-label.js";
import { XyPad } from "./xy-pad.js";
import { FX_ORDER, mapEffect, type FxParams } from "./xy-map.js";
import { FX_MACROS } from "./fx-macros.js";
import {
  SAMPLES,
  playSample,
  stopAllSamples,
  loadSamples,
  sampleForKey,
  getSampleBuffer,
} from "./samples.js";
import { pickOutputDevice, deviceLabel } from "./audio-devices.js";
import {
  SESSION_KEY,
  serialize,
  parse,
  resumeDecision,
  type SessionState,
  type SessionDeck,
} from "./session.js";
import { qrMatrix } from "./qr.js";
import { MixRecorder, recordingFileName, extForMime } from "./recorder.js";
import { RemoteStoresSettings } from "./remote-stores-settings.js";
import type {
  CratesResponse,
  DeckId,
  LibraryResponse,
  RemoteTrackInfo,
  TrackInfo,
} from "./types.js";

type LibTrack = LibraryResponse["tracks"][number];

function must<T extends Element>(sel: string, root: ParentNode = document): T {
  const el = root.querySelector(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el as T;
}

const statusEl = must<HTMLElement>("#status");
const amStatusEl = must<HTMLElement>("#am-status");
const setStatus = (m: string): void => {
  statusEl.textContent = m;
};
const amStatus = (m: string): void => {
  amStatusEl.textContent = m;
};
/** snap target for the manual "Fade to next" button. */
let snapTo: SnapTo = "downbeat";

function fmtTime(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
}

function esc(s: string): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
}

const deckRoot = (id: DeckId): HTMLElement =>
  must<HTMLElement>(`.deck[data-deck="${id}"]`);
const setDeckName = (id: DeckId, name: string): void => {
  must<HTMLElement>(".track-name", deckRoot(id)).textContent = name;
};
const fadeSeconds = (): number => {
  const v = parseFloat(must<HTMLInputElement>("#am-secs").value);
  return Math.max(1, Math.min(30, Number.isFinite(v) ? v : 8));
};

let ctx: AudioContext;
let mixer: Mixer;
let automix: Automix;
const decks = {} as Record<DeckId, Deck>;
/** Per-deck tempo knob — `render()` mirrors it to the deck's tempo. */
const tempoKnobs = {} as Record<DeckId, Knob>;
let tracks: LibTrack[] = [];
let focused: DeckId = "A";

/** MIME for internal library-row → deck/queue drag-and-drop. */
const DND_TRACK = "application/x-dj-track";
/** MIME for reordering items within the queue (carries the index). */
const QUEUE_DND = "application/x-dj-queue";

/** ArrayBuffers for OS-dropped files, keyed by generated UUID. */
const localBuffers = new Map<string, ArrayBuffer>();
/** Client-side tracks (OS-dropped files added to the library view). */
let localTracks: TrackInfo[] = [];

/** The deck a double-click (Automix off) should load into: the one not
 *  playing; if ambiguous, an empty deck, else the deck opposite focus. */
function nonPlayingDeck(): DeckId {
  const aP = decks.A.isPlaying;
  const bP = decks.B.isPlaying;
  if (aP && !bP) return "B";
  if (bP && !aP) return "A";
  if (!decks.A.track) return "A";
  if (!decks.B.track) return "B";
  return focused === "A" ? "B" : "A";
}
/** Tracks played/queued this session. */
const history = new SessionHistory();
/** Library table sort. */
type SortField = "title" | "mood" | "bpm";
let sortField: SortField = "title";
let sortDir = 1; // 1 asc, -1 desc

/** keep the queue fed from the library when it empties. */
let autoFill = false;
/** throttle clock for session autosave. */
let lastSessionSave = 0;
/** shared (server) session id once Automix starts. */
let sessionId: string | null = null;
/** FX panel: index into FX_ORDER for the active XY effect. */
let fxIndex = 0;
/** remote (self-hosted) library search/import state. */
let remoteEnabled = false;
let remoteSeq = 0;
let remoteAbort: AbortController | null = null;

must<HTMLButtonElement>("#start-btn").addEventListener("click", async () => {
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext: typeof AudioContext })
      .webkitAudioContext;
  ctx = new Ctor();
  await ctx.resume();

  mixer = new Mixer(ctx);
  decks.A = new Deck(ctx, "A");
  decks.B = new Deck(ctx, "B");
  mixer.connectDeck(decks.A);
  mixer.connectDeck(decks.B);

  try {
    await ctx.audioWorklet.addModule("js/keylock-processor.js");
    decks.A.enableKeylock();
    decks.B.enableKeylock();
  } catch {
    // AudioWorklet unsupported here — keylock buttons stay disabled.
  }

  automix = new Automix({
    decks,
    mixer,
    loadToDeck,
    fadeSeconds,
    autoFill: autoFillPick,
    ui: {
      status: amStatus,
      renderQueue: renderQueue,
      setToggle: setToggleUI,
      setCrossfader: (pos) => {
        must<HTMLInputElement>("#xfader").value = String(pos);
      },
      setDeckName,
    },
  });

  wireDeck("A");
  wireDeck("B");
  wireGlobal();
  fxPanel();
  setupCue();
  must<HTMLElement>("#start-overlay").remove();
  await loadLibrary();
  restoreSession();
  void loadCrates();
  void loadSamples(ctx).then(() => {
    const ab = getSampleBuffer("Air-Raid Siren");
    if (ab) {
      decks.A.setAlarmBuffer(ab);
      decks.B.setAlarmBuffer(ab);
    }
  });
  void initRemote();
  startLiveUpdates();
  requestAnimationFrame(render);
});

// server-side searched/sorted pages, infinite scroll. `tracks`
// is the accumulated loaded pages; search & sort run in SQL.
const LIB_LIMIT = 20;
let libOffset = 0;
let libTotal = 0;
let libLoading = false;

function libQuery(): { q: string; sort: string; dir: string } {
  return {
    q: must<HTMLInputElement>("#lib-search").value.trim(),
    sort: sortField === "mood" ? "energy" : sortField,
    dir: sortDir > 0 ? "asc" : "desc",
  };
}

/** Load a page. `reset` restarts at offset 0 (new search/sort); else
 *  appends the next page for infinite scroll. */
async function loadPage(reset: boolean): Promise<void> {
  if (libLoading) return;
  if (!reset && tracks.length >= libTotal && libTotal > 0) return;
  libLoading = true;
  if (reset) {
    libOffset = 0;
    tracks = [];
  }
  try {
    const data = await api.getLibrary({
      ...libQuery(),
      limit: LIB_LIMIT,
      offset: libOffset,
    });
    libTotal = data.total ?? data.count;
    libOffset += data.tracks.length;
    tracks = reset ? data.tracks : tracks.concat(data.tracks);
    renderList();
    // After a reset the list is short; if it doesn't fill its
    // scroll box yet there'd be no scroll event to trigger the next
    // page — top it up until it overflows or we've loaded all.
    if (reset) queueMicrotask(() => void fillViewport());
    setStatus("");
  } catch (e) {
    setStatus("could not load library: " + (e as Error).message);
  } finally {
    libLoading = false;
  }
}

/** Keep loading pages until the list overflows its scroll box (so a
 *  scroll event can fire) or everything is loaded. Bounded. */
async function fillViewport(): Promise<void> {
  const el = document.getElementById("track-list");
  if (!el) return;
  let guard = 0;
  while (
    guard++ < 20 &&
    !libLoading &&
    tracks.length < libTotal &&
    el.scrollHeight <= el.clientHeight + 4
  ) {
    await loadPage(false);
  }
}

async function loadLibrary(): Promise<void> {
  setStatus("loading library…");
  await loadPage(true);
}

function updateSortHeaders(): void {
  const arrow = sortDir > 0 ? " ▲" : " ▼";
  document
    .querySelectorAll<HTMLButtonElement>(".lib-headrow .th-sort")
    .forEach((b) => {
      const active = b.dataset.sort === sortField;
      const base = b.dataset.sort === "title" ? "Title" : b.dataset.sort === "bpm" ? "BPM" : "Key · Mood";
      b.textContent = active ? base + arrow : base;
      b.classList.toggle("active", active);
    });
}

/** Store an OS-dropped File in memory and return a TrackInfo for it. */
async function storeLocalFile(file: File): Promise<TrackInfo> {
  const id = crypto.randomUUID();
  const buf = await file.arrayBuffer();
  localBuffers.set(id, buf);
  return { id, name: file.name, path: null, bpm: null };
}

function renderLocalTracks(): void {
  const container = must<HTMLElement>("#local-track-list");
  container.hidden = localTracks.length === 0;
  container.innerHTML = "";
  if (localTracks.length === 0) return;
  const heading = document.createElement("div");
  heading.className = "local-tracks-heading";
  heading.textContent = "LOCAL FILES";
  container.appendChild(heading);
  for (const t of localTracks) {
    const row = document.createElement("div");
    row.className = "row local-row";
    row.innerHTML = `
      <span class="r-cover-wrap"></span>
      <span class="r-name" title="${esc(t.name)}">${esc(t.name)}</span>
      <span class="r-meta"></span>
      <span class="r-bpm missing">— BPM</span>
      <span class="r-actions">
        <button data-act="A">→ A</button>
        <button data-act="B">→ B</button>
        <button data-act="Q">+ Queue</button>
      </span>`;
    must<HTMLButtonElement>('[data-act="A"]', row).onclick = () =>
      void loadToDeck(t, "A");
    must<HTMLButtonElement>('[data-act="B"]', row).onclick = () =>
      void loadToDeck(t, "B");
    must<HTMLButtonElement>('[data-act="Q"]', row).onclick = () =>
      automix.enqueue(t);
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(DND_TRACK, JSON.stringify(t));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    });
    row.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".r-actions")) return;
      if (automix.on) {
        automix.enqueue(t);
      } else {
        void loadToDeck(t, nonPlayingDeck());
      }
    });
    container.appendChild(row);
  }
}

function renderList(): void {
  // search + sort are server-side now; `tracks` arrives already
  // sorted/filtered. The BPM ±8% mixable window stays a client filter
  // over the loaded pages.
  const bpmRaw = parseFloat(must<HTMLInputElement>("#lib-bpm").value);
  const bpmFilter = Number.isFinite(bpmRaw) && bpmRaw > 0 ? bpmRaw : null;
  const list = must<HTMLElement>("#track-list");
  list.innerHTML = "";

  const filtered =
    bpmFilter === null
      ? tracks
      : tracks.filter(
          (t) =>
            t.bpm !== null &&
            t.bpm >= bpmFilter * 0.92 &&
            t.bpm <= bpmFilter * 1.08,
        );
  updateSortHeaders();

  for (const t of filtered) {
    const named = { name: t.display, path: t.path, bpm: t.bpm };
    const keyTxt = t.camelot
      ? `${t.camelot}${t.key ? ` · ${t.key}${t.mode === "minor" ? "m" : ""}` : ""}`
      : "—";
    const en = energyLabel(t.energy);
    const tip = `${t.bpm != null ? Math.round(t.bpm) : "—"} BPM · ${keyTxt} · energy ${
      t.energy != null ? Math.round(t.energy * 100) + "%" : "—"
    }`;
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `
      <span class="r-cover-wrap"></span>
      <span class="r-name" title="${esc(t.display)}">${esc(t.display)}</span>
      <span class="r-meta" title="${esc(tip)}">
        <span class="r-key">${esc(keyTxt)}</span>
        <span class="r-energy" style="color:${en.color};border-color:${en.color}">${esc(en.label)}</span>
      </span>
      <span class="r-bpm ${t.bpm ? "" : "missing"}">${t.bpm ? Math.round(t.bpm) : "— BPM"}</span>
      <span class="r-actions">
        <button data-act="A">→ A</button>
        <button data-act="B">→ B</button>
        <button data-act="Q">+ Queue</button>
      </span>`;
    must<HTMLButtonElement>('[data-act="A"]', row).onclick = () =>
      void loadToDeck(named, "A");
    must<HTMLButtonElement>('[data-act="B"]', row).onclick = () =>
      void loadToDeck(named, "B");
    must<HTMLButtonElement>('[data-act="Q"]', row).onclick = () => {
      automix.enqueue(named);
      history.record(named.path);
    };

    // Drag a song onto a deck to load it.
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(DND_TRACK, JSON.stringify(named));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "copy";
    });
    // Double-click anywhere on the row (but not the action buttons):
    // queue it (Automix on) or load the non-playing deck.
    row.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".r-actions")) return;
      if (automix.on) {
        automix.enqueue(named);
        history.record(named.path);
        setStatus(`queued "${named.name}"`);
      } else {
        void loadToDeck(named, nonPlayingDeck());
      }
    });

    const img = document.createElement("img");
    img.className = "r-cover";
    img.loading = "lazy";
    img.alt = "";
    img.src = "/api/cover?path=" + encodeURIComponent(t.path);
    img.onerror = () => img.remove();
    must<HTMLElement>(".r-cover-wrap", row).appendChild(img);
    list.appendChild(row);
  }
}

async function loadToDeck(track: TrackInfo, deckId: DeckId): Promise<void> {
  const deck = decks[deckId];
  let buf: ArrayBuffer;
  if (track.path === null) {
    const stored = track.id ? localBuffers.get(track.id) : undefined;
    if (!stored) {
      setStatus("cannot load: local file is no longer in memory");
      return;
    }
    buf = stored;
  } else {
    history.record(track.path);
    try {
      buf = await api.getAudio(track.path);
    } catch (e) {
      setStatus(`load failed: ${(e as Error).message}`);
      return;
    }
  }
  try {
    setStatus(`loading "${track.name}" → Deck ${deckId}…`);
    await deck.loadArrayBuffer(buf, track);
    setDeckName(deckId, track.name + (track.path ? "" : " (local)"));
    if (track.path) {
      // pull the server-computed beat grid in the background.
      void api.getBeatGrid(track.path).then((g) => {
        if (!g || deck.track?.path !== track.path) return;
        deck.applyBeatGrid({
          beats: g.beats,
          downbeatPhase: g.downbeatPhase,
          firstSolidCueSec: g.firstSolidCueSec,
        });
      });
    }
    if (!track.bpm) {
      setStatus(`analyzing BPM for "${track.name}"…`);
      await analyzeDeck(deck);
    } else {
      setStatus("");
    }
  } catch (e) {
    setStatus(`load failed: ${(e as Error).message}`);
  }
}

async function analyzeDeck(deck: Deck): Promise<void> {
  if (!deck.buffer) return;
  const bpm = await detectBPM(deck.buffer);
  if (!bpm) {
    setStatus("BPM detection inconclusive");
    return;
  }
  deck.baseBPM = bpm;
  if (deck.track && deck.track.path) {
    try {
      const f = analyzeFeatures(deck.buffer);
      await api.saveAnalysis(deck.track.path, bpm, f);
      const t = tracks.find((x) => x.path === deck.track!.path);
      if (t) {
        t.bpm = bpm;
        t.key = f.key;
        t.mode = f.mode;
        t.camelot = f.camelot;
        t.energy = f.energy;
      }
      renderList();
    } catch {
      // cache write is best-effort
    }
  }
  setStatus(`detected ${bpm} BPM`);
}

// One in-flight analysis per path: the post-import row (phase 2) and
// backgroundAnalyzeMissing() can both await the same job without
// double-decoding, and whoever awaits sees the populated track.
const analyzing = new Map<string, Promise<number | null>>();

function analyzeLibraryTrack(track: LibTrack): Promise<number | null> {
  const inflight = analyzing.get(track.path);
  if (inflight) return inflight;
  const job = (async (): Promise<number | null> => {
    const buf = await api.getAudio(track.path);
    const decoded = await ctx.decodeAudioData(buf);
    const bpm = await detectBPM(decoded);
    if (!bpm) return null;
    const f = analyzeFeatures(decoded);
    await api.saveAnalysis(track.path, bpm, f);
    track.bpm = bpm;
    track.key = f.key;
    track.mode = f.mode;
    track.camelot = f.camelot;
    track.energy = f.energy;
    return bpm;
  })();
  analyzing.set(track.path, job);
  return job.finally(() => analyzing.delete(track.path));
}

let liveTimer: ReturnType<typeof setTimeout> | undefined;
let bgAnalyzing = false;

async function backgroundAnalyzeMissing(): Promise<void> {
  // Analysis is the backend's job now (ffmpeg + DSP over the WHOLE
  // per-user library, also auto-run by the folder watcher). Just
  // nudge it; the NEEDS filter makes it a no-op when nothing's
  // pending. Guarded so a burst of refreshes triggers it once.
  if (bgAnalyzing) return;
  bgAnalyzing = true;
  try {
    await api.analyzeAll();
  } catch {
    // best-effort — the watcher also drives this server-side
  } finally {
    bgAnalyzing = false;
  }
}

async function refreshLibrary(): Promise<void> {
  try {
    await loadPage(true); // re-query page 0 (current search/sort)
    void backgroundAnalyzeMissing();
  } catch {
    // transient — the next SSE event will retry
  }
}

function startLiveUpdates(): void {
  let es: EventSource;
  try {
    es = new EventSource("/api/events");
  } catch {
    return; // SSE unsupported — library still works, just not live
  }
  es.onmessage = () => {
    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => void refreshLibrary(), 300);
  };
}

function renderQueue(queue: readonly TrackInfo[], mix: Automix): void {
  const list = must<HTMLOListElement>("#queue-list");
  list.innerHTML = "";

  // Mobile: update count badge and toggle empty state / FAB visibility.
  const countEl = document.getElementById("mob-q-count");
  if (countEl) countEl.textContent = queue.length > 0 ? String(queue.length) : "";
  const emptyEl = document.getElementById("mob-q-empty");
  if (emptyEl) emptyEl.hidden = queue.length > 0;
  const fabEl = document.getElementById("mob-fab-library");
  if (fabEl) fabEl.hidden = queue.length > 0;
  queue.forEach((t, i) => {
    const li = document.createElement("li");
    li.draggable = true;
    li.innerHTML = `
      <span class="q-name" title="${esc(t.name)}">${esc(t.name)}</span>
      <span class="q-bpm ${t.bpm ? "" : "missing"}">${t.bpm ? Math.round(t.bpm) : "—"}</span>
      <span class="q-actions">
        <button data-q="rm" title="remove">✕</button>
      </span>`;
    must<HTMLButtonElement>('[data-q="rm"]', li).onclick = () =>
      mix.removeAt(i);

    // Drag a queue item to reorder it.
    li.addEventListener("dragstart", (e) => {
      e.dataTransfer?.setData(QUEUE_DND, String(i));
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      li.classList.add("dragging");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging"));
    li.addEventListener("dragover", (e) => {
      if (!e.dataTransfer?.types.includes(QUEUE_DND)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      li.classList.add("drop-into");
    });
    li.addEventListener("dragleave", () => li.classList.remove("drop-into"));
    li.addEventListener("drop", (e) => {
      const raw = e.dataTransfer?.getData(QUEUE_DND);
      li.classList.remove("drop-into");
      if (!raw) return; // not a queue-reorder drag — let it bubble
      e.preventDefault();
      e.stopPropagation();
      const from = Number(raw);
      if (Number.isInteger(from)) mix.move(from, i);
    });
    list.appendChild(li);
  });
}

function setToggleUI(on: boolean, active: DeckId | null): void {
  const b = must<HTMLButtonElement>("#am-toggle");
  if (on) {
    b.textContent = `AUTOMIX: ON${active ? " · Deck " + active : ""}`;
    b.classList.add("am-on");
    b.classList.remove("am-off");
  } else {
    b.textContent = "AUTOMIX: OFF";
    b.classList.remove("am-on");
    b.classList.add("am-off");
  }
}

type CrateView = CratesResponse["crates"][number];

async function loadCrates(): Promise<void> {
  try {
    renderCrates((await api.getCrates()).crates);
  } catch (e) {
    must<HTMLElement>("#crate-status").textContent =
      "could not load crates: " + (e as Error).message;
  }
}

function renderCrates(crates: CrateView[]): void {
  const list = must<HTMLUListElement>("#crate-list");
  must<HTMLElement>("#crate-status").textContent = crates.length
    ? `${crates.length} crate${crates.length === 1 ? "" : "s"}`
    : "no crates yet";
  list.innerHTML = "";
  for (const c of crates) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="cr-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <span class="cr-count">${c.trackIds.length} trk</span>
      <span class="cr-actions">
        <button data-cr="load">Load → queue</button>
        <button data-cr="del" title="delete crate">✕</button>
      </span>`;
    must<HTMLButtonElement>('[data-cr="load"]', li).onclick = () =>
      loadCrate(c);
    must<HTMLButtonElement>('[data-cr="del"]', li).onclick = () =>
      void deleteCrate(c.name);
    list.appendChild(li);
  }
}

function loadCrate(crate: CrateView): void {
  let added = 0;
  let missing = 0;
  for (const id of crate.trackIds) {
    const t = tracks.find((x) => x.path === id);
    if (!t) {
      missing++;
      continue;
    }
    automix.enqueue({ name: t.name, path: t.path, bpm: t.bpm });
    history.record(t.path);
    added++;
  }
  setStatus(
    `crate "${crate.name}": queued ${added}` +
      (missing ? `, ${missing} no longer in library` : ""),
  );
}

async function deleteCrate(name: string): Promise<void> {
  try {
    await api.deleteCrate(name);
    await loadCrates();
    setStatus(`crate "${name}" deleted`);
  } catch (e) {
    setStatus("delete failed: " + (e as Error).message);
  }
}

async function saveCurrentCrate(): Promise<void> {
  const input = must<HTMLInputElement>("#crate-name");
  const name = input.value.trim();
  if (!name) {
    setStatus("enter a crate name first");
    input.focus();
    return;
  }
  // Include the two on-deck tracks (A then B) ahead of the queue,
  // de-duplicated, so a saved crate captures what's actually loaded.
  const deckPaths = [decks.A.track?.path, decks.B.track?.path].filter(
    (p): p is string => !!p,
  );
  const trackIds = [
    ...deckPaths,
    ...automix.queue
      .map((t) => t.path)
      .filter((p): p is string => p !== null),
  ].filter((p, i, a) => a.indexOf(p) === i);
  if (trackIds.length === 0) {
    setStatus("nothing on the decks or in the queue to save");
    return;
  }
  try {
    await api.saveCrate(name, trackIds);
    input.value = "";
    await loadCrates();
    setStatus(`crate "${name}" saved (${trackIds.length} tracks)`);
  } catch (e) {
    setStatus("save failed: " + (e as Error).message);
  }
}

function setFocus(id: DeckId): void {
  focused = id;
  for (const d of ["A", "B"] as const) {
    deckRoot(d).classList.toggle("focused", d === id);
  }
}

function wireDeck(id: DeckId): void {
  const deck = decks[id];
  const root = deckRoot(id);
  const canvas = must<HTMLCanvasElement>(".waveform", root);

  root.addEventListener("pointerdown", () => setFocus(id));

  // Accept library-row drags and OS file drops. stopPropagation keeps
  // the window-level handler from also firing.
  root.addEventListener("dragover", (e) => {
    const dt = e.dataTransfer;
    if (!dt?.types.includes(DND_TRACK) && !dt?.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dt.dropEffect = "copy";
    root.classList.add("drop-target");
  });
  root.addEventListener("dragleave", (e) => {
    if (e.target === root) root.classList.remove("drop-target");
  });
  root.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    root.classList.remove("drop-target");
    const raw = e.dataTransfer?.getData(DND_TRACK);
    if (raw) {
      try {
        void loadToDeck(JSON.parse(raw) as TrackInfo, id);
      } catch {
        setStatus("could not load the dragged track");
      }
      return;
    }
    const file = e.dataTransfer?.files[0];
    if (file) {
      setFocus(id);
      void storeLocalFile(file).then((track) => loadToDeck(track, id));
    }
  });

  const sizeCanvas = (): void => {
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
  };
  sizeCanvas();
  new ResizeObserver(sizeCanvas).observe(canvas);

  canvas.addEventListener("click", (e: MouseEvent) => {
    if (!deck.buffer) return;
    const w = canvas.clientWidth;
    let target = (e.offsetX / w) * deck.duration;
    // Near the "first solid cue" marker: snap to the nearest kick
    // (downbeat) on the actual beat grid rather than the raw marker —
    // the analyser-derived first-solid point isn't always exactly on a
    // bar boundary, and even when it is, we want the click position to
    // pull the playhead to whichever downbeat sits closest. Lets a DJ
    // start the track on a kick with one click. Falls back to the raw
    // marker when no beat grid is available.
    if (deck.firstSolidCueSec !== null && deck.duration > 0) {
      const markerX = (deck.firstSolidCueSec / deck.duration) * w;
      if (Math.abs(e.offsetX - markerX) <= 10) {
        const beats = deck.beats;
        const beatLen = deck.beatLengthSec;
        if (beats && beats.length > 0 && beatLen !== null && beatLen > 0) {
          // Search within ±½ bar of the click — keeps the snap close
          // to where the user actually clicked, never more than 2 beats
          // away.
          const halfBar = 2 * beatLen;
          const phase = deck.downbeatPhase;
          let nearest: number | null = null;
          let nearestDist = Infinity;
          for (let i = 0; i < beats.length; i++) {
            const t = beats[i];
            if (t === undefined) continue;
            if ((i % 4) !== phase) continue;
            const d = Math.abs(t - target);
            if (d <= halfBar && d < nearestDist) {
              nearestDist = d;
              nearest = t;
            }
            if (t > target + halfBar) break;
          }
          target = nearest ?? deck.firstSolidCueSec;
        } else {
          target = deck.firstSolidCueSec;
        }
      }
    }
    deck.seek(target);
  });

  must<HTMLButtonElement>(".play", root).onclick = () => deck.togglePlay();

  must<HTMLButtonElement>(".cue", root).onclick = () => {
    if (deck.isPlaying) {
      deck.pause();
      deck.seek(deck.cuePoint);
    } else {
      deck.setCue();
      setStatus(`Deck ${id} cue set @ ${fmtTime(deck.cuePoint)}`);
    }
  };

  const pflBtn = must<HTMLButtonElement>(".pfl", root);
  pflBtn.onclick = () => {
    const on = !pflBtn.classList.contains("active");
    pflBtn.classList.toggle("active", on);
    mixer.setPFL(id, on);
    setStatus(`Deck ${id} ${on ? "→ headphones (cue)" : "cue off"}`);
  };

  must<HTMLButtonElement>(".sync", root).onclick = () => {
    const partner = decks[id === "A" ? "B" : "A"];
    const target = partner.effectiveBPM ?? partner.baseBPM;
    if (!target) {
      setStatus("other deck has no BPM yet");
      return;
    }
    if (deck.syncTo(target)) {
      tempoKnobs[id].setValue(deck.tempoPercent);
      setStatus(`Deck ${id} synced to ${target.toFixed(1)} BPM`);
    } else {
      setStatus("sync out of range");
    }
  };

  const nudge = (sel: string, mult: number): void => {
    const el = must<HTMLButtonElement>(sel, root);
    el.addEventListener("pointerdown", () => deck.bend(mult));
    el.addEventListener("pointerup", () => deck.endBend());
    el.addEventListener("pointerleave", () => deck.endBend());
  };
  nudge(".nudge-down", 0.96);
  nudge(".nudge-up", 1.04);

  const perf = must<HTMLElement>(".perf", root);

  must<HTMLButtonElement>(".loop-in", root).onclick = () => {
    deck.setLoopIn();
    setStatus(`Deck ${id} loop in @ ${fmtTime(deck.loopStartSec ?? 0)}`);
  };
  must<HTMLButtonElement>(".loop-out", root).onclick = () => {
    deck.setLoopOut();
    if (deck.loopActive) setStatus(`Deck ${id} loop active`);
  };
  perf.querySelectorAll<HTMLButtonElement>(".beatloop").forEach((btn) => {
    btn.onclick = () => {
      const beats = Number(btn.dataset.beats);
      if (deck.setBeatLoop(beats)) setStatus(`Deck ${id} ${beats}-beat loop`);
      else setStatus(`Deck ${id}: a known BPM is needed for beat loops`);
    };
  });
  must<HTMLButtonElement>(".loop-toggle", root).onclick = () =>
    deck.toggleLoop();
  must<HTMLButtonElement>(".loop-clear", root).onclick = () => {
    deck.clearLoop();
    setStatus(`Deck ${id} loop cleared`);
  };
  must<HTMLButtonElement>(".grid", root).onclick = () => {
    deck.toggleBeatgrid();
    setStatus(`Deck ${id} beatgrid ${deck.showBeatgrid ? "on" : "off"}`);
  };
  must<HTMLButtonElement>(".eject", root).onclick = () => {
    automix.eject(id);
    setStatus(`Deck ${id} ejected`);
  };
  must<HTMLButtonElement>(".keylock", root).onclick = () => {
    if (!deck.keylockAvailable) {
      setStatus(`Deck ${id}: keylock unsupported in this browser`);
      return;
    }
    deck.toggleKeylock();
    setStatus(`Deck ${id} keylock ${deck.keylock ? "on" : "off"}`);
  };

  // Pro-console redesign: tempo / EQ / volume are rotary knobs (Knob).
  // A knob is a pure UI widget — it just emits a value through onChange,
  // exactly as the old range-input `oninput` handlers did, so the deck
  // audio graph is untouched.
  tempoKnobs[id] = new Knob(must<HTMLElement>(".k-tempo", root), {
    min: -8,
    max: 8,
    default: 0,
    step: 0.5,
    detent: true,
    format: (v) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`,
    onChange: (v) => deck.setTempo(v),
  });

  const eqFormat = (v: number): string =>
    `${v > 0 ? "+" : ""}${Math.round(v)} dB`;
  for (const band of ["high", "mid", "low"] as const) {
    new Knob(must<HTMLElement>(`.k-eq-${band}`, root), {
      min: -26,
      max: 26,
      default: 0,
      step: 2,
      detent: true,
      format: eqFormat,
      onChange: (v) => deck.setEQ(band, v),
    });
  }

  new Knob(must<HTMLElement>(".k-vol", root), {
    min: 0,
    max: 1,
    default: 1,
    value: 0.85,
    step: 0.05,
    format: (v) => `${Math.round(v * 100)}%`,
    onChange: (v) => deck.setVolume(v),
  });
  deck.setVolume(0.85);
  // The per-deck FILTER/DELAY/REVERB slider rack was retired
  // (FX·7): the XY-pad FX panel is the single FX UI. Deck setters
  // remain — driven by the pad/macros instead.
}

function wireGlobal(): void {
  must<HTMLInputElement>("#master").oninput = (e) =>
    mixer.setMaster(+(e.target as HTMLInputElement).value);
  must<HTMLInputElement>("#xfader").oninput = (e) =>
    mixer.setCrossfade(+(e.target as HTMLInputElement).value);

  let searchTimer: ReturnType<typeof setTimeout>;
  const searchEl = must<HTMLInputElement>("#lib-search");
  const bpmEl = must<HTMLInputElement>("#lib-bpm");
  // typing re-queries the server (page 0); the BPM window is a
  // client filter over the loaded pages.
  searchEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadPage(true), 200);
    if (searchEl.value.trim() === "") hideRemote();
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void runRemoteSearch();
  });
  bpmEl.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(renderList, 120);
  });

  // Infinite scroll: #track-list is its OWN scroll container — page
  // when it nears the bottom (component scroll, not the window).
  const trackList = must<HTMLElement>("#track-list");
  const maybeLoadMore = (): void => {
    if (libLoading || tracks.length >= libTotal) return;
    if (
      trackList.scrollTop + trackList.clientHeight >=
      trackList.scrollHeight - 400
    ) {
      void loadPage(false);
    }
  };
  trackList.addEventListener("scroll", maybeLoadMore);

  const clearLibraryFilters = (): void => {
    if (searchEl.value === "" && bpmEl.value === "") return;
    searchEl.value = "";
    bpmEl.value = "";
    hideRemote();
    void loadPage(true);
  };

  // "← Library": leave the remote overlay but KEEP the search term, so
  // a track just downloaded from remote shows among the local matches
  // for that same query (frictionless return).
  must<HTMLButtonElement>("#remote-close").onclick = () => {
    hideRemote();
    void loadPage(true);
  };

  // FX slide-in drawer (toggled from the header; never occupies layout).
  const fxPanelEl = must<HTMLElement>("#fxpanel");
  const fxToggle = must<HTMLButtonElement>("#fx-toggle");
  const setFxOpen = (open: boolean): void => {
    fxPanelEl.classList.toggle("open", open);
    fxToggle.classList.toggle("open", open);
    fxPanelEl.setAttribute("aria-hidden", open ? "false" : "true");
  };
  fxToggle.onclick = () => setFxOpen(!fxPanelEl.classList.contains("open"));
  must<HTMLButtonElement>("#fx-close").onclick = () => setFxOpen(false);

  // Settings full page — output devices, cue levels and the mic-access
  // prompt live here (moved out of the header to keep it uncluttered).
  // setupCue() still wires the controls inside by id, wherever they sit.
  const settingsPage = must<HTMLElement>("#settings-page");
  const closeSettings = (): void => settingsPage.classList.remove("open");
  // Remote record stores live on the same page. Any change there can
  // flip `remoteEnabled`, so we re-probe /api/remote-status afterwards.
  const remoteStoresUi = new RemoteStoresSettings(() => {
    void initRemote();
  });
  must<HTMLButtonElement>("#settings-open").onclick = () => {
    settingsPage.classList.add("open");
    void remoteStoresUi.ensureLoaded();
  };
  must<HTMLButtonElement>("#settings-close").onclick = closeSettings;

  // master-mix recorder. The post-limiter tap is always live;
  // the button just toggles a MediaRecorder over it and hands the
  // result back as a downloadable file.
  const recBtn = must<HTMLButtonElement>("#rec-toggle");
  if (!MixRecorder.supported) {
    recBtn.disabled = true;
    recBtn.title = "Recording isn't supported in this browser";
  } else {
    const recorder = new MixRecorder(mixer.recordingStream());
    let recTimer: number | undefined;
    recBtn.onclick = async (): Promise<void> => {
      if (recorder.recording) {
        window.clearInterval(recTimer);
        recBtn.textContent = "● REC";
        recBtn.classList.remove("recording");
        recBtn.disabled = true; // momentary — while the Blob assembles
        const blob = await recorder.stop();
        recBtn.disabled = false;
        if (blob.size === 0) {
          setStatus("recording was empty — nothing saved");
          return;
        }
        const name = recordingFileName(extForMime(blob.type));
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
        setStatus(`mix saved → ${name}`);
      } else {
        recorder.start();
        recBtn.classList.add("recording");
        const paint = (): void => {
          recBtn.textContent = `■ ${fmtTime(recorder.elapsedSec)}`;
        };
        paint();
        recTimer = window.setInterval(paint, 500);
        setStatus("recording the master mix…");
      }
    };
  }

  // Esc: close the Settings modal, then the FX drawer, then clear the
  // library filters — whichever is currently showing.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (settingsPage.classList.contains("open")) closeSettings();
    else if (fxPanelEl.classList.contains("open")) setFxOpen(false);
    else clearLibraryFilters();
  });

  // ⌘/Ctrl+F: hijack the browser's Find and jump to the library search.
  // ⏭ (Next Track) media key: "Fade to next" — mirrors the #am-fade
  // button. Browsers normally deliver ⏭ via the Media Session API, but
  // some OS/browser combos still surface it as a key event, so cover both.
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchEl.focus();
      searchEl.select();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      must<HTMLButtonElement>("#am-fade").click();
    }
  });
  if ("mediaSession" in navigator) {
    try {
      navigator.mediaSession.setActionHandler("nexttrack", () => {
        must<HTMLButtonElement>("#am-fade").click();
      });
    } catch {
      // Browser doesn't support the "nexttrack" action — keydown still covers it.
    }
  }

  document
    .querySelectorAll<HTMLButtonElement>(".lib-headrow .th-sort")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const f = btn.dataset.sort as SortField;
        if (f === sortField) sortDir = -sortDir;
        else {
          sortField = f;
          sortDir = 1;
        }
        void loadPage(true);
      });
    });

  const allBtn = must<HTMLButtonElement>("#analyze-all");
  allBtn.onclick = async () => {
    // Backend does it: it finds EVERY row (whole per-user library, not
    // just the visible page) missing any of bpm/key/mode/camelot/
    // energy and analyses them (ffmpeg + DSP). Runs in the background.
    allBtn.disabled = true;
    try {
      await api.analyzeAll();
      setStatus(
        "analysis running on the server — tracks fill in shortly",
      );
      // Reflect progress: refetch the page a few times as rows update.
      let n = 0;
      const poll = setInterval(() => {
        void loadPage(true);
        if (++n >= 6) clearInterval(poll);
      }, 5000);
    } catch (e) {
      setStatus("could not start analysis: " + (e as Error).message);
    } finally {
      allBtn.disabled = false;
    }
  };

  // Queue panel: accept OS file drops → enqueue.
  const queueSide = must<HTMLElement>("#queue-side");
  queueSide.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    queueSide.classList.add("drop-target");
  });
  queueSide.addEventListener("dragleave", (e) => {
    if (!queueSide.contains(e.relatedTarget as Node))
      queueSide.classList.remove("drop-target");
  });
  queueSide.addEventListener("drop", (e) => {
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    e.preventDefault();
    e.stopPropagation();
    queueSide.classList.remove("drop-target");
    void storeLocalFile(file).then((track) => {
      automix.enqueue(track);
      setStatus(`queued "${file.name}" (local)`);
    });
  });

  // Library panel: accept OS file drops → add to local tracks section.
  const libPanel = must<HTMLElement>("#library");
  libPanel.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    libPanel.classList.add("drop-target");
  });
  libPanel.addEventListener("dragleave", (e) => {
    if (!libPanel.contains(e.relatedTarget as Node))
      libPanel.classList.remove("drop-target");
  });
  libPanel.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    libPanel.classList.remove("drop-target");
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith("audio/"),
    );
    if (!files.length) { setStatus("no audio files in drop"); return; }
    void Promise.all(files.map(storeLocalFile)).then((added) => {
      localTracks = [...localTracks, ...added];
      renderLocalTracks();
      setStatus(`added ${added.length} local file${added.length > 1 ? "s" : ""} to library`);
    });
  });

  // Fallback window-level drop: OS file → focused deck.
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", () =>
    document.body.classList.remove("dragging"),
  );
  window.addEventListener("drop", async (e: DragEvent) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const file = e.dataTransfer?.files[0];
    if (!file) return;
    const track = await storeLocalFile(file);
    void loadToDeck(track, focused);
  });

  // Session-id controls. Default the field, let the DJ edit it, share
  // the QR on demand (not always on screen), and re-register on change.
  const sidEl = must<HTMLInputElement>("#session-id");
  if (!sidEl.value) sidEl.value = defaultSessionId();
  const qrPanel = must<HTMLElement>("#sessionqr");

  must<HTMLButtonElement>("#am-toggle").onclick = () => {
    automix.toggle();
    if (automix.on) {
      const cur = desiredSessionId();
      const ans = window.prompt("Session id for guests to join:", cur);
      sidEl.value = cleanId(ans ?? "") || cur;
      void ensureSession(true);
    } else {
      qrPanel.hidden = true;
    }
  };

  // ── Mobile party bar ──────────────────────────────────────────
  const mobPlay = must<HTMLButtonElement>("#mob-play");
  const mobSkip = must<HTMLButtonElement>("#mob-skip");

  mobPlay.addEventListener("click", () => {
    const active = decks.A.isPlaying ? decks.A : decks.B.isPlaying ? decks.B : null;
    if (active) { active.togglePlay(); return; }
    // Nothing playing — try to start the non-empty deck.
    if (decks.A.track) decks.A.play();
    else if (decks.B.track) decks.B.play();
  });

  mobSkip.addEventListener("click", () => void automix.fadeNow());

  must<HTMLButtonElement>("#session-share").onclick = async () => {
    if (!qrPanel.hidden) {
      qrPanel.hidden = true;
      return;
    }
    await ensureSession();
    qrPanel.hidden = false;
  };

  // Mobile QR close button
  must<HTMLButtonElement>("#qr-close").addEventListener("click", () => {
    qrPanel.hidden = true;
  });

  sidEl.onchange = () => {
    sidEl.value = cleanId(sidEl.value) || defaultSessionId();
    if (sessionId || automix.on) void ensureSession(true);
    saveSession();
  };

  // Click outside the session control closes the QR popover.
  document.addEventListener("click", (e) => {
    if (
      !qrPanel.hidden &&
      !must<HTMLElement>("#session-ctl").contains(e.target as Node)
    ) {
      qrPanel.hidden = true;
    }
  });

  // the manual "Fade to next" button. Always snaps to the
  // configured beat/bar, regardless of Automix state. When Automix is
  // on, the queue still advances via handleExternalFadeDone.
  const xfaderEl = must<HTMLInputElement>("#xfader");
  const triggerFade = (): void => {
    fadeToNext({
      decks,
      mixer,
      fadeSeconds: fadeSeconds(),
      beatSync: automix.beatSync,
      snapTo,
      // Plan/sync status not surfaced — the crossfader animation is the
      // visible feedback. Errors (no second deck loaded, etc.) land in
      // the main #status line as before.
      onStatus: () => {},
      onCrossfade: (pos) => {
        xfaderEl.value = String(pos);
      },
      onDone: (info) => {
        setDeckName(info.from, "— no track —");
        if (automix.on) automix.handleExternalFadeDone(info.to);
      },
    });
  };
  must<HTMLButtonElement>("#am-fade").onclick = triggerFade;

  // Snap-target toggle (default: bar / downbeat). Pure presentational —
  // updates `snapTo` + aria-pressed; CSS does the rest.
  const snapEl = must<HTMLElement>("#xf-snap");
  const snapBtns = snapEl.querySelectorAll<HTMLButtonElement>("button[data-snap]");
  const reflectSnap = (): void => {
    snapBtns.forEach((b) => {
      const on = b.dataset.snap === snapTo;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  };
  snapBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.snap as SnapTo;
      if (next !== "beat" && next !== "downbeat") return;
      snapTo = next;
      reflectSnap();
    });
  });
  reflectSnap();

  // keyboard control of the decks + crossfader, so a set can be
  // played without the mouse. Focus picks the target deck (1/2); the
  // transport keys click the focused deck's own buttons so every side
  // effect (status line, tempo-slider sync, cue semantics) is shared
  // with the mouse path. Arrows drive the crossfader; Shift = hard cut.
  // Suppressed while a text field is focused so typing never triggers.
  const setCrossfader = (pos: number): void => {
    const clamped = Math.max(-1, Math.min(1, pos));
    xfaderEl.value = String(clamped);
    mixer.setCrossfade(clamped);
  };
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘/Ctrl combos: handled elsewhere
    const el = document.activeElement;
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      return;
    }
    const clickOnFocused = (sel: string): void => {
      must<HTMLButtonElement>(sel, deckRoot(focused)).click();
    };
    switch (e.key) {
      case "1":
        setFocus("A");
        break;
      case "2":
        setFocus("B");
        break;
      case " ": // play/pause — preventDefault stops the page scrolling
        e.preventDefault();
        if (!e.repeat) clickOnFocused(".play");
        break;
      case "c":
      case "C":
        if (!e.repeat) clickOnFocused(".cue");
        break;
      case "s":
      case "S":
        if (!e.repeat) clickOnFocused(".sync");
        break;
      case "ArrowLeft": // toward Deck A; Shift = hard cut
        e.preventDefault();
        setCrossfader(e.shiftKey ? -1 : +xfaderEl.value - 0.05);
        break;
      case "ArrowRight": // toward Deck B; Shift = hard cut
        e.preventDefault();
        setCrossfader(e.shiftKey ? 1 : +xfaderEl.value + 0.05);
        break;
      default:
        return;
    }
  });

  must<HTMLButtonElement>("#am-clear").onclick = () => automix.clear();

  must<HTMLButtonElement>("#am-clear-played").onclick = async () => {
    if (!sessionId) {
      setStatus("no live session — start Automix or Share first");
      return;
    }
    if (
      !confirm(
        "Reset played history? Guests will be able to re-request any track that's been played.",
      )
    ) {
      return;
    }
    // Wipe the browser-side history BEFORE the server call. The 3s sync
    // poll uploads history.snapshot() into the server's played set (via
    // drain(), which only ever adds), so a server-only clear is re-seeded
    // within one poll cycle. Clearing here — and persisting it — makes
    // the next poll report an empty set, so the reset actually sticks.
    history.clear();
    saveSession();
    const ok = await api.clearSessionPlayed(sessionId);
    setStatus(
      ok
        ? "played history cleared — guests can re-request any track"
        : "could not clear played history",
    );
  };

  // The Automix panel is a drop target: drag a song here to queue it.
  const amSection = must<HTMLElement>("#automix");
  amSection.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(DND_TRACK)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    amSection.classList.add("drop-target");
  });
  amSection.addEventListener("dragleave", (e) => {
    if (e.target === amSection) amSection.classList.remove("drop-target");
  });
  amSection.addEventListener("drop", (e) => {
    const raw = e.dataTransfer?.getData(DND_TRACK);
    if (!raw) return;
    e.preventDefault();
    e.stopPropagation();
    amSection.classList.remove("drop-target");
    try {
      const tr = JSON.parse(raw) as TrackInfo;
      automix.enqueue(tr);
      history.record(tr.path);
      setStatus(`queued "${tr.name}"`);
    } catch {
      setStatus("could not queue the dragged track");
    }
  });

  const afBtn = must<HTMLButtonElement>("#am-autofill");
  afBtn.onclick = () => {
    autoFill = !autoFill;
    afBtn.textContent = `AUTO-FILL: ${autoFill ? "ON" : "OFF"}`;
    afBtn.classList.toggle("am-on", autoFill);
    afBtn.classList.toggle("am-off", !autoFill);
    setStatus(`auto-fill ${autoFill ? "on" : "off"}`);
  };

  const bsBtn = must<HTMLButtonElement>("#am-beatsync");
  bsBtn.onclick = () => {
    const on = automix.toggleBeatSync();
    bsBtn.textContent = `BEATSYNC: ${on ? "ON" : "OFF"}`;
    bsBtn.classList.toggle("am-on", on);
    bsBtn.classList.toggle("am-off", !on);
    setStatus(`beat-sync ${on ? "on" : "off"}`);
  };

  must<HTMLButtonElement>("#crate-save").onclick = () =>
    void saveCurrentCrate();
  must<HTMLInputElement>("#crate-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") void saveCurrentCrate();
  });

  // Library / Crates tabs (Library is the default-visible panel).
  const tabs = document.querySelectorAll<HTMLButtonElement>(".lct-tab");
  const panels: Record<string, HTMLElement> = {
    library: must<HTMLElement>("#library"),
    crates: must<HTMLElement>("#crates"),
  };
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const sel = tab.dataset.panel ?? "library";
      tabs.forEach((t) => {
        const on = t === tab;
        t.classList.toggle("active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      for (const [name, el] of Object.entries(panels)) {
        el.hidden = name !== sel;
      }
    });
  });

  // ── Mobile Queue / Library tabs ───────────────────────────────────
  const workspace = document.getElementById("workspace");
  const setMobTab = (tab: "queue" | "library"): void => {
    if (workspace) workspace.dataset.mobTab = tab;
    document.getElementById("mob-tab-queue")
      ?.setAttribute("aria-selected", tab === "queue" ? "true" : "false");
    document.getElementById("mob-tab-library")
      ?.setAttribute("aria-selected", tab === "library" ? "true" : "false");
  };
  document.getElementById("mob-tab-queue")
    ?.addEventListener("click", () => setMobTab("queue"));
  document.getElementById("mob-tab-library")
    ?.addEventListener("click", () => setMobTab("library"));
  document.getElementById("mob-fab-library")
    ?.addEventListener("click", () => setMobTab("library"));

  // Mobile Reset / Clear proxy buttons delegate to the desktop controls.
  document.getElementById("mob-q-reset")
    ?.addEventListener("click", () =>
      must<HTMLButtonElement>("#am-clear-played").click());
  document.getElementById("mob-q-clear")
    ?.addEventListener("click", () =>
      must<HTMLButtonElement>("#am-clear").click());

  renderQueue(automix.queue, automix);
  setToggleUI(false, null);
  setFocus("A");
}

function toFeature(t: LibTrack): FeatureTrack {
  return { id: t.path, bpm: t.bpm, camelot: t.camelot, energy: t.energy };
}

/** Automix calls this when its queue is dry. Returns a
 *  compatible, not-yet-played library track (or null if auto-fill is
 *  off / nothing fits) for it to preload onto the idle deck. */
function autoFillPick(): TrackInfo | null {
  if (!autoFill) return null;
  const playing = (["A", "B"] as const)
    .map((d) => decks[d])
    .find((d) => d.isPlaying && d.track && d.track.path);
  const curLib = playing?.track?.path
    ? tracks.find((x) => x.path === playing.track!.path)
    : undefined;

  const pick = pickNext(
    curLib ? toFeature(curLib) : null,
    tracks.filter((t) => t.path).map(toFeature),
    (id) => history.has(id),
  );
  if (!pick) return null;
  const lib = tracks.find((t) => t.path === pick.id);
  if (!lib) return null;
  history.record(lib.path);
  setStatus(`auto-fill: "${lib.display}"`);
  return { name: lib.display, path: lib.path, bpm: lib.bpm };
}

// ── Remote library ─────────────────────────────────────────
const remoteSection = must<HTMLElement>("#remote-section");
const remoteListEl = must<HTMLElement>("#remote-list");
const remoteStatusEl = must<HTMLElement>("#remote-status");
const trackListEl = must<HTMLElement>("#track-list");
const remoteSourcePicker = must<HTMLElement>("#remote-source-picker");
const remoteSourceSelect = must<HTMLSelectElement>("#remote-source-select");

remoteSourceSelect.onchange = async () => {
  const id = remoteSourceSelect.value;
  if (id === "") return;
  try {
    await api.remoteStores.setActive(id);
    // Re-probe + re-run the current search so the user sees the new
    // source's results immediately.
    await initRemote();
    await runRemoteSearch();
  } catch {
    // Snap the dropdown back to truth on failure.
    void refreshSourcePicker();
  }
};

/** Re-fetches the user's remotes; shows the picker when ≥2 exist and
 *  marks the active one selected. Hidden otherwise. */
async function refreshSourcePicker(): Promise<void> {
  try {
    const { items: rows } = await api.remoteStores.list();
    if (rows.length < 2) {
      remoteSourcePicker.hidden = true;
      return;
    }
    remoteSourceSelect.innerHTML = "";
    for (const r of rows) {
      const opt = document.createElement("option");
      opt.value = r.id;
      opt.textContent = r.name;
      if (r.isActive) opt.selected = true;
      remoteSourceSelect.appendChild(opt);
    }
    remoteSourcePicker.hidden = false;
  } catch {
    remoteSourcePicker.hidden = true;
  }
}

async function initRemote(): Promise<void> {
  try {
    remoteEnabled = (await api.remoteStatus()).enabled;
  } catch {
    remoteEnabled = false;
  }
  void refreshSourcePicker();
}

// The remote results OVERLAY the library list: the remote section
// takes #track-list's exact flex slot so it reads as one list in the
// same place (DJ-remote-transparency). Dismissing (empty search /
// Esc / "← Library") restores the local list.
function hideRemote(): void {
  remoteSection.hidden = true;
  trackListEl.hidden = false;
  remoteListEl.innerHTML = "";
  remoteStatusEl.textContent = "";
}

function showRemote(msg: string): void {
  trackListEl.hidden = true;
  remoteSection.hidden = false;
  remoteStatusEl.textContent = msg;
}

function fmtDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

async function runRemoteSearch(): Promise<void> {
  const q = must<HTMLInputElement>("#lib-search").value.trim();
  if (q === "") {
    hideRemote();
    return;
  }
  if (!remoteEnabled) {
    remoteListEl.innerHTML = "";
    showRemote("no remote record store — add one in ⚙ Settings");
    return;
  }
  const seq = ++remoteSeq;
  remoteAbort?.abort();
  const ac = new AbortController();
  remoteAbort = ac;
  remoteListEl.innerHTML = "";
  showRemote(`searching “${q}”…`);
  try {
    const resp = await api.remoteSearch(q, 0, ac.signal);
    if (seq !== remoteSeq) return; // a newer search superseded this one
    if (!resp.enabled) {
      showRemote("remote library is not configured");
      return;
    }
    if (resp.items.length === 0) {
      showRemote(`no remote matches for “${q}”`);
      return;
    }
    showRemote(`${resp.items.length} of ${resp.total} for “${q}”`);
    renderRemote(resp.items);
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    if (seq !== remoteSeq) return;
    showRemote(`remote search failed: ${(e as Error).message}`);
  }
}

function renderRemote(items: RemoteTrackInfo[]): void {
  remoteListEl.innerHTML = "";
  for (const it of items) {
    const titleTxt = it.version ? `${it.title} (${it.version})` : it.title;
    const nameTxt = `${it.artist} — ${titleTxt}`;
    const metaTxt = `${it.album || "—"} · ${fmtDur(it.durationSec)}`;
    const badges =
      (it.hires ? `<span class="badge-tag badge-hr">Hi-Res</span>` : "") +
      (it.explicit ? `<span class="badge-tag badge-e">E</span>` : "");
    const row = document.createElement("div");
    row.className = "row";
    row.dataset.remoteId = it.remoteId;
    row.innerHTML = `
      <span class="r-cover-wrap"></span>
      <span class="r-name" title="${esc(nameTxt)}">${esc(nameTxt)}</span>
      <span class="r-meta" title="${esc(metaTxt)}">
        <span class="r-key">${esc(metaTxt)}</span>${badges}
      </span>
      <span class="r-bpm missing">—</span>
      <span class="r-actions">
        <button data-act="dl">Download</button>
      </span>`;
    if (it.coverUrl) {
      const img = document.createElement("img");
      img.className = "r-cover";
      img.loading = "lazy";
      img.alt = "";
      img.src = it.coverUrl;
      img.onerror = () => img.remove();
      must<HTMLElement>(".r-cover-wrap", row).appendChild(img);
    }
    const dlBtn = must<HTMLButtonElement>('[data-act="dl"]', row);
    dlBtn.onclick = () => void importRemote(row, it, dlBtn);
    remoteListEl.appendChild(row);
  }
}

async function importRemote(
  row: HTMLElement,
  it: RemoteTrackInfo,
  dlBtn: HTMLButtonElement,
): Promise<void> {
  if (row.dataset.imported === "1") return; // idempotent
  dlBtn.disabled = true;
  dlBtn.textContent = "Downloading…";
  setStatus(`importing “${it.artist} — ${it.title}”…`);
  try {
    const { path } = await api.remoteImport(
      it.remoteId,
      `${it.artist} - ${it.title}`,
    );
    await refreshLibrary();
    swapRowToLocal(row, path, it);
    setStatus(`imported “${it.artist} — ${it.title}”`);
  } catch (e) {
    dlBtn.disabled = false;
    dlBtn.textContent = "Download";
    setStatus(`import failed: ${(e as Error).message}`);
  }
}

/** Phase 1: usable actions immediately; Phase 2: BPM + key/energy
 *  once background analysis resolves — in place, idempotent. */
function swapRowToLocal(
  row: HTMLElement,
  path: string,
  it: RemoteTrackInfo,
): void {
  if (row.dataset.imported === "1") return;
  row.dataset.imported = "1";
  const t = tracks.find((x) => x.path === path);
  const named: TrackInfo = t
    ? { name: t.display, path: t.path, bpm: t.bpm }
    : { name: `${it.artist} - ${it.title}`, path, bpm: null };

  const actions = must<HTMLElement>(".r-actions", row);
  actions.innerHTML = `
    <button data-act="A">→ A</button>
    <button data-act="B">→ B</button>
    <button data-act="Q">+ Queue</button>`;
  must<HTMLButtonElement>('[data-act="A"]', row).onclick = () =>
    void loadToDeck(named, "A");
  must<HTMLButtonElement>('[data-act="B"]', row).onclick = () =>
    void loadToDeck(named, "B");
  must<HTMLButtonElement>('[data-act="Q"]', row).onclick = () => {
    automix.enqueue(named);
    history.record(named.path);
  };

  const bpmCell = must<HTMLElement>(".r-bpm", row);
  if (!t) {
    bpmCell.textContent = "— BPM";
    return;
  }
  if (t.bpm) {
    updateRemoteRowInfo(row, t);
    return;
  }
  bpmCell.textContent = "analyzing…";
  bpmCell.classList.add("missing");
  void ensureAnalyzed(t).then(() => {
    named.bpm = t.bpm; // keep an already-queued copy's BPM in sync
    updateRemoteRowInfo(row, t);
  });
}

function updateRemoteRowInfo(row: HTMLElement, t: LibTrack): void {
  const keyTxt = t.camelot
    ? `${t.camelot}${t.key ? ` · ${t.key}${t.mode === "minor" ? "m" : ""}` : ""}`
    : "—";
  const en = energyLabel(t.energy);
  must<HTMLElement>(".r-meta", row).innerHTML =
    `<span class="r-key">${esc(keyTxt)}</span>` +
    `<span class="r-energy" style="color:${en.color};border-color:${en.color}">${esc(en.label)}</span>`;
  const bpmCell = must<HTMLElement>(".r-bpm", row);
  bpmCell.textContent = t.bpm ? String(Math.round(t.bpm)) : "— BPM";
  bpmCell.classList.toggle("missing", !t.bpm);
}

async function ensureAnalyzed(t: LibTrack): Promise<void> {
  if (t.bpm != null) return;
  try {
    await analyzeLibraryTrack(t);
  } catch {
    // leave "— BPM"; SSE/background analysis may still fill it later
  }
}

/** FX panel: drive the focused deck's FX from the XY pad. */
function applyFxParams(deck: Deck, p: FxParams): void {
  if (p.filter !== undefined) deck.setFilter(p.filter);
  if (p.delayTime !== undefined) deck.setDelayTime(p.delayTime);
  if (p.delayFeedback !== undefined) deck.setDelayFeedback(p.delayFeedback);
  if (p.delayWet !== undefined) deck.setDelay(p.delayWet);
  if (p.reverbWet !== undefined) deck.setReverb(p.reverbWet);
  if (p.gateDepth !== undefined) deck.setGate(p.gateDepth, p.gateRate ?? 4);
  if (p.flangerWet !== undefined)
    deck.setFlanger(p.flangerWet, p.flangerRate ?? 0.5, p.flangerDepth ?? 0.002);
  if (p.phaserWet !== undefined)
    deck.setPhaser(p.phaserWet, p.phaserRate ?? 0.4);
  if (p.crushWet !== undefined) deck.setBitcrush(p.crushWet, p.crushBits ?? 8);
  if (p.alarmLevel !== undefined)
    deck.setAlarm(p.alarmLevel, p.alarmPitch ?? 700);
  if (p.strobeAmount !== undefined)
    deck.setStrobe(p.strobeAmount, p.strobeRate ?? 8);
}

function fxPanel(): void {
  const nameEl = must<HTMLElement>("#fx-name");
  const fxName = (): (typeof FX_ORDER)[number] => FX_ORDER[fxIndex] ?? "filter";
  const showName = (): void => {
    const n = fxName();
    nameEl.textContent = n[0]!.toUpperCase() + n.slice(1);
  };

  const apply = (x: number, y: number): void => {
    const deck = decks[focused];
    applyFxParams(deck, mapEffect(fxName(), x, y, deck.beatLengthSec));
  };

  // FX·3 — one-touch macro list (momentary).
  const listEl = must<HTMLElement>("#fx-list");
  for (const m of FX_MACROS) {
    const btn = document.createElement("button");
    btn.className = "fx-macro";
    btn.textContent = m.name;
    btn.style.touchAction = "none";
    const start = (e: PointerEvent): void => {
      btn.setPointerCapture(e.pointerId);
      btn.classList.add("active");
      const deck = decks[focused];
      applyFxParams(deck, m.build(deck.beatLengthSec ?? 0.5));
    };
    const stop = (): void => {
      btn.classList.remove("active");
      decks[focused].fxReset();
    };
    btn.addEventListener("pointerdown", start);
    btn.addEventListener("pointerup", stop);
    btn.addEventListener("pointercancel", stop);
    btn.addEventListener("pointerleave", stop);
    listEl.appendChild(btn);
  }

  // FX·4 — party soundboard pads (polyphonic, via the mixer bus).
  // AZERTY keys (a z e / q s d / w x c) shown on each pad.
  const samplesEl = must<HTMLElement>("#fx-samples");
  const padByKey = new Map<string, HTMLButtonElement>();
  for (const s of SAMPLES) {
    const btn = document.createElement("button");
    btn.className = "fx-sample";
    btn.style.background = s.color;
    btn.innerHTML = `<span class="fx-sample-key">${esc(
      s.key.toUpperCase(),
    )}</span>${esc(s.name)}`;
    const hit = (): void => {
      playSample(ctx, mixer.sampleBus(), s.name);
      btn.classList.add("hit");
      setTimeout(() => btn.classList.remove("hit"), 120);
    };
    btn.addEventListener("pointerdown", hit);
    padByKey.set(s.key, btn);
    samplesEl.appendChild(btn);
  }

  // kill all playing samples (mix keeps going).
  must<HTMLButtonElement>("#fx-stop-samples").addEventListener(
    "click",
    () => stopAllSamples(),
  );

  // Keyboard triggers — only while the Samples tab is open and the user
  // isn't typing in a field.
  window.addEventListener("keydown", (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const samplesPane = document.querySelector<HTMLElement>(
      '.fx-pane[data-pane="samples"]',
    );
    if (!samplesPane || samplesPane.hidden) return;
    const el = document.activeElement;
    if (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ) {
      return;
    }
    const name = sampleForKey(e.key);
    if (!name) return;
    e.preventDefault();
    playSample(ctx, mixer.sampleBus(), name);
    const pad = padByKey.get(e.key.toLowerCase());
    if (pad) {
      pad.classList.add("hit");
      setTimeout(() => pad.classList.remove("hit"), 120);
    }
  });

  const pad = new XyPad(
    must<HTMLElement>("#fx-pad"),
    must<HTMLElement>("#fx-dot"),
    { onMove: apply, onRelease: () => decks[focused].fxReset() },
  );

  const cycle = (d: number): void => {
    decks[focused].fxReset();
    fxIndex = (fxIndex + d + FX_ORDER.length) % FX_ORDER.length;
    showName();
  };
  must<HTMLButtonElement>("#fx-prev").onclick = () => cycle(-1);
  must<HTMLButtonElement>("#fx-next").onclick = () => cycle(1);
  must<HTMLInputElement>("#fx-latch").onchange = (e) => {
    pad.latch = (e.target as HTMLInputElement).checked;
    if (!pad.latch) decks[focused].fxReset();
  };

  document.querySelectorAll<HTMLButtonElement>(".fx-tab").forEach((b) => {
    b.addEventListener("click", () => {
      if (b.disabled) return;
      decks[focused].fxReset(); // never leave a stuck effect on switch
      document
        .querySelectorAll(".fx-tab")
        .forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      const tab = b.dataset.tab;
      document
        .querySelectorAll<HTMLElement>(".fx-pane")
        .forEach((p) => {
          p.hidden = p.dataset.pane !== tab;
        });
    });
  });
  showName();
}

/**  headphone PFL/cue on a 2nd output device.
 *  Master stays on the default sink (audience) — unchanged. */
function setupCue(): void {
  const audio = must<HTMLAudioElement>("#cue-audio");
  audio.srcObject = mixer.cueStream();
  void audio.play().catch(() => {
    /* a later user gesture will start it */
  });

  const sel = must<HTMLSelectElement>("#cue-device");
  const note = must<HTMLButtonElement>("#cue-note");
  const notePop = must<HTMLElement>("#cue-note-pop");
  const noteGrant = must<HTMLButtonElement>("#cue-note-grant");
  const noteText = must<HTMLParagraphElement>("#cue-note-pop p");

  /** Show / hide the warning icon. Empty `msg` ⇒ hide. */
  const setNote = (msg: string, allowGrant: boolean): void => {
    if (!msg) {
      note.hidden = true;
      notePop.hidden = true;
      note.setAttribute("aria-expanded", "false");
      return;
    }
    note.hidden = false;
    noteText.textContent = msg;
    noteGrant.hidden = !allowGrant;
  };
  const togglePop = (open?: boolean): void => {
    const next = open ?? notePop.hidden;
    notePop.hidden = !next;
    note.setAttribute("aria-expanded", next ? "true" : "false");
  };
  note.addEventListener("click", () => togglePop());
  note.addEventListener("mouseenter", () => togglePop(true));
  document.addEventListener("click", (e) => {
    if (notePop.hidden) return;
    const t = e.target as Node;
    if (note.contains(t) || notePop.contains(t)) return;
    togglePop(false);
  });
  const supported =
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype;

  const masterAudio = must<HTMLAudioElement>("#master-audio");
  const mSel = must<HTMLSelectElement>("#master-device");

  if (!supported) {
    sel.hidden = true;
    mSel.hidden = true;
    note.textContent = "2-device output needs Chrome/Edge";
    document.querySelectorAll<HTMLButtonElement>(".pfl").forEach((b) => {
      b.disabled = true;
      b.title = "Headphone cue needs Chrome/Edge (setSinkId)";
    });
    return; // master stays on the default sink (unchanged)
  }

  type Sinkable = HTMLAudioElement & {
    setSinkId?: (id: string) => Promise<void>;
  };
  type Out = { deviceId: string; label: string };

  /** Wire a <select> ⇄ an <audio> sink with localStorage persistence;
   *  returns a populate(outs) fn. */
  const bindSink = (
    el: HTMLAudioElement,
    selEl: HTMLSelectElement,
    storageKey: string,
  ): ((outs: Out[]) => void) => {
    const s = el as Sinkable;
    const apply = (id: string | null): void => {
      void s.setSinkId?.(id ?? "").catch(() => {
        /* device gone — falls back to default */
      });
    };
    selEl.onchange = (): void => {
      const v = selEl.value || null;
      if (v) localStorage.setItem(storageKey, v);
      else localStorage.removeItem(storageKey);
      apply(v);
    };
    return (outs: Out[]): void => {
      selEl.innerHTML = "";
      const def = document.createElement("option");
      def.value = "";
      def.textContent = "Default output";
      selEl.appendChild(def);
      outs.forEach((d, i) => {
        if (d.deviceId === "default" || d.deviceId === "") return;
        const o = document.createElement("option");
        o.value = d.deviceId;
        o.textContent = deviceLabel(d, i);
        selEl.appendChild(o);
      });
      const pick = pickOutputDevice(outs, localStorage.getItem(storageKey));
      selEl.value = pick ?? "";
      apply(pick);
    };
  };

  // Master → selectable device. Slight added latency vs
  // the direct sink — the accepted trade-off for a chosen master device.
  mixer.routeMasterToStream();
  masterAudio.srcObject = mixer.masterStream();
  void masterAudio.play().catch(() => {});

  const fillMaster = bindSink(masterAudio, mSel, "passtheaux.masterDevice");
  const fillCue = bindSink(audio, sel, "passtheaux.cueDevice");

  must<HTMLInputElement>("#cue-vol").oninput = (e) =>
    mixer.setCueVolume(+(e.target as HTMLInputElement).value);
  must<HTMLInputElement>("#cue-blend").oninput = (e) =>
    mixer.setCueBlend(+(e.target as HTMLInputElement).value);

  // browsers only expose real output devices (names + the full
  // list, not just "default") AFTER the page holds a media permission.
  // Grab a mic stream once purely to unlock enumeration, then drop it.
  // Also: navigator.mediaDevices is unavailable on insecure origins
  // (plain http over a LAN IP) — detect that and say so instead of
  // silently showing only "default".
  let mediaUnlocked = false;
  const unlockDevices = async (): Promise<void> => {
    if (mediaUnlocked || !navigator.mediaDevices?.getUserMedia) return;
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      mediaUnlocked = true;
    } catch {
      /* denied — enumerate may still give anonymised entries */
    }
  };

  const refresh = async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      sel.hidden = true;
      mSel.hidden = true;
      setNote(
        "Output device picking needs HTTPS or localhost (open the app over https:// or http://localhost).",
        false,
      );
      return;
    }
    await unlockDevices();
    let list: MediaDeviceInfo[] = [];
    try {
      list = await navigator.mediaDevices.enumerateDevices();
    } catch {
      list = [];
    }
    const outs = list
      .filter((d) => d.kind === "audiooutput")
      .map((d) => ({ deviceId: d.deviceId, label: d.label }));
    if (outs.length <= 1) {
      setNote(
        "Only the default output is visible. Browsers hide device names until they have microphone permission — granting it here lets the app list all your speakers/headphones. The mic is never recorded.",
        true,
      );
    } else {
      setNote("", false);
    }
    fillMaster(outs);
    fillCue(outs);
  };

  // Clicking "Grant microphone access" in the popover re-runs the
  // mediaDevices unlock + refresh. Force the unlock retry by clearing
  // the cached flag.
  noteGrant.addEventListener("click", () => {
    mediaUnlocked = false;
    togglePop(false);
    void refresh();
  });

  void refresh();
  try {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      void refresh();
    });
  } catch {
    /* devicechange unsupported — fine */
  }
}

/** snapshot the automix session to localStorage. */
/** A deck's restorable identity, or null when nothing's loaded. */
function deckSnapshot(d: Deck): SessionDeck | null {
  return d.track && d.track.path
    ? { path: d.track.path, offsetSec: d.currentTime, playing: d.isPlaying }
    : null;
}

function saveSession(): void {
  const playing = [decks.A, decks.B].find(
    (d) => d.isPlaying && d.track && d.track.path,
  );
  const state: SessionState = {
    id: sessionId ?? (cleanId(must<HTMLInputElement>("#session-id").value) || null),
    config: {
      automix: automix.on,
      autoFill,
      beatSync: automix.beatSync,
      fadeSeconds: fadeSeconds(),
      snapTo,
    },
    queue: automix.queue.map((t) => ({
      name: t.name,
      path: t.path,
      bpm: t.bpm,
    })),
    played: history.snapshot(),
    active:
      playing && playing.track && playing.track.path
        ? { path: playing.track.path, offsetSec: playing.currentTime }
        : null,
    decks: {
      A: deckSnapshot(decks.A),
      B: deckSnapshot(decks.B),
    },
  };
  try {
    localStorage.setItem(SESSION_KEY, serialize(state));
  } catch {
    /* storage full / disabled — non-fatal */
  }
}

/** restore config + queue + played, and resume playback. */
function restoreSession(): void {
  let s: SessionState | null = null;
  try {
    s = parse(localStorage.getItem(SESSION_KEY));
  } catch {
    s = null;
  }

  if (!s) {
    // Fresh session on a mobile viewport: default automix on so the queue
    // works immediately. Auto-fill stays off — it's confusing on mobile
    // (the DJ wants to control what plays next, not have it chosen automatically).
    // Desktop keeps automix off by default so manually-loaded deck tracks work.
    if (window.matchMedia("(max-width: 640px)").matches) {
      automix.restoreOn(true);
      void ensureSession();
    }
    return;
  }

  // Pre-fill the DJ's chosen session id so it survives a refresh
  // (re-registered with the server on next Share / Automix).
  if (s.id) must<HTMLInputElement>("#session-id").value = s.id;

  autoFill = s.config.autoFill;
  automix.beatSync = s.config.beatSync;
  const af = must<HTMLButtonElement>("#am-autofill");
  af.textContent = `AUTO-FILL: ${autoFill ? "ON" : "OFF"}`;
  af.classList.toggle("am-on", autoFill);
  af.classList.toggle("am-off", !autoFill);
  const bs = must<HTMLButtonElement>("#am-beatsync");
  bs.textContent = `BEATSYNC: ${automix.beatSync ? "ON" : "OFF"}`;
  bs.classList.toggle("am-on", automix.beatSync);
  bs.classList.toggle("am-off", !automix.beatSync);
  must<HTMLInputElement>("#am-secs").value = String(s.config.fadeSeconds);

  // restore the snap-to selection on the crossfader.
  snapTo = s.config.snapTo === "beat" ? "beat" : "downbeat";
  must<HTMLElement>("#xf-snap")
    .querySelectorAll<HTMLButtonElement>("button[data-snap]")
    .forEach((b) => b.classList.toggle("on", b.dataset.snap === snapTo));

  // Suspend auto-arm: re-enqueuing the saved queue must NOT pull its
  // head onto the decks before the saved decks are rehydrated.
  automix.setSuspended(true);
  for (const t of s.queue) {
    automix.enqueue({ name: t.name, path: t.path, bpm: t.bpm });
    history.record(t.path);
  }
  for (const id of s.played) history.record(id);

  // Restore the Automix toggle exactly as it was (ON stays ON) — no
  // arming, no playback. If it was on, re-register the SAME session
  // id (idempotent) so the crowd/QR keeps working after a refresh.
  automix.restoreOn(s.config.automix);
  if (s.config.automix) void ensureSession();

  const libPaths = new Set(
    tracks.map((t) => t.path).filter((p): p is string => !!p),
  );
  const byPath = (p: string): LibTrack | undefined =>
    tracks.find((t) => t.path === p);

  // Both decks are restored exactly as they were (track + position +
  // play-state), so a refresh no longer drops a deck or shifts the
  // queue. Falls back to the legacy single-track resume only for
  // sessions saved before decks were persisted.
  // Re-enable auto-arm only AFTER the decks are rehydrated, so the
  // saved queue & decks survive the refresh intact.
  const resume = (): void => automix.setSuspended(false);

  if (s.decks && (s.decks.A || s.decks.B)) {
    const restoreDeck = async (
      snap: SessionDeck | null,
      id: DeckId,
    ): Promise<void> => {
      if (!snap || !snap.path || !libPaths.has(snap.path)) return;
      const lib = byPath(snap.path);
      if (!lib) return;
      await loadToDeck(
        { name: lib.display, path: lib.path, bpm: lib.bpm },
        id,
      );
      if (snap.offsetSec > 0) decks[id].seek(snap.offsetSec);
      if (snap.playing) decks[id].play();
    };
    void Promise.all([
      restoreDeck(s.decks.A, "A"),
      restoreDeck(s.decks.B, "B"),
    ]).finally(resume);
    setStatus("session restored — decks & queue recovered");
    return;
  }

  const r = resumeDecision(s, libPaths);

  if (r.kind === "resume") {
    const lib = byPath(r.path);
    if (lib) {
      void (async () => {
        await loadToDeck({ name: lib.display, path: lib.path, bpm: lib.bpm }, "A");
        decks.A.seek(r.offsetSec);
        decks.A.play();
        setStatus(`session restored — resumed "${lib.display}"`);
      })().finally(resume);
    } else {
      resume();
    }
  } else if (r.kind === "next") {
    const first = s.queue.find((t) => t.path && libPaths.has(t.path));
    const lib = first && first.path ? byPath(first.path) : undefined;
    if (lib) {
      void (async () => {
        await loadToDeck({ name: lib.display, path: lib.path, bpm: lib.bpm }, "A");
        decks.A.play();
        setStatus(`session restored — playing "${lib.display}"`);
      })().finally(resume);
    } else {
      resume();
    }
  } else {
    resume(); // nothing to restore onto a deck
  }
}

/** Mirror the server-side sanitiser so the field shows what'll be used. */
function cleanId(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function defaultSessionId(): string {
  return "dj-" + Math.random().toString(36).slice(2, 7);
}

/** The DJ's chosen id, falling back to a fresh default. */
function desiredSessionId(): string {
  return cleanId(must<HTMLInputElement>("#session-id").value) ||
    defaultSessionId();
}

/** draw the crowd-join QR + link. Does NOT change visibility —
 *  the QR is a popover, shown only via the Share button. */
function renderQr(url: string): void {
  const a = must<HTMLAnchorElement>("#qr-url");
  a.href = url;
  a.textContent = url;
  const canvas = must<HTMLCanvasElement>("#qr-canvas");
  const g = canvas.getContext("2d");
  if (!g) return;
  try {
    const m = qrMatrix(url);
    const n = m.length;
    // A QR needs a light "quiet zone" margin (≥4 modules) to be
    // scannable — without it the finder patterns touch the canvas edge
    // (and the canvas border-radius) and most readers fail.
    const quiet = 4;
    const total = n + quiet * 2;
    const scale = Math.max(2, Math.floor(180 / total));
    canvas.width = total * scale;
    canvas.height = total * scale;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#000";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (m[r]![c]) {
          g.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
    canvas.hidden = false;
  } catch {
    canvas.hidden = true; // URL too long for v1–4 — the link still works
  }
}

/** Register (or switch to) the shared session for the chosen id.
 *  `force` re-registers even if a session is already live (the DJ
 *  changed the id). Reflects the server-sanitised id back into the
 *  field and refreshes the QR so it always tracks the current id. */
async function ensureSession(force = false): Promise<void> {
  const wanted = desiredSessionId();
  if (sessionId === wanted && !force) return;
  try {
    const { id, url } = await api.createSession(
      {
        automix: automix.on,
        autoFill,
        beatSync: automix.beatSync,
        fadeSeconds: fadeSeconds(),
      },
      wanted,
    );
    sessionId = id;
    must<HTMLInputElement>("#session-id").value = id;
    must<HTMLButtonElement>("#session-share").classList.add("live");
    renderQr(url);
    saveSession();
  } catch {
    /* session unavailable — automix still works locally */
  }
}

function render(): void {
  must<HTMLElement>("#fx-target").textContent = `Deck ${focused}`;
  for (const id of ["A", "B"] as const) {
    const deck = decks[id];
    const root = deckRoot(id);
    drawWave(deck, must<HTMLCanvasElement>(".waveform", root), id);

    must<HTMLElement>(".time", root).textContent =
      `${fmtTime(deck.currentTime)} / ${fmtTime(deck.duration)}`;

    // Hero BPM readout: the big number is the effective (tempo-adjusted)
    // BPM; the label notes the original when tempo shifts it.
    const eff = deck.effectiveBPM;
    const bpmNum = must<HTMLElement>(".bpm-num", root);
    const bpmLbl = must<HTMLElement>(".bpm-lbl", root);
    if (deck.baseBPM && eff) {
      bpmNum.textContent = eff.toFixed(1);
      bpmLbl.textContent =
        Math.round(eff) !== Math.round(deck.baseBPM)
          ? `BPM · ${Math.round(deck.baseBPM)} orig`
          : "BPM";
    } else {
      bpmNum.textContent = "—";
      bpmLbl.textContent = "BPM";
    }

    // Beat indicator: pulse it in time with the grid while playing.
    const beatDot = must<HTMLElement>(".beat", root);
    const beatLen = deck.beatLengthSec;
    if (deck.isPlaying && beatLen && beatLen > 0.05) {
      const phase =
        ((((deck.currentTime - deck.cuePoint) / beatLen) % 1) + 1) % 1;
      beatDot.style.opacity = (0.2 + 0.8 * (1 - phase)).toFixed(2);
    } else {
      beatDot.style.opacity = "0.2";
    }

    const play = must<HTMLButtonElement>(".play", root);
    play.classList.toggle("active", deck.isPlaying);
    play.textContent = deck.isPlaying ? "❚❚ PAUSE" : "▶ PLAY";

    must<HTMLButtonElement>(".loop-toggle", root).classList.toggle(
      "active",
      deck.loopActive,
    );
    must<HTMLButtonElement>(".grid", root).classList.toggle(
      "active",
      deck.showBeatgrid,
    );
    const kb = must<HTMLButtonElement>(".keylock", root);
    kb.classList.toggle("active", deck.keylock);
    kb.disabled = !deck.keylockAvailable;

    // Mirror the tempo knob to the deck's actual tempo (SYNC, Automix
    // beat-sync, …) — but never while the user is turning it. The knob's
    // own detent shows when it's off-default.
    const tempoKnob = tempoKnobs[id];
    if (!tempoKnob.dragging) {
      tempoKnob.setValue(Math.max(-8, Math.min(8, deck.tempoPercent)));
    }

    must<HTMLElement>(".meter i", root).style.width =
      `${Math.round(deck.getLevel() * 100)}%`;
  }
  must<HTMLElement>("#master-meter i").style.width =
    `${Math.round(mixer.masterLevel() * 100)}%`;

  automix.tick();

  // ── Mobile bar update ──────────────────────────────────────────
  {
    const playing = decks.A.isPlaying ? decks.A : decks.B.isPlaying ? decks.B : null;
    const trackForBar = playing?.track ?? decks.A.track ?? decks.B.track ?? null;
    must<HTMLElement>("#mob-track").textContent = trackForBar?.name ?? "— no track —";
    must<HTMLElement>("#mob-bpm").textContent = trackForBar?.bpm ? `${Math.round(trackForBar.bpm)} BPM` : "";
    must<HTMLButtonElement>("#mob-play").textContent = playing ? "❚❚" : "▶";
    must<HTMLElement>("#mob-dot").classList.toggle("paused", !playing);
  }

  const tnow = performance.now();
  if (tnow - lastSessionSave > 3000) {
    lastSessionSave = tnow;
    saveSession(); // persist config/queue/played/offset
    if (sessionId && automix.on) {
      // report what we've played, pull crowd adds, append them
      // live to the automix queue. Also push the currently-playing
      // track so the crowd page can show "Now Playing".
      const sid = sessionId;
      const playingDeck = decks.A.isPlaying ? decks.A : decks.B.isPlaying ? decks.B : null;
      const nowPlaying = playingDeck?.track
        ? { name: playingDeck.track.name, artist: null, bpm: playingDeck.track.bpm, path: playingDeck.track.path }
        : null;
      void api.syncSession(sid, history.snapshot(), nowPlaying).then((pending) => {
        for (const t of pending) {
          if (history.has(t.path)) continue;
          automix.enqueue({ name: t.name, path: t.path, bpm: t.bpm });
          history.record(t.path);
        }
        if (pending.length > 0) renderQueue(automix.queue, automix);
      });
    }
  }

  requestAnimationFrame(render);
}

function drawWave(deck: Deck, canvas: HTMLCanvasElement, id: DeckId): void {
  const g = canvas.getContext("2d");
  if (!g) return;
  const w = canvas.width;
  const h = canvas.height;
  g.clearRect(0, 0, w, h);
  if (!deck.peaks) return;

  const accent = id === "A" ? "#38e0c4" : "#ff8a3d";
  const played = deck.duration ? deck.currentTime / deck.duration : 0;
  const mid = h / 2;
  const n = deck.peaks.length;

  for (let x = 0; x < w; x++) {
    const peak = deck.peaks[Math.floor((x / w) * n)] ?? 0;
    const bar = peak * (h * 0.92);
    g.fillStyle = x / w <= played ? accent : "#39405a";
    g.fillRect(x, mid - bar / 2, 1, bar);
  }

  if (deck.showBeatgrid && deck.duration) {
    const beat = deck.beatLengthSec;
    if (beat !== null && beat > 0.05) {
      const phase = deck.cuePoint; // beat 0 sits on the cue point
      const first = Math.ceil((0 - phase) / beat);
      const last = Math.floor((deck.duration - phase) / beat);
      for (let nb = first; nb <= last; nb++) {
        const gx = ((phase + nb * beat) / deck.duration) * w;
        const downbeat = ((nb % 4) + 4) % 4 === 0;
        g.fillStyle = downbeat
          ? "rgba(255,255,255,0.34)"
          : "rgba(255,255,255,0.12)";
        g.fillRect(gx, downbeat ? 0 : h * 0.18, 1, downbeat ? h : h * 0.64);
      }
    }
  }

  if (deck.duration && deck.loopStartSec !== null && deck.loopEndSec !== null) {
    const x0 = (deck.loopStartSec / deck.duration) * w;
    const x1 = (deck.loopEndSec / deck.duration) * w;
    g.fillStyle = deck.loopActive
      ? "rgba(56,224,196,0.16)"
      : "rgba(139,147,167,0.12)";
    g.fillRect(x0, 0, Math.max(1, x1 - x0), h);
    g.fillStyle = deck.loopActive ? accent : "#8b93a7";
    g.fillRect(x0, 0, 1, h);
    g.fillRect(x1 - 1, 0, 1, h);
  }

  if (deck.duration) {
    if (deck.firstSolidCueSec !== null) {
      const sx = (deck.firstSolidCueSec / deck.duration) * w;
      g.fillStyle = "rgba(139,233,255,0.85)"; // cyan: analyser's "first solid" hit
      g.fillRect(sx - 1, h * 0.08, 2, h * 0.84);
      g.fillRect(sx - 4, h * 0.08, 9, 2);
      g.fillRect(sx - 4, h * 0.92 - 2, 9, 2);
    }
    const cx = (deck.cuePoint / deck.duration) * w;
    g.fillStyle = "#ffd34d";
    g.fillRect(cx - 1, 0, 2, h);
  }
  g.fillStyle = "#ffffff";
  g.fillRect(played * w - 1, 0, 2, h);
}
