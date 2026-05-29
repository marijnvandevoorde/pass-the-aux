// the guest-facing crowd page. A deliberately tiny single-
// purpose UI: the DJ's library is shown on load and filtered live as
// you type; pressing Enter additionally searches the remote source.
// The only action is "Queue" — local tracks queue straight away,
// remote tracks download into the library first. Adds are pushed live
// into the DJ's automix session server-side.
import { api } from "./api.js";
import type { LibraryResponse, RemoteTrackInfo } from "./types.js";
import type { NowPlaying } from "./api.js";

type LibTrack = LibraryResponse["tracks"][number];

const sessionId = new URLSearchParams(location.search).get("s") ?? "";
const LOCAL_CAP = 250;

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

const statusEl = $<HTMLParagraphElement>("#status");
const searchEl = $<HTMLInputElement>("#q");
const localBox = $<HTMLDivElement>("#local");
const remoteBox = $<HTMLDivElement>("#remote");
const toastEl = $<HTMLDivElement>("#toast");
const modalEl = $<HTMLDivElement>("#modal");
const modalBody = $<HTMLParagraphElement>("#m-body");

// Now Playing pill + sheet
const npPill = $<HTMLDivElement>("#now-playing-pill");
const npName = $<HTMLSpanElement>("#np-name");
const npSheet = $<HTMLDivElement>("#np-sheet");
const npCover = $<HTMLImageElement>("#np-cover");
const npCoverEmoji = $<HTMLSpanElement>("#np-cover-emoji");
const npSheetName = $<HTMLParagraphElement>("#np-sheet-name");
const npSheetMeta = $<HTMLParagraphElement>("#np-sheet-meta");

const STALE_MS = 30_000;

function openNpSheet(): void { npSheet.classList.add("open"); }
function closeNpSheet(): void { npSheet.classList.remove("open"); }

npPill.addEventListener("click", openNpSheet);
npPill.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") openNpSheet(); });
// Tap the 48px backdrop strip above the card to close.
npSheet.addEventListener("click", (e) => { if (e.target === npSheet) closeNpSheet(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeNpSheet(); });

// Swipe-down on the handle to close.
const npHandle = $<HTMLDivElement>("#np-handle");
let swipeStartY = 0;
npHandle.addEventListener("touchstart", (e) => { swipeStartY = e.touches[0]!.clientY; }, { passive: true });
npHandle.addEventListener("touchend", (e) => { if (e.changedTouches[0]!.clientY - swipeStartY > 60) closeNpSheet(); }, { passive: true });

function updateNowPlaying(np: NowPlaying | null, at: number | null): void {
  if (!np) {
    npPill.classList.remove("visible");
    return;
  }
  const stale = at !== null && Date.now() - at > STALE_MS;
  npPill.classList.add("visible");
  npPill.classList.toggle("stale", stale);
  npName.textContent = np.name;

  // Sheet
  npSheetName.textContent = np.name;
  const bpmTxt = np.bpm ? `${Math.round(np.bpm)} BPM` : null;
  npSheetMeta.textContent = [np.artist, bpmTxt].filter(Boolean).join(" · ") || "—";

  // Cover art
  if (np.path) {
    const src = "/api/cover?path=" + encodeURIComponent(np.path);
    if (npCover.dataset.src !== src) {
      npCover.dataset.src = src;
      npCover.classList.remove("loaded");
      npCoverEmoji.hidden = false;
      npCover.onload = () => { npCover.classList.add("loaded"); npCoverEmoji.hidden = true; };
      npCover.onerror = () => { npCover.classList.remove("loaded"); npCoverEmoji.hidden = false; };
      npCover.src = src;
    }
  } else {
    npCover.classList.remove("loaded");
    npCoverEmoji.hidden = false;
  }
}

const REPLAY_MSG =
  "This track already played this session — the DJ keeps each track to once per set. Pick another and keep the party moving! 🎉";

function showModal(body: string): void {
  modalBody.textContent = body;
  modalEl.classList.add("show");
}
function hideModal(): void {
  modalEl.classList.remove("show");
}
$<HTMLButtonElement>("#m-ok").addEventListener("click", hideModal);
modalEl.addEventListener("click", (e) => {
  if (e.target === modalEl) hideModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideModal();
});

let library: LibTrack[] = [];
let remoteEnabled = false;
let played = new Set<string>();
/** Tracks the guest has just queued, so the button stays disabled
 *  even before the server-side played set comes back round. */
const requested = new Set<string>();
let lastActionAt = 0;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
let remoteAbort: AbortController | undefined;

function toast(msg: string, kind: "ok" | "warn" = "ok"): void {
  toastEl.textContent = msg;
  toastEl.dataset.kind = kind;
  toastEl.classList.add("show");
  window.setTimeout(() => toastEl.classList.remove("show"), 2600);
}

async function loadSession(): Promise<{ ok: boolean; snap: (typeof api.getSession extends (...a: any[]) => Promise<infer R> ? R : never) }> {
  const snap = await api.getSession(sessionId);
  if (!snap) {
    statusEl.textContent =
      "This request session is closed. Ask the DJ for a fresh code. 🎧";
    statusEl.dataset.kind = "warn";
    searchEl.disabled = true;
    return { ok: false, snap: null };
  }
  played = new Set(snap.played);
  statusEl.textContent = "Connected — pick a track to queue 🎉";
  statusEl.dataset.kind = "ok";
  return { ok: true, snap };
}

function isUsed(path: string): boolean {
  return played.has(path) || requested.has(path);
}

function empty(box: HTMLElement, text: string): void {
  box.innerHTML = "";
  const e = document.createElement("p");
  e.className = "empty";
  e.textContent = text;
  box.append(e);
}

function row(
  title: string,
  sub: string,
  used: boolean,
  onQueue: (btn: HTMLButtonElement) => void,
): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "row";
  const meta = document.createElement("div");
  meta.className = "meta";
  const t = document.createElement("strong");
  t.textContent = title;
  const s = document.createElement("span");
  s.textContent = sub;
  meta.append(t, s);
  const btn = document.createElement("button");
  btn.type = "button";
  if (used) {
    // Visibly "disabled", but still tappable so the guest gets the
    // explainer modal instead of a dead button.
    btn.textContent = "Played";
    btn.className = "q used";
    btn.setAttribute("aria-disabled", "true");
    btn.addEventListener("click", () => showModal(REPLAY_MSG));
  } else {
    btn.textContent = "Queue";
    btn.className = "q";
    btn.addEventListener("click", () => onQueue(btn));
  }
  div.append(meta, btn);
  return div;
}

function guard(btn: HTMLButtonElement): boolean {
  const now = Date.now();
  if (now - lastActionAt < 1200) {
    toast("Easy — one at a time 🙂", "warn");
    return false;
  }
  lastActionAt = now;
  btn.disabled = true;
  btn.textContent = "…";
  return true;
}

function done(
  btn: HTMLButtonElement,
  res: { ok: true } | { ok: false; status: number; error: string },
  name: string,
  path?: string,
): void {
  if (res.ok) {
    if (path) requested.add(path);
    btn.textContent = "Queued ✓";
    btn.classList.add("used");
    toast(`Queued “${name}” — thanks! 🎶`);
  } else if (res.status === 409) {
    // Raced the played-set (became played between render and tap).
    btn.textContent = "Played";
    btn.classList.add("used");
    showModal(REPLAY_MSG);
  } else if (res.status === 404) {
    btn.disabled = false;
    btn.textContent = "Queue";
    toast("Session closed — refresh the page.", "warn");
  } else {
    btn.disabled = false;
    btn.textContent = "Queue";
    toast(res.error || "Could not queue that.", "warn");
  }
}

/** Render (or re-render) the library, filtered by the search box.
 *  Pure client-side — no network. Runs on load and on every keystroke. */
function renderLocal(): void {
  const q = searchEl.value.trim().toLowerCase();
  const hits = library.filter((t) => {
    if (q === "") return true;
    const hay = `${t.name} ${t.title ?? ""} ${t.artist ?? ""}`;
    return hay.toLowerCase().includes(q);
  });
  if (hits.length === 0) {
    empty(localBox, "No tracks in the crate match that.");
    return;
  }
  const frag = document.createDocumentFragment();
  for (const t of hits.slice(0, LOCAL_CAP)) {
    const title = t.title ?? t.name;
    const sub = t.artist ?? t.dir ?? "";
    frag.append(
      row(title, sub, isUsed(t.path), async (btn) => {
        if (!guard(btn)) return;
        const res = await api.queueToSession({
          id: sessionId,
          name: title,
          path: t.path,
          bpm: t.bpm,
        });
        done(btn, res, title, t.path);
      }),
    );
  }
  if (hits.length > LOCAL_CAP) {
    const more = document.createElement("p");
    more.className = "empty";
    more.textContent = `+${hits.length - LOCAL_CAP} more — keep typing to narrow it down.`;
    frag.append(more);
  }
  localBox.innerHTML = "";
  localBox.append(frag);
}

/** Enter → search the remote source and list those results. */
async function runRemote(): Promise<void> {
  if (!remoteEnabled) return;
  const q = searchEl.value.trim();
  if (q === "") {
    toast("Type something, then press Enter to search the web.", "warn");
    return;
  }
  remoteAbort?.abort();
  remoteAbort = new AbortController();
  empty(remoteBox, `Searching the web for “${q}”… 🌐`);
  let items: RemoteTrackInfo[] = [];
  try {
    const page = await api.remoteSearch(q, 0, remoteAbort.signal, sessionId);
    items = page.items.slice(0, 25);
  } catch {
    empty(remoteBox, "Web search failed — try again.");
    return;
  }
  if (items.length === 0) {
    empty(remoteBox, `No web results for “${q}”.`);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const it of items) {
    const title = it.version ? `${it.title} (${it.version})` : it.title;
    frag.append(
      row(title, it.artist, false, async (btn) => {
        if (!guard(btn)) return;
        toast("Fetching from the web… 📥");
        const res = await api.queueToSession({
          id: sessionId,
          name: `${it.artist} - ${title}`,
          remoteId: it.remoteId,
        });
        done(btn, res, title);
      }),
    );
  }
  remoteBox.innerHTML = "";
  remoteBox.append(frag);
}

searchEl.addEventListener("input", () => {
  if (searchEl.disabled) return;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(renderLocal, 120);
});
searchEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void runRemote();
  }
});

async function main(): Promise<void> {
  if (!sessionId) {
    statusEl.textContent = "Missing session code — scan the DJ's QR again.";
    statusEl.dataset.kind = "warn";
    searchEl.disabled = true;
    return;
  }
  const { ok, snap } = await loadSession();
  if (!ok || !snap) return;

  empty(localBox, "Loading the crate…");
  try {
    library = (
      await api.getLibrary({ session: sessionId, limit: 1000 })
    ).tracks;
  } catch {
    library = [];
  }
  renderLocal();

  remoteEnabled = (await api.remoteStatus()).enabled;
  if (remoteEnabled) {
    $<HTMLElement>("#sec-remote").hidden = false;
    searchEl.placeholder = "Filter the crate — press Enter to search the web";
  }

  updateNowPlaying(snap.nowPlaying ?? null, snap.nowPlayingAt ?? null);

  // Keep the played set and now-playing fresh; re-render in place.
  window.setInterval(() => {
    void api.getSession(sessionId).then((s) => {
      if (!s) return;
      played = new Set(s.played);
      renderLocal();
      updateNowPlaying(s.nowPlaying ?? null, s.nowPlayingAt ?? null);
    });
  }, 8000);
}

void main();
