import { api } from "./api.js";
import type { SessionQueueItem } from "./api.js";
import type { BeatGridResponse, LibraryResponse } from "./types.js";
import { applyKeyVars, keyHue, keyRelation, bpmDeltaLabel, TONE_VARS } from "./key-utils.js";
import { createWaveform } from "./waveform.js";
import { qrMatrix } from "./qr.js";
import { byId, esc, fmtTime as fmt, toast, makeCoverLoader, keyBpmMeta, requesterChip } from "./dom-utils.js";

type LibTrack = LibraryResponse["tracks"][number];

type QueueItem = {
  path: string;
  name: string;
  artist: string | null;
  camelot: string | null;
  bpm: number | null;
  by: string;
};

const SESSION_KEY = "pta-mobile-session";
const SKIP_MS = 480;
const CIRC = 138.2;
const must = byId;

// ── DOM refs ──
const deckA         = must<HTMLAudioElement>("deckA");
const deckB         = must<HTMLAudioElement>("deckB");
const nowHeroEl     = must<HTMLDivElement>("nowHero");
const nowTitleEl    = must<HTMLSpanElement>("nowTitle");
const nowArtistEl   = must<HTMLDivElement>("nowArtist");
const nowKeyChipEl  = must<HTMLSpanElement>("nowKeyChip");
const nowKeyLabelEl = must<HTMLSpanElement>("nowKeyLabel");
const nowBpmValEl   = must<HTMLSpanElement>("nowBpmVal");
const nowReqEl      = must<HTMLDivElement>("nowReq");
const waveEl        = must<HTMLDivElement>("wave");
const timeElEl      = must<HTMLSpanElement>("timeElapsed");
const timeRemEl     = must<HTMLSpanElement>("timeRemain");
const discCoverEl   = must<HTMLImageElement>("discCover");
const playBtn       = must<HTMLButtonElement>("playBtn");
const playIcon      = must<SVGSVGElement>("playIcon");
const playLabel     = must<HTMLSpanElement>("playLabel");
const skipWrapEl    = must<HTMLDivElement>("skipWrap");
const skipRingEl    = must<SVGCircleElement>("skipRing");
const skipFlashEl   = must<HTMLDivElement>("skipFlash");
// Fullscreen now-playing
const npExpandBtnEl = must<HTMLElement>("npExpandBtn");
const npFullEl      = must<HTMLDivElement>("npFull");
const npCollapseEl  = must<HTMLButtonElement>("npCollapse");
const npCloseEl     = must<HTMLButtonElement>("npClose");
const npTitleEl     = must<HTMLDivElement>("npTitle");
const npArtistFullEl = must<HTMLDivElement>("npArtistFull");
const npKeyChipEl   = must<HTMLSpanElement>("npKeyChip");
const npKeyLabelEl  = must<HTMLSpanElement>("npKeyLabel");
const npBpmValEl    = must<HTMLSpanElement>("npBpmVal");
const npWaveEl      = must<HTMLDivElement>("npWave");
const npElapsedEl   = must<HTMLSpanElement>("npElapsed");
const npRemainEl    = must<HTMLSpanElement>("npRemain");
const npReqEl       = must<HTMLDivElement>("npReq");
const npCoverEl     = must<HTMLImageElement>("npCover");
const npPlayBtnEl   = must<HTMLButtonElement>("npPlayBtn");
const npPlayIconEl  = must<SVGSVGElement>("npPlayIcon");
const npPlayLabelEl = must<HTMLSpanElement>("npPlayLabel");
const npSkipWrapEl  = must<HTMLDivElement>("npSkipWrap");
const npSkipRingEl  = must<SVGCircleElement>("npSkipRing");
const npSkipFlashEl = must<HTMLDivElement>("npSkipFlash");
// Workspace / tabs
const tabQueueEl    = must<HTMLButtonElement>("tabQueue");
const tabLibraryEl  = must<HTMLButtonElement>("tabLibrary");
const panelQueueEl  = must<HTMLDivElement>("panelQueue");
const panelLibraryEl = must<HTMLDivElement>("panelLibrary");
const queueCountEl  = must<HTMLSpanElement>("queueCount");
const queueListEl   = must<HTMLDivElement>("queueList");
const queueEmptyEl  = must<HTMLDivElement>("queueEmpty");
const fabLibraryEl  = must<HTMLButtonElement>("fabLibrary");
const resetBtnEl    = must<HTMLButtonElement>("resetBtn");
const clearBtnEl    = must<HTMLButtonElement>("clearBtn");
const librarySearchEl = must<HTMLInputElement>("librarySearch");
const libraryListEl = must<HTMLDivElement>("libraryList");
const libraryEmptyEl = must<HTMLDivElement>("libraryEmpty");
const shareBtnEl    = must<HTMLButtonElement>("shareBtn");
const qrOverlayEl   = must<HTMLDivElement>("qrOverlay");
const qrCloseEl     = must<HTMLButtonElement>("qrClose");
const qrBoxEl       = must<HTMLDivElement>("qrBox");
const qrUrlEl       = must<HTMLElement>("qrUrl");
const upNextToggleEl = must<HTMLButtonElement>("upNextToggle");
const upNextHintEl  = must<HTMLElement>("upNextHint");
const toastContEl   = must<HTMLDivElement>("toastContainer");
const guestCountEl  = must<HTMLSpanElement>("guestCount");
const liveDotEl     = must<HTMLElement>("liveDot");

// ── State ──
let activeDeck: HTMLAudioElement = deckA;
let inactiveDeck: HTMLAudioElement = deckB;
let sessionId = "";
let crowdUrl = "";
let sessionFadeMs = 4000;
let library: LibTrack[] = [];
let pathToTrack = new Map<string, LibTrack>();
let queue: QueueItem[] = [];
let nowPlaying: QueueItem | null = null;
let isPlaying = false;
let pendingPlayed: string[] = [];
let skipping = false;
let fading = false;
let currentBeatGrid: BeatGridResponse | null = null;

// ── Web Audio crossfade graph ──
// iOS Safari ignores HTMLMediaElement.volume (it's read-only there), so a
// volume-based crossfade is a silent no-op on iPhone — the tracks just
// overlap then cut. Route both decks through GainNodes (which DO work on
// iOS) and ride the gain instead, matching the desktop's Web Audio mix.
let audioCtx: AudioContext | null = null;
const deckGain = new Map<HTMLAudioElement, GainNode>();

function ensureAudioGraph(): void {
  if (audioCtx) return;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return; // no Web Audio → fall back to element.volume
  try {
    const ctx = new Ctor();
    for (const deck of [deckA, deckB]) {
      const src = ctx.createMediaElementSource(deck);
      const gain = ctx.createGain();
      gain.gain.value = 1;
      src.connect(gain).connect(ctx.destination);
      deckGain.set(deck, gain);
    }
    audioCtx = ctx;
  } catch {
    // Web Audio unavailable/blocked → leave audioCtx null; playback uses
    // the bare <audio> elements and fades fall back to .volume.
    audioCtx = null;
    deckGain.clear();
  }
}

/** Create + resume the context from within a user gesture (first play). */
function resumeAudio(): void {
  ensureAudioGraph();
  void audioCtx?.resume();
}

/** Set a deck's level instantly (0..1) via its gain (or volume fallback). */
function setDeckLevel(deck: HTMLAudioElement, level: number): void {
  const g = deckGain.get(deck);
  if (audioCtx && g) {
    g.gain.cancelScheduledValues(audioCtx.currentTime);
    g.gain.setValueAtTime(level, audioCtx.currentTime);
  } else {
    deck.volume = level;
  }
}

/** Linear gain ramp over `seconds`; resolves when done. Falls back to a
 *  requestAnimationFrame volume ramp where Web Audio is unavailable. */
function fadeDeck(deck: HTMLAudioElement, to: number, seconds: number): Promise<void> {
  const g = deckGain.get(deck);
  if (audioCtx && g) {
    const t = audioCtx.currentTime;
    const from = g.gain.value;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(from, t);
    g.gain.linearRampToValueAtTime(to, t + seconds);
    return new Promise((r) => setTimeout(r, seconds * 1000));
  }
  const fromVol = deck.volume;
  const start = performance.now();
  return new Promise((resolve) => {
    const step = (): void => {
      const p = Math.min(1, (performance.now() - start) / (seconds * 1000));
      deck.volume = fromVol + (to - fromVol) * p;
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// ── Waveforms (both seek the active deck) ──
const seekActive = (ratio: number): void => {
  if (activeDeck.duration && isFinite(activeDeck.duration))
    activeDeck.currentTime = ratio * activeDeck.duration;
};
const heroWave = createWaveform(waveEl, { seekable: true, onSeek: seekActive });
const npWave = createWaveform(npWaveEl, { seekable: true, onSeek: seekActive });

// ── Audio events (both decks) ──
function handleTimeUpdate(deck: HTMLAudioElement): void {
  if (deck !== activeDeck || !deck.duration || !isFinite(deck.duration)) return;
  const ratio = deck.currentTime / deck.duration;
  heroWave.setProgress(ratio);
  npWave.setProgress(ratio);
  const el = fmt(deck.currentTime);
  const rem = "-" + fmt(deck.duration - deck.currentTime);
  timeElEl.textContent = el;
  timeRemEl.textContent = rem;
  npElapsedEl.textContent = el;
  npRemainEl.textContent = rem;
}

function handleEnded(deck: HTMLAudioElement): void {
  if (deck === activeDeck) advance();
}

function handlePlayPause(deck: HTMLAudioElement): void {
  if (deck === activeDeck) setPlayState(!deck.paused);
}

deckA.addEventListener("timeupdate", () => handleTimeUpdate(deckA));
deckB.addEventListener("timeupdate", () => handleTimeUpdate(deckB));
deckA.addEventListener("ended", () => handleEnded(deckA));
deckB.addEventListener("ended", () => handleEnded(deckB));
deckA.addEventListener("play",  () => handlePlayPause(deckA));
deckA.addEventListener("pause", () => handlePlayPause(deckA));
deckB.addEventListener("play",  () => handlePlayPause(deckB));
deckB.addEventListener("pause", () => handlePlayPause(deckB));

// ── Play state ──
const ICON_PLAY  = `<path d="M3 2l11 6.5L3 15V2z" fill="currentColor"/>`;
const ICON_PAUSE = `<rect x="3" y="2" width="3.6" height="13" rx="1.4" fill="currentColor"/><rect x="9.4" y="2" width="3.6" height="13" rx="1.4" fill="currentColor"/>`;

function setPlayState(playing: boolean): void {
  isPlaying = playing;
  playIcon.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  playLabel.textContent = playing ? "PLAYING" : "PAUSED";
  npPlayIconEl.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
  npPlayLabelEl.textContent = playing ? "PLAYING" : "PAUSED";
  nowHeroEl.classList.toggle("playing", playing);
  npFullEl.classList.toggle("playing", playing);
}

// ── Transport ──
function togglePlay(): void {
  if (!nowPlaying) return;
  resumeAudio();
  if (activeDeck.paused) activeDeck.play().catch(() => {});
  else activeDeck.pause();
}
playBtn.addEventListener("click", togglePlay);
npPlayBtnEl.addEventListener("click", togglePlay);

// ── Beat-matched fade-to-next ──
async function doFadeToNext(): Promise<void> {
  if (fading || skipping || queue.length === 0) return;
  skipping = true;

  // Ring animation (confirmation)
  for (const [wrap, ring, flash] of [
    [skipWrapEl, skipRingEl, skipFlashEl],
    [npSkipWrapEl, npSkipRingEl, npSkipFlashEl],
  ] as [HTMLDivElement, SVGCircleElement, HTMLDivElement][]) {
    wrap.classList.add("spinning");
    flash.classList.remove("flash-anim");
    void flash.offsetWidth;
    flash.classList.add("flash-anim");
  }

  const startMs = Date.now();
  await new Promise<void>((resolve) => {
    function tick(): void {
      const p = Math.min((Date.now() - startMs) / SKIP_MS, 1);
      const offset = String(CIRC * (1 - p));
      skipRingEl.style.strokeDashoffset = offset;
      npSkipRingEl.style.strokeDashoffset = offset;
      if (p < 1) requestAnimationFrame(tick);
      else resolve();
    }
    requestAnimationFrame(tick);
  });

  skipRingEl.style.strokeDashoffset = String(CIRC);
  npSkipRingEl.style.strokeDashoffset = String(CIRC);
  skipWrapEl.classList.remove("spinning");
  npSkipWrapEl.classList.remove("spinning");
  skipping = false;

  // Beat-grid: wait until the next bar boundary before starting the fade
  let waitMs = 0;
  if (currentBeatGrid && activeDeck.duration && isFinite(activeDeck.duration)) {
    const { beats, downbeatPhase } = currentBeatGrid;
    const now = activeDeck.currentTime;
    const remain = activeDeck.duration - now;
    for (let i = 0; i < beats.length; i++) {
      const beat = beats[i] ?? 0;
      if (beat > now + 0.05 && i % 4 === downbeatPhase) {
        const wait = beat - now;
        // Only hold if there's room for the full fade after the bar
        if (wait > 0 && wait < remain - sessionFadeMs / 1000 - 0.5) {
          waitMs = Math.min(wait * 1000, 8000); // cap at 8s (2 bars at 60bpm)
        }
        break;
      }
    }
  }

  if (waitMs > 0) await new Promise<void>((r) => setTimeout(r, waitMs));

  fading = true;
  const next = queue[0];
  if (!next) { fading = false; return; }

  // Load next into the inactive deck, start it silent, then crossfade gains.
  const outDeck = activeDeck;
  const inDeck = inactiveDeck;
  resumeAudio();
  inDeck.src = api.audioUrl(next.path);
  setDeckLevel(inDeck, 0);
  await inDeck.play().catch(() => {});

  const fadeSec = Math.max(0.1, sessionFadeMs / 1000);
  await Promise.all([
    fadeDeck(outDeck, 0, fadeSec),
    fadeDeck(inDeck, 1, fadeSec),
  ]);

  // outgoing deck done: stop it and reset its level for next reuse
  outDeck.pause();
  outDeck.src = "";
  setDeckLevel(outDeck, 1);

  // Swap decks; the crossfade already faded the new track in.
  activeDeck = inDeck;
  inactiveDeck = outDeck;
  fading = false;
  queue.shift();
  commitNowPlaying(next);
}

skipWrapEl.addEventListener("click", () => void doFadeToNext());
npSkipWrapEl.addEventListener("click", () => void doFadeToNext());

/** Mark the outgoing track played, promote `next` to now-playing, and
 *  refresh all UI (cover, beat grid, waveforms via renderNow, queue).
 *  The caller owns the audio (instant src set vs. beat-aligned crossfade). */
function commitNowPlaying(next: QueueItem): void {
  if (nowPlaying) pendingPlayed.push(nowPlaying.path);
  nowPlaying = next;
  loadCover(next.path);
  void loadBeatGrid(next.path);
  renderNow();
  renderQueue();
}

// ── Instant advance (auto-play on track end) ──
function advance(): void {
  const next = queue.shift();
  if (!next) {
    if (nowPlaying) pendingPlayed.push(nowPlaying.path);
    nowPlaying = null;
    activeDeck.pause();
    activeDeck.src = "";
    setPlayState(false);
    renderNow();
    renderQueue();
    return;
  }
  resumeAudio();
  setDeckLevel(activeDeck, 1); // ensure full level (e.g. after a prior fade)
  activeDeck.src = api.audioUrl(next.path);
  activeDeck.play().catch(() => {});
  commitNowPlaying(next);
}

// ── Beat grid ──
async function loadBeatGrid(path: string): Promise<void> {
  currentBeatGrid = await api.getBeatGrid(path).catch(() => null);
}

// ── Cover art (chip disc + fullscreen disc) ──
const loadCover = makeCoverLoader(discCoverEl, npCoverEl);

// Landscape layout is handled entirely in CSS (mobile-styles.css media
// query) — no JS orientation toggle needed.

// ── Fullscreen now-playing ──
function syncNpFull(): void {
  if (!nowPlaying) return;
  const np = nowPlaying;
  npTitleEl.textContent = np.name;
  npArtistFullEl.textContent = np.artist ?? "";
  npKeyLabelEl.textContent = np.camelot ?? "—";
  npBpmValEl.textContent = np.bpm ? String(Math.round(np.bpm)) : "—";
  if (np.camelot) {
    applyKeyVars(npKeyChipEl, np.camelot);
    const hue = keyHue(np.camelot);
    if (hue !== null) npFullEl.style.setProperty("--np-tint", `hsla(${hue} 70% 55% / 0.22)`);
  } else {
    npFullEl.style.removeProperty("--np-tint");
  }
  npReqEl.innerHTML = requesterChip(np.by, { prefix: "Requested by" });
  npWave.rebuild(np.name + (np.artist ?? ""));
}

function openNpFull(): void {
  npFullEl.classList.add("open");
  npFullEl.classList.toggle("playing", isPlaying);
  syncNpFull();
}
function closeNpFull(): void { npFullEl.classList.remove("open"); }

// Expand affordances: the corner hint AND the album-art disc (Spotify-style).
// NOT the whole hero — that would collide with the transport + seekable wave.
const discWrapEl = nowHeroEl.querySelector<HTMLElement>(".disc-wrap");
npExpandBtnEl.addEventListener("click", (e) => { e.stopPropagation(); openNpFull(); });
discWrapEl?.addEventListener("click", openNpFull);
npCollapseEl.addEventListener("click", closeNpFull);
npCloseEl.addEventListener("click", closeNpFull);

// ── Now playing render ──
function renderNow(): void {
  if (!nowPlaying) {
    nowTitleEl.textContent = "—";
    nowArtistEl.textContent = "Add a track to begin";
    nowKeyLabelEl.textContent = "—";
    nowBpmValEl.textContent = "—";
    nowReqEl.innerHTML = "";
    heroWave.rebuild("");
    timeElEl.textContent = "0:00";
    timeRemEl.textContent = "-0:00";
    return;
  }
  const np = nowPlaying;
  nowTitleEl.textContent = np.name;
  nowArtistEl.textContent = np.artist ?? "";
  nowKeyLabelEl.textContent = np.camelot ?? "—";
  nowBpmValEl.textContent = np.bpm ? String(Math.round(np.bpm)) : "—";
  nowReqEl.innerHTML = requesterChip(np.by, { prefix: "" });
  if (np.camelot) applyKeyVars(nowKeyChipEl, np.camelot);
  heroWave.rebuild(np.name + (np.artist ?? ""));
  if (npFullEl.classList.contains("open")) syncNpFull();
}

// ── Mix-link HTML ──
function mixLinkHTML(a: QueueItem, b: QueueItem): string {
  if (!a.camelot || !b.camelot || !a.bpm || !b.bpm) return "";
  const rel = keyRelation(a.camelot, b.camelot);
  const t = TONE_VARS[rel.tone];
  const dStr = bpmDeltaLabel(a.bpm, b.bpm);
  return `<div class="mix-link" style="--ml-color:${t.color};--ml-bg:${t.bg};--ml-bd:${t.bd}">
    <span class="mix-badge">${rel.label}</span>
    <span class="mix-delta">${dStr} · ${esc(a.camelot)}→${esc(b.camelot)}</span>
  </div>`;
}

// ── Queue render ──
function renderQueue(): void {
  queueCountEl.textContent = String(queue.length);
  queueListEl.innerHTML = "";
  queueEmptyEl.classList.toggle("visible", queue.length === 0);
  if (queue.length === 0) return;

  if (nowPlaying && queue[0]) {
    queueListEl.insertAdjacentHTML("beforeend", mixLinkHTML(nowPlaying, queue[0]));
  }

  const od = queue[0]!;
  const odEl = document.createElement("div");
  odEl.className = "ondeck-card";
  if (od.camelot) applyKeyVars(odEl, od.camelot);
  const odWho = requesterChip(od.by, { prefix: "" });
  odEl.innerHTML = `
    <div class="od-mini-disc"></div>
    <div class="od-info">
      <span class="od-tag">ON DECK · CUED NEXT</span>
      <div class="od-name">${esc(od.name)}${od.artist ? ` <span style="color:var(--dim);font-weight:500">— ${esc(od.artist)}</span>` : ""}</div>
      <div class="od-sub">
        ${keyBpmMeta(od.camelot, od.bpm)}
        ${odWho ? `<span class="q-dot">·</span>${odWho}` : ""}
      </div>
    </div>
    <button class="remove-btn" data-idx="0" aria-label="Remove">×</button>`;
  queueListEl.appendChild(odEl);

  if (queue.length > 1) {
    queueListEl.insertAdjacentHTML("beforeend",
      `<div class="queue-divider"><span>QUEUE</span><span class="qd-count">${queue.length - 1}</span></div>`);
  }

  for (let i = 1; i < queue.length; i++) {
    const prev = queue[i - 1]!;
    const tr = queue[i]!;
    queueListEl.insertAdjacentHTML("beforeend", mixLinkHTML(prev, tr));
    const item = document.createElement("div");
    item.className = "queue-item";
    if (tr.camelot) applyKeyVars(item, tr.camelot);
    const who = requesterChip(tr.by, { prefix: "" });
    item.innerHTML = `
      <span class="q-key-rail"></span>
      <div class="q-info">
        <div class="q-name">${esc(tr.name)}</div>
        <div class="q-meta">
          ${keyBpmMeta(tr.camelot, tr.bpm)}
          ${who ? `<span class="q-dot">·</span>${who}` : ""}
        </div>
      </div>
      <button class="remove-btn" data-idx="${i}" aria-label="Remove">×</button>`;
    queueListEl.appendChild(item);
  }

  queueListEl.querySelectorAll<HTMLButtonElement>(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.idx ?? "0", 10);
      const card = btn.closest(".ondeck-card, .queue-item");
      if (card) card.classList.add("removing");
      setTimeout(() => { queue.splice(idx, 1); renderQueue(); }, 220);
    });
  });
}

// ── Library render ──
function renderLibrary(filter = ""): void {
  const q = filter.trim().toLowerCase();
  const visible = q
    ? library.filter((t) => `${t.title ?? t.name} ${t.artist ?? ""} ${t.dir}`.toLowerCase().includes(q))
    : library;

  libraryListEl.innerHTML = "";
  libraryEmptyEl.classList.toggle("visible", visible.length === 0);

  const cap = 200;
  visible.slice(0, cap).forEach((tr) => {
    const camelot = tr.camelot;
    const inQ = queue.some((t) => t.path === tr.path) || nowPlaying?.path === tr.path;
    const item = document.createElement("div");
    item.className = "lib-item";
    if (camelot) applyKeyVars(item, camelot);
    item.innerHTML = `
      <span class="lib-key-rail"></span>
      <div class="lib-info">
        <div class="lib-name">${esc(tr.title ?? tr.name)}</div>
        <div class="lib-meta">
          ${camelot ? `<span class="q-key">${esc(camelot)}</span><span class="q-dot">·</span>` : ""}
          ${tr.bpm ? `<span class="q-bpm">${Math.round(tr.bpm)} BPM</span>` : ""}
          ${tr.artist ? `<span class="q-dot">·</span><span style="color:var(--faint)">${esc(tr.artist)}</span>` : ""}
        </div>
      </div>
      <button class="add-btn${inQ ? " added" : ""}" data-path="${esc(tr.path)}">${inQ ? "✓ ADDED" : "+ QUEUE"}</button>`;
    libraryListEl.appendChild(item);
  });

  if (visible.length > cap) {
    const more = document.createElement("p");
    more.className = "lib-empty visible";
    more.textContent = `+${visible.length - cap} more — keep typing to narrow down`;
    libraryListEl.appendChild(more);
  }

  libraryListEl.querySelectorAll<HTMLButtonElement>("[data-path]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = btn.dataset.path ?? "";
      const tr = library.find((t) => t.path === path);
      if (!tr) return;
      addToQueue({ path: tr.path, name: tr.title ?? tr.name, artist: tr.artist, camelot: tr.camelot, bpm: tr.bpm, by: "you" });
      renderLibrary(librarySearchEl.value);
    });
  });
}

// ── Add to queue ──
function addToQueue(item: QueueItem): void {
  if (queue.some((t) => t.path === item.path)) { showToast("Already in the queue"); return; }
  queue.push(item);
  showToast(`Added <b>${esc(item.name)}</b>`);
  if (!nowPlaying) { advance(); return; }
  renderQueue();
}

// ── Tabs ──
function switchTab(to: "queue" | "library"): void {
  const isQ = to === "queue";
  tabQueueEl.classList.toggle("active", isQ);
  tabLibraryEl.classList.toggle("active", !isQ);
  panelQueueEl.classList.toggle("active", isQ);
  panelLibraryEl.classList.toggle("active", !isQ);
}
tabQueueEl.addEventListener("click", () => switchTab("queue"));
tabLibraryEl.addEventListener("click", () => switchTab("library"));
fabLibraryEl.addEventListener("click", () => switchTab("library"));

// ── Clear / reset ──
clearBtnEl.addEventListener("click", () => { queue = []; renderQueue(); });
resetBtnEl.addEventListener("click", async () => {
  await api.clearSessionPlayed(sessionId);
  showToast("Played history reset");
});

// ── Library search ──
librarySearchEl.addEventListener("input", () => renderLibrary(librarySearchEl.value));

// ── Show Up Next toggle ──
let showUpNext = (() => { try { return localStorage.getItem("pta-show-upnext") !== "false"; } catch { return true; } })();

function applyUpNextToggle(): void {
  upNextToggleEl.setAttribute("aria-checked", String(showUpNext));
  upNextHintEl.textContent = showUpNext
    ? "Guests can see Up Next & vote"
    : "Guests only see Now Playing & the crate";
}

upNextToggleEl.addEventListener("click", () => {
  showUpNext = !showUpNext;
  try { localStorage.setItem("pta-show-upnext", String(showUpNext)); } catch { /* ignore */ }
  applyUpNextToggle();
  if (sessionId) void api.patchSessionConfig(sessionId, { showUpNext });
});
applyUpNextToggle();

// ── QR overlay ──
shareBtnEl.addEventListener("click", () => qrOverlayEl.classList.add("open"));
qrCloseEl.addEventListener("click", () => qrOverlayEl.classList.remove("open"));
qrOverlayEl.addEventListener("click", (e) => { if (e.target === qrOverlayEl) qrOverlayEl.classList.remove("open"); });

// ── Toast ──
const showToast = (msg: string): void => toast(toastContEl, msg);

// ── QR render ──
function renderQR(): void {
  const matrix = qrMatrix(crowdUrl);
  if (!matrix) return;
  const n = matrix.length;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (matrix[r]?.[c]) {
        const rect = document.createElementNS(NS, "rect");
        rect.setAttribute("x", String(c));
        rect.setAttribute("y", String(r));
        rect.setAttribute("width", "1");
        rect.setAttribute("height", "1");
        rect.setAttribute("fill", "#0a0a0a");
        svg.appendChild(rect);
      }
    }
  }
  qrBoxEl.innerHTML = "";
  qrBoxEl.appendChild(svg);
  qrUrlEl.textContent = crowdUrl.replace(/^https?:\/\//, "");
}

// ── Session sync ──
async function sync(): Promise<void> {
  if (!sessionId) return;
  const np = nowPlaying
    ? { name: nowPlaying.name, artist: nowPlaying.artist, bpm: nowPlaying.bpm, path: nowPlaying.path, by: nowPlaying.by }
    : null;
  const toReport = [...pendingPlayed];
  pendingPlayed = [];
  let newItems: SessionQueueItem[] = [];
  try {
    newItems = await api.syncSession(sessionId, toReport, np);
  } catch {
    pendingPlayed = [...toReport, ...pendingPlayed];
    return;
  }
  if (newItems.length > 0) {
    const enriched: QueueItem[] = newItems.map((t) => {
      const lib = pathToTrack.get(t.path);
      return {
        path: t.path,
        name: t.name,
        artist: lib?.artist ?? null,
        camelot: lib?.camelot ?? null,
        bpm: t.bpm ?? lib?.bpm ?? null,
        by: t.by ?? "guest",
      };
    });
    const fresh = enriched.filter((e) => !queue.some((q) => q.path === e.path) && nowPlaying?.path !== e.path);
    if (fresh.length > 0) {
      queue.push(...fresh);
      renderQueue();
      showToast(`${fresh.length} crowd request${fresh.length > 1 ? "s" : ""} added`);
    }
  }
}

// ── Session init ──
async function initSession(): Promise<void> {
  const saved = (() => { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } })();
  if (saved) {
    const snap = await api.getSession(saved).catch(() => null);
    if (snap) {
      sessionId = saved;
      sessionFadeMs = (snap.config.fadeSeconds ?? 4) * 1000;
      return;
    }
  }
  const { id, url } = await api.createSession({
    automix: false, autoFill: false, beatSync: false, fadeSeconds: 4, showUpNext,
  });
  sessionId = id;
  crowdUrl = url;
  sessionFadeMs = 4000;
  try { localStorage.setItem(SESSION_KEY, id); } catch { /* ignore */ }
}

// ── Main ──
async function main(): Promise<void> {
  guestCountEl.textContent = "Starting…";
  await initSession();
  if (!crowdUrl) crowdUrl = `${location.origin}/crowd?s=${sessionId}`;

  library = await api.getLibrary({ limit: 2000 }).then((r) => r.tracks).catch(() => []);
  pathToTrack = new Map(library.map((t) => [t.path, t]));

  renderLibrary();
  renderNow();
  renderQueue();
  renderQR();

  liveDotEl.style.display = "";
  shareBtnEl.style.display = "";
  guestCountEl.innerHTML = "<b>0</b> in the room";

  setInterval(() => void sync(), 4000);
}

void main();
