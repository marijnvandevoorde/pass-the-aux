import { api } from "./api.js";
import type { NowPlaying, SessionQueueItem } from "./api.js";
import type { LibraryResponse } from "./types.js";
import { applyKeyVars, keyHue } from "./key-utils.js";
import { createWaveform } from "./waveform.js";
import { byId as must, esc, fmtTime as fmt, toast, makeCoverLoader, keyBpmMeta, requesterChip } from "./dom-utils.js";

type LibTrack = LibraryResponse["tracks"][number];

const NAME_KEY = "pta-guest-name";
const VOTES_KEY = "pta-votes";
const STALE_MS = 30_000;
const ASSUMED_DURATION = 210; // seconds, used for waveform progress

const sessionId = new URLSearchParams(location.search).get("s") ?? "";

// ── Guest helpers ──
const PALETTE = ["#3f72b0", "#8466b0", "#e8862e", "#43c9bd", "#d8567f", "#5aa469", "#c9913a"];

function colorFor(name: string): string {
  let h = 0;
  for (const c of name) h = ((h * 31 + c.charCodeAt(0)) >>> 0);
  return PALETTE[h % PALETTE.length] ?? PALETTE[0]!;
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return (first[0] ?? "").toUpperCase() + (last[0] ?? "").toUpperCase();
}

// ── DOM refs ──
const nameGateEl    = must<HTMLDivElement>("nameGate");
const gateInputEl   = must<HTMLInputElement>("gateInput");
const gateGoEl      = must<HTMLButtonElement>("gateGo");
const guestChipEl   = must<HTMLButtonElement>("guestChip");
const guestAvEl     = must<HTMLSpanElement>("guestAv");
const guestNameEl   = must<HTMLSpanElement>("guestName");
const guestCountEl  = must<HTMLSpanElement>("guestCount");
const discCoverEl   = must<HTMLImageElement>("discCover");
const npCoverEl     = must<HTMLImageElement>("npCover");
const nowHeroEl     = must<HTMLDivElement>("nowHero");
const nowTitleEl    = must<HTMLSpanElement>("nowTitle");
const nowArtistEl   = must<HTMLDivElement>("nowArtist");
const nowKeyChipEl  = must<HTMLSpanElement>("nowKeyChip");
const nowKeyLabelEl = must<HTMLSpanElement>("nowKeyLabel");
const nowBpmValEl   = must<HTMLSpanElement>("nowBpmVal");
const waveEl        = must<HTMLDivElement>("wave");
const timeElEl      = must<HTMLSpanElement>("timeElapsed");
const reqByEl       = must<HTMLDivElement>("reqBy");
const tabQueueEl    = must<HTMLButtonElement>("tabQueue");
const tabCrateEl    = must<HTMLButtonElement>("tabCrate");
const panelQueueEl  = must<HTMLDivElement>("panelQueue");
const panelCrateEl  = must<HTMLDivElement>("panelCrate");
const queueCountEl  = must<HTMLSpanElement>("queueCount");
const queueListEl   = must<HTMLDivElement>("queueList");
const playedHeadEl  = must<HTMLDivElement>("playedHead");
const playedBodyEl  = must<HTMLDivElement>("playedBody");
const fabCrateEl    = must<HTMLButtonElement>("fabCrate");
const crateSearchEl = must<HTMLInputElement>("crateSearch");
const crateListEl   = must<HTMLDivElement>("crateList");
const crateEmptyEl  = must<HTMLDivElement>("crateEmpty");
const npFullEl      = must<HTMLDivElement>("npFull");
const npCollapseEl  = must<HTMLButtonElement>("npCollapse");
const npTitleEl     = must<HTMLDivElement>("npTitle");
const npArtistEl    = must<HTMLDivElement>("npArtist");
const npKeyChipEl   = must<HTMLSpanElement>("npKeyChip");
const npKeyLabelEl  = must<HTMLSpanElement>("npKeyLabel");
const npBpmValEl    = must<HTMLSpanElement>("npBpmVal");
const npWaveEl      = must<HTMLDivElement>("npWave");
const npElapsedEl   = must<HTMLSpanElement>("npElapsed");
const npReqByEl     = must<HTMLDivElement>("npReqBy");
const toastContEl   = must<HTMLDivElement>("toastContainer");

// ── State ──
let library: LibTrack[] = [];
let pathToTrack = new Map<string, LibTrack>();
let upNext: SessionQueueItem[] = [];
let playedPaths = new Set<string>();
let requested = new Set<string>();
let nowPlaying: NowPlaying | null = null;
let nowPlayingAt: number | null = null;
let isPlaying = false;
let guest: { name: string; color: string; initials: string } | null = null;
let myVotes: Set<string>;

try {
  myVotes = new Set(JSON.parse(localStorage.getItem(VOTES_KEY) ?? "[]") as string[]);
} catch {
  myVotes = new Set();
}

// ── Waveforms (display-only) ──
const heroWave = createWaveform(waveEl, { seekable: false, minH: 12, maxH: 26 });
const fullWave = createWaveform(npWaveEl, { seekable: false, minH: 14, maxH: 32 });

// ── Cover art (chip disc + fullscreen disc) ──
const loadCover = makeCoverLoader(discCoverEl, npCoverEl);

// ── Progress clock ──
function tickProgress(): void {
  if (nowPlayingAt === null || !nowPlaying) return;
  const stale = Date.now() - nowPlayingAt > STALE_MS;
  isPlaying = !stale;
  const currentTime = stale ? 0 : Math.max(0, (Date.now() - nowPlayingAt) / 1000);
  const ratio = Math.min(1, currentTime / ASSUMED_DURATION);
  heroWave.setProgress(ratio);
  fullWave.setProgress(ratio);
  timeElEl.textContent = fmt(currentTime);
  npElapsedEl.textContent = fmt(currentTime);
  nowHeroEl.classList.toggle("playing", isPlaying);
  npFullEl.classList.toggle("playing", isPlaying);
}
setInterval(tickProgress, 500);

// ── Now playing render ──
function renderNowPlaying(): void {
  if (!nowPlaying) {
    nowTitleEl.textContent = "—";
    nowArtistEl.textContent = "Waiting for the DJ…";
    nowKeyLabelEl.textContent = "—";
    nowBpmValEl.textContent = "—";
    npTitleEl.textContent = "—";
    npArtistEl.textContent = "";
    npKeyLabelEl.textContent = "—";
    npBpmValEl.textContent = "—";
    reqByEl.innerHTML = "";
    npReqByEl.innerHTML = "";
    heroWave.rebuild("");
    fullWave.rebuild("");
    loadCover(null);
    nowHeroEl.classList.remove("playing");
    npFullEl.classList.remove("playing");
    return;
  }

  const np = nowPlaying;
  const camelot = np.path ? (pathToTrack.get(np.path)?.camelot ?? null) : null;

  nowTitleEl.textContent = np.name;
  nowArtistEl.textContent = np.artist ?? "";
  nowKeyLabelEl.textContent = camelot ?? "—";
  nowBpmValEl.textContent = np.bpm ? String(Math.round(np.bpm)) : "—";
  npTitleEl.textContent = np.name;
  npArtistEl.textContent = np.artist ?? "";
  npKeyLabelEl.textContent = camelot ?? "—";
  npBpmValEl.textContent = np.bpm ? String(Math.round(np.bpm)) : "—";

  if (camelot) {
    applyKeyVars(nowKeyChipEl, camelot);
    applyKeyVars(npKeyChipEl, camelot);
    const hue = keyHue(camelot);
    if (hue !== null) {
      npFullEl.style.setProperty("--np-tint", `hsla(${hue} 70% 55% / 0.22)`);
    }
  }

  reqByEl.innerHTML = requesterChip(np.by, { prefix: "" });
  npReqByEl.innerHTML = requesterChip(np.by, { prefix: "Requested by" });

  heroWave.rebuild(np.name + (np.artist ?? ""));
  fullWave.rebuild(np.name + (np.artist ?? ""));
  loadCover(np.path);
  tickProgress();
}

// ── Queue render ──
function renderQueue(): void {
  queueCountEl.textContent = String(upNext.length);
  queueListEl.innerHTML = "";

  if (upNext.length === 0) {
    queueListEl.innerHTML = `<div class="empty-text" style="padding:40px 0;text-align:center;color:var(--faint)">Nothing queued yet — request something below 👇</div>`;
    return;
  }

  upNext.forEach((tr, i) => {
    const camelot = pathToTrack.get(tr.path)?.camelot ?? null;
    const voted = myVotes.has(tr.path);
    const el = document.createElement("div");
    el.className = "queue-item";
    if (camelot) applyKeyVars(el, camelot);

    const who = requesterChip(tr.by, { prefix: "" });
    el.innerHTML = `
      <span class="q-index">${i + 1}</span>
      <span class="q-key-rail"></span>
      <div class="q-info">
        <div class="q-name">${esc(tr.name)}</div>
        <div class="q-meta">
          ${keyBpmMeta(camelot, tr.bpm)}
          ${who ? `<span class="q-dot">·</span>${who}` : ""}
        </div>
      </div>
      <button class="vote-pill${voted ? " voted" : ""}" data-path="${esc(tr.path)}" aria-pressed="${voted}">
        <svg class="vp-arrow" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 1.5 11 8H1z"/></svg>
        <span>${voted ? 2 : 1}</span>
      </button>`;
    queueListEl.appendChild(el);
  });

  queueListEl.querySelectorAll<HTMLButtonElement>("[data-path]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.dataset.path ?? "";
      const wasVoted = myVotes.has(path);
      if (wasVoted) myVotes.delete(path); else myVotes.add(path);
      try { localStorage.setItem(VOTES_KEY, JSON.stringify([...myVotes])); } catch { /* ignore */ }
      const tr = upNext.find((t) => t.path === path);
      renderQueue();
      if (!wasVoted && tr) showToast(`Voted for <b>${esc(tr.name)}</b>`);
    });
  });
}

// ── Played section render ──
function renderPlayed(): void {
  playedBodyEl.innerHTML = "";
  const playedTracks = [...playedPaths]
    .map((p) => pathToTrack.get(p))
    .filter((t): t is LibTrack => t != null);

  playedTracks.forEach((tr) => {
    const camelot = tr.camelot;
    const el = document.createElement("div");
    el.className = "queue-item played-item";
    if (camelot) applyKeyVars(el, camelot);
    el.innerHTML = `
      <span class="q-key-rail"></span>
      <div class="q-info">
        <div class="q-name">${esc(tr.title ?? tr.name)}</div>
        <div class="q-meta">
          ${camelot ? `<span class="q-key">${esc(camelot)}</span><span class="q-dot">·</span>` : ""}
          ${tr.bpm ? `<span class="q-bpm">${Math.round(tr.bpm)} BPM</span>` : ""}
        </div>
      </div>`;
    playedBodyEl.appendChild(el);
  });
}

// ── Crate render ──
function renderCrate(filter = ""): void {
  const q = filter.trim().toLowerCase();
  const items = q
    ? library.filter((t) => {
        const hay = `${t.title ?? t.name} ${t.artist ?? ""} ${t.dir}`;
        return hay.toLowerCase().includes(q);
      })
    : library;

  crateListEl.innerHTML = "";
  crateEmptyEl.classList.toggle("visible", items.length === 0);

  items.forEach((tr) => {
    const camelot = tr.camelot;
    const pending = requested.has(tr.path);
    const queued = upNext.some((t) => t.path === tr.path);
    const played = playedPaths.has(tr.path);

    const el = document.createElement("div");
    el.className = "lib-item";
    if (camelot) applyKeyVars(el, camelot);

    let btn: string;
    if (played) btn = `<button class="req-btn played" disabled>PLAYED</button>`;
    else if (queued) btn = `<button class="req-btn pending" disabled>✓ QUEUED</button>`;
    else if (pending) btn = `<button class="req-btn pending" disabled>SENT</button>`;
    else btn = `<button class="req-btn" data-path="${esc(tr.path)}">REQUEST</button>`;

    el.innerHTML = `
      <span class="lib-key-rail"></span>
      <div class="lib-info">
        <div class="lib-name">${esc(tr.title ?? tr.name)}</div>
        <div class="lib-meta">
          ${camelot ? `<span class="q-key">${esc(camelot)}</span><span class="q-dot">·</span>` : ""}
          ${tr.bpm ? `<span class="q-bpm">${Math.round(tr.bpm)} BPM</span>` : ""}
          ${tr.artist ? `<span class="q-dot">·</span><span style="color:var(--faint)">${esc(tr.artist)}</span>` : ""}
        </div>
      </div>
      ${btn}`;
    crateListEl.appendChild(el);
  });

  crateListEl.querySelectorAll<HTMLButtonElement>("[data-path]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const path = btn.dataset.path ?? "";
      const tr = library.find((t) => t.path === path);
      if (!tr) return;
      btn.disabled = true;
      btn.textContent = "…";
      const res = await api.queueToSession({
        id: sessionId,
        name: tr.title ?? tr.name,
        path: tr.path,
        bpm: tr.bpm,
        by: guest?.name ?? null,
      });
      if (res.ok) {
        requested.add(path);
        renderCrate(crateSearchEl.value);
        showToast(`Requested <b>${esc(tr.title ?? tr.name)}</b> — sent to the DJ`);
      } else if (res.status === 409) {
        btn.textContent = "PLAYED";
        btn.classList.add("played");
        showToast("That track already played this session");
      } else {
        btn.disabled = false;
        btn.textContent = "REQUEST";
        showToast(res.error || "Could not send request");
      }
    });
  });
}

// ── Tabs ──
function switchTab(to: "queue" | "crate"): void {
  const isQ = to === "queue";
  tabQueueEl.classList.toggle("active", isQ);
  tabCrateEl.classList.toggle("active", !isQ);
  panelQueueEl.classList.toggle("active", isQ);
  panelCrateEl.classList.toggle("active", !isQ);
}
tabQueueEl.addEventListener("click", () => switchTab("queue"));
tabCrateEl.addEventListener("click", () => switchTab("crate"));
fabCrateEl.addEventListener("click", () => switchTab("crate"));

// ── Fullscreen now playing ──
nowHeroEl.addEventListener("click", () => {
  npFullEl.classList.add("open");
  npFullEl.classList.toggle("playing", isPlaying);
});
const npCloseEl = must<HTMLButtonElement>("npClose");
npCollapseEl.addEventListener("click", () => npFullEl.classList.remove("open"));
npCloseEl.addEventListener("click", () => npFullEl.classList.remove("open"));

// ── Played toggle ──
playedHeadEl.addEventListener("click", () => {
  playedHeadEl.classList.toggle("open");
  playedBodyEl.classList.toggle("open");
});

// ── Search ──
crateSearchEl.addEventListener("input", () => renderCrate(crateSearchEl.value));

// ── Toast ──
const showToast = (msg: string): void => toast(toastContEl, msg);

// ── Name gate ──
function setGuest(name: string): void {
  guest = { name, color: colorFor(name), initials: initialsFor(name) };
  guestAvEl.textContent = guest.initials;
  guestAvEl.style.background = guest.color;
  guestNameEl.textContent = guest.name;
}

function dismissGate(): void {
  nameGateEl.classList.add("dismissed");
}

function openGate(): void {
  nameGateEl.classList.remove("dismissed");
  gateInputEl.value = guest?.name ?? "";
  gateGoEl.disabled = !gateInputEl.value.trim();
  setTimeout(() => gateInputEl.focus(), 50);
}

function submitGate(): void {
  const name = gateInputEl.value.trim().slice(0, 20);
  if (!name) return;
  try { localStorage.setItem(NAME_KEY, name); } catch { /* ignore */ }
  setGuest(name);
  dismissGate();
  renderQueue();
  renderCrate();
}

gateInputEl.addEventListener("input", () => {
  gateGoEl.disabled = !gateInputEl.value.trim();
});
gateInputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && gateInputEl.value.trim()) submitGate();
});
gateGoEl.addEventListener("click", submitGate);
guestChipEl.addEventListener("click", openGate);

// ── Session poll ──
let upNextVisible: boolean | null = null;
function applyUpNextVisibility(show: boolean): void {
  if (show === upNextVisible) return; // only act on a real change
  upNextVisible = show;
  document.documentElement.classList.toggle("hide-upnext", !show);
  if (!show) switchTab("crate");
}

function applySnapshot(snap: Awaited<ReturnType<typeof api.getSession>>): void {
  if (!snap) return;
  nowPlaying = snap.nowPlaying ?? null;
  nowPlayingAt = snap.nowPlayingAt ?? null;
  upNext = snap.pending;
  playedPaths = new Set(snap.played);
  applyUpNextVisibility(snap.config.showUpNext);
  renderNowPlaying();
  renderQueue();
  renderPlayed();
  renderCrate(crateSearchEl.value);
}

// ── Main ──
async function main(): Promise<void> {
  if (!sessionId) {
    nameGateEl.querySelector<HTMLDivElement>(".gate-session")!.textContent = "No session — scan the DJ's QR code";
    gateGoEl.disabled = true;
    gateGoEl.textContent = "No active session";
    return;
  }

  const snap = await api.getSession(sessionId);
  if (!snap) {
    nameGateEl.querySelector<HTMLDivElement>(".gate-session")!.textContent = "Session not found — ask the DJ for a fresh code";
    gateGoEl.disabled = true;
    gateGoEl.textContent = "Session closed";
    return;
  }

  library = (await api.getLibrary({ session: sessionId, limit: 2000 }).catch(() => ({ tracks: [] }))).tracks;
  pathToTrack = new Map(library.map((t) => [t.path, t]));

  applySnapshot(snap);

  const savedName = (() => { try { return localStorage.getItem(NAME_KEY); } catch { return null; } })();
  if (savedName) { setGuest(savedName); dismissGate(); }
  else { openGate(); }

  // Poll every 8s — re-applies the full snapshot (incl. live showUpNext).
  setInterval(async () => {
    applySnapshot(await api.getSession(sessionId));
  }, 8000);
}

void main();
