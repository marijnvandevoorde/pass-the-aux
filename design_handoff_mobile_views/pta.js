/* ============================================================
   Pass the Aux — app logic
   ============================================================ */

/* ---- Data ---------------------------------------------------
   key = Camelot notation. addedBy = guest who suggested it.   */
const GUESTS = {
  mara:  { initials: 'MV', color: '#3f72b0' },
  jules: { initials: 'JD', color: '#8466b0' },
  theo:  { initials: 'TR', color: '#e8862e' },
  nadia: { initials: 'NK', color: '#43c9bd' },
  you:   { initials: 'YOU', color: '#38e0c4' },
};

const NOW_INIT = {
  name: 'Antidote', artist: 'FILOFIHI', key: '11B', bpm: 133, duration: 211,
};

let QUEUE_INIT = [
  { id: 1, name: 'Spiral',          artist: 'William Proulx', key: '11B', bpm: 129, by: 'theo'  },
  { id: 2, name: 'Glass Heart',     artist: 'Aero',           key: '12B', bpm: 131, by: 'jules' },
  { id: 3, name: 'Nightcall',       artist: 'Kavinsky',       key: '1B',  bpm: 124, by: 'mara'  },
  { id: 4, name: 'Midnight City',   artist: 'M83',            key: '6A',  bpm: 105, by: 'nadia' },
  { id: 5, name: 'Saturn',          artist: 'Sleeper',        key: '8B',  bpm: 122, by: 'theo'  },
];

const LIBRARY = [
  { id: 101, name: 'Antidote',         artist: 'FILOFIHI',      key: '11B', bpm: 133 },
  { id: 102, name: 'Spiral',           artist: 'William Proulx',key: '11B', bpm: 129 },
  { id: 103, name: 'Glass Heart',      artist: 'Aero',          key: '12B', bpm: 131 },
  { id: 104, name: 'Resonance',        artist: 'Home',          key: '10B', bpm: 128 },
  { id: 105, name: 'Nightcall',        artist: 'Kavinsky',      key: '1B',  bpm: 124 },
  { id: 106, name: 'Midnight City',    artist: 'M83',           key: '6A',  bpm: 105 },
  { id: 107, name: 'Saturn',           artist: 'Sleeper',       key: '8B',  bpm: 122 },
  { id: 108, name: 'Tides',            artist: 'Lune',          key: '11A', bpm: 126 },
  { id: 109, name: 'Outrun',           artist: 'Power Glove',   key: '4A',  bpm: 118 },
  { id: 110, name: 'Replica',          artist: 'Sworn',        key: '11B', bpm: 134 },
  { id: 111, name: 'Velvet',           artist: 'Cassø',         key: '2B',  bpm: 140 },
  { id: 112, name: 'Afterglow',        artist: 'Tor',           key: '9B',  bpm: 120 },
  { id: 113, name: 'Cascade',          artist: ' Darn',         key: '12A', bpm: 130 },
  { id: 114, name: 'Lowtide',          artist: 'Bv',            key: '3A',  bpm: 92  },
];

/* ---- State ---- */
let nowPlaying = { ...NOW_INIT };
let queue = QUEUE_INIT.map(t => ({ ...t }));
let isPlaying = true;
let liked = false;
let nextId = 500;
let currentTime = 0;           // seconds into nowPlaying
let waveData = [];             // bar heights for current track

/* ---- Camelot harmonic engine ---- */
function parseKey(k) {
  const m = /^(\d{1,2})([AB])$/.exec(k);
  if (!m) return null;
  return { num: parseInt(m[1], 10), letter: m[2] };
}
function circDist(a, b) { const d = Math.abs(a - b) % 12; return Math.min(d, 12 - d); }

/* relation between key a -> key b */
function keyRelation(ka, kb) {
  const a = parseKey(ka), b = parseKey(kb);
  if (!a || !b) return { label: '—', tone: 'neutral' };
  if (a.num === b.num && a.letter === b.letter) return { label: 'PERFECT', tone: 'smooth' };
  if (a.num === b.num && a.letter !== b.letter) return { label: 'RELATIVE', tone: 'smooth' };
  const d = circDist(a.num, b.num);
  if (a.letter === b.letter && d === 1) return { label: 'SMOOTH',  tone: 'smooth' };
  if (a.letter === b.letter && d === 2) return { label: 'ENERGY',  tone: 'energy' };
  const fwd = (b.num - a.num + 12) % 12;
  if (a.letter === b.letter && (fwd === 7 || fwd === 5)) return { label: 'BOOST', tone: 'energy' };
  return { label: 'CLASH', tone: 'clash' };
}

/* bpm delta, folding half/double time */
function bpmDelta(a, b) {
  let bb = b;
  while (bb < a * 0.75) bb *= 2;
  while (bb > a * 1.5) bb /= 2;
  return Math.round(bb - a);
}

const TONE = {
  smooth:  { color: 'var(--smooth)', bg: 'rgba(56,224,196,0.12)',  bd: 'rgba(56,224,196,0.32)' },
  energy:  { color: 'var(--energy)', bg: 'rgba(255,178,77,0.12)',  bd: 'rgba(255,178,77,0.34)' },
  clash:   { color: 'var(--clash)',  bg: 'rgba(255,93,99,0.12)',   bd: 'rgba(255,93,99,0.34)' },
  neutral: { color: 'var(--faint)',  bg: 'var(--surface-2)',       bd: 'var(--line)' },
};

/* key chip color from Camelot number (the wheel maps to hue) */
function keyVars(el, key) {
  const p = parseKey(key);
  if (!p) return;
  const hue = Math.round(((p.num - 1) / 12) * 360);
  el.style.setProperty('--k-fg', `hsl(${hue} 68% 64%)`);
  el.style.setProperty('--k-bg', `hsl(${hue} 50% 13%)`);
  el.style.setProperty('--k-bd', `hsl(${hue} 42% 30%)`);
}

/* ---- DOM refs ---- */
const $ = id => document.getElementById(id);
const nowHero    = $('nowHero');
const discHole   = $('discHole');
const nowTitle   = $('nowTitle');
const nowArtist  = $('nowArtist');
const nowKeyChip = $('nowKeyChip');
const nowBpmChip = $('nowBpmChip');
const waveEl     = $('wave');
const timeEl     = $('timeElapsed');
const remainEl   = $('timeRemain');
const playBtn    = $('playBtn');
const playIcon   = $('playIcon');
const playLabel  = $('playLabel');
const heartBtn   = $('heartBtn');
const skipWrap   = $('skipWrap');
const skipRing   = $('skipRing');
const skipFlash  = $('skipFlash');
const clearBtn   = $('clearBtn');
const queueList  = $('queueList');
const queueEmpty = $('queueEmpty');
const tabQueue   = $('tabQueue');
const tabLibrary = $('tabLibrary');
const panelQueue = $('panelQueue');
const panelLib   = $('panelLibrary');
const libSearch  = $('librarySearch');
const libList    = $('libraryList');
const libEmpty   = $('libraryEmpty');
const toastCont  = $('toastContainer');
const queueCount = $('queueCount');
const shareBtn   = $('shareBtn');
const qrOverlay  = $('qrOverlay');
const qrClose    = $('qrClose');

/* ---- helpers ---- */
function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmt(sec) { sec = Math.max(0, Math.round(sec)); const m = Math.floor(sec/60); const s = sec%60; return `${m}:${String(s).padStart(2,'0')}`; }

/* ---- Waveform ---- */
const WAVE_BARS = 58;
function genWave(seedStr) {
  let seed = 0; for (const c of seedStr) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const out = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    const t = i / WAVE_BARS;
    const env = 0.45 + 0.55 * Math.sin(t * Math.PI);          // overall envelope
    const beat = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 9)); // pseudo-beats
    const h = env * beat * (0.6 + 0.4 * rnd());
    out.push(Math.max(0.14, Math.min(1, h)));
  }
  return out;
}
function buildWave() {
  waveEl.innerHTML = '';
  waveData.forEach(h => {
    const b = document.createElement('div');
    b.className = 'wave-bar';
    b.style.height = (12 + h * 26) + 'px';
    waveEl.appendChild(b);
  });
}
function paintWave() {
  const ratio = currentTime / nowPlaying.duration;
  const idx = ratio * WAVE_BARS;
  [...waveEl.children].forEach((b, i) => {
    b.classList.toggle('played', i < idx);
    b.classList.toggle('cursor', Math.abs(i - idx) < 0.6);
  });
}
function seekToClientX(clientX) {
  const r = waveEl.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  currentTime = ratio * nowPlaying.duration;
  updateTimes(); paintWave();
}
let scrubbing = false;
waveEl.addEventListener('pointerdown', e => { scrubbing = true; waveEl.setPointerCapture(e.pointerId); seekToClientX(e.clientX); });
waveEl.addEventListener('pointermove', e => { if (scrubbing) seekToClientX(e.clientX); });
waveEl.addEventListener('pointerup',   () => { scrubbing = false; });
waveEl.addEventListener('pointercancel', () => { scrubbing = false; });

function updateTimes() {
  timeEl.textContent = fmt(currentTime);
  remainEl.textContent = '-' + fmt(nowPlaying.duration - currentTime);
}

/* ---- Now playing render ---- */
function renderNow() {
  nowTitle.textContent = nowPlaying.name;
  nowArtist.textContent = nowPlaying.artist;
  nowKeyChip.innerHTML = `<span class="key-dot"></span>${esc(nowPlaying.key)}`;
  keyVars(nowKeyChip, nowPlaying.key);
  nowBpmChip.innerHTML = `<b>${nowPlaying.bpm}</b> BPM`;
  waveData = genWave(nowPlaying.name + nowPlaying.artist);
  buildWave(); paintWave(); updateTimes();
}

/* ---- Play / pause ---- */
const ICON_PLAY  = `<path d="M3 2l11 6.5L3 15V2z" fill="currentColor"/>`;
const ICON_PAUSE = `<rect x="3" y="2" width="3.6" height="13" rx="1.4" fill="currentColor"/><rect x="9.4" y="2" width="3.6" height="13" rx="1.4" fill="currentColor"/>`;
function setPlaying(p) {
  isPlaying = p;
  playIcon.innerHTML = p ? ICON_PAUSE : ICON_PLAY;
  playLabel.textContent = p ? 'PLAYING' : 'PAUSED';
  nowHero.classList.toggle('playing', p);
}
playBtn.addEventListener('click', () => setPlaying(!isPlaying));

/* progress clock */
setInterval(() => {
  if (!isPlaying || scrubbing) return;
  currentTime += 0.5;
  if (currentTime >= nowPlaying.duration) { advance(); return; }
  updateTimes(); paintWave();
}, 500);

/* ---- like ---- */
heartBtn.addEventListener('click', () => {
  liked = !liked;
  heartBtn.classList.toggle('liked', liked);
  if (liked) showToast(`Loved <b>${esc(nowPlaying.name)}</b>`);
});

/* ---- Skip: click → ring sweep confirmation → advance ---- */
const SKIP_MS = 480;
const CIRC = 138.2;
let skipping = false;
function doSkip() {
  if (skipping) return;
  skipping = true;
  skipWrap.classList.add('spinning');
  skipFlash.classList.remove('flash-anim'); void skipFlash.offsetWidth; skipFlash.classList.add('flash-anim');
  // animate the ring filling up as confirmation, then change track
  const start = Date.now();
  (function tick() {
    const p = Math.min((Date.now() - start) / SKIP_MS, 1);
    skipRing.style.strokeDashoffset = CIRC * (1 - p);
    if (p < 1) { requestAnimationFrame(tick); }
    else {
      advance();
      skipRing.style.strokeDashoffset = CIRC;
      skipWrap.classList.remove('spinning');
      skipping = false;
    }
  })();
}
skipWrap.addEventListener('click', doSkip);

/* advance to next queued track */
function advance() {
  if (queue.length === 0) { currentTime = 0; updateTimes(); paintWave(); return; }
  const next = queue.shift();
  nowPlaying = { name: next.name, artist: next.artist, key: next.key, bpm: next.bpm, duration: 178 + (next.id % 7) * 14 };
  currentTime = 0; liked = false; heartBtn.classList.remove('liked');
  setPlaying(true);
  renderNow(); renderQueue();
}

/* ---- Clear queue ---- */
clearBtn.addEventListener('click', () => { queue = []; renderQueue(); });

/* ---- Reset played history (frees those tracks to be requested again) ---- */
$('resetBtn').addEventListener('click', () => { showToast('Played history reset'); });

/* ---- Queue render ---- */
function mixLinkHTML(fromKey, fromBpm, toKey, toBpm) {
  const rel = keyRelation(fromKey, toKey);
  const t = TONE[rel.tone];
  const d = bpmDelta(fromBpm, toBpm);
  const dStr = d === 0 ? 'beat-matched' : `${d > 0 ? '+' : ''}${d} BPM`;
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '=';
  return `<div class="mix-link" style="--ml-color:${t.color};--ml-bg:${t.bg};--ml-bd:${t.bd}">
      <span class="mix-badge">${rel.label}</span>
      <span class="mix-delta">${arrow} ${dStr} · ${esc(fromKey)}→${esc(toKey)}</span>
    </div>`;
}

function renderQueue() {
  const n = queue.length;
  queueCount.textContent = n;
  queueList.innerHTML = '';
  if (n === 0) { queueEmpty.classList.add('visible'); return; }
  queueEmpty.classList.remove('visible');

  // On-deck (first) card + its transition from now playing
  queueList.insertAdjacentHTML('beforeend',
    mixLinkHTML(nowPlaying.key, nowPlaying.bpm, queue[0].key, queue[0].bpm));

  const od = queue[0];
  const odEl = document.createElement('div');
  odEl.className = 'ondeck-card';
  keyVars(odEl, od.key);
  const g0 = GUESTS[od.by] || GUESTS.you;
  odEl.innerHTML = `
    <div class="od-mini-disc"></div>
    <div class="od-info">
      <span class="od-tag">ON DECK · CUED NEXT</span>
      <div class="od-name">${esc(od.name)} <span style="color:var(--dim);font-weight:500">— ${esc(od.artist)}</span></div>
      <div class="od-sub">
        <span class="q-key" style="color:var(--k-fg)">${esc(od.key)}</span>
        <span class="q-dot">·</span><span class="q-bpm">${od.bpm} BPM</span>
        <span class="q-dot">·</span>
        <span class="who" style="background:${g0.color}">${g0.initials}</span>
      </div>
    </div>
    <button class="remove-btn" data-id="${od.id}" aria-label="Remove">×</button>`;
  queueList.appendChild(odEl);

  // remaining tracks = the queue waiting behind the deck
  if (n > 1) {
    queueList.insertAdjacentHTML('beforeend',
      `<div class="queue-divider"><span>QUEUE</span><span class="qd-count">${n - 1}</span></div>`);
  }
  for (let i = 1; i < n; i++) {
    const prev = queue[i - 1], tr = queue[i];
    queueList.insertAdjacentHTML('beforeend', mixLinkHTML(prev.key, prev.bpm, tr.key, tr.bpm));
    const item = document.createElement('div');
    item.className = 'queue-item';
    keyVars(item, tr.key);
    const g = GUESTS[tr.by] || GUESTS.you;
    item.innerHTML = `
      <span class="q-key-rail"></span>
      <div class="q-info">
        <div class="q-name">${esc(tr.name)}</div>
        <div class="q-meta">
          <span class="q-key">${esc(tr.key)}</span>
          <span class="q-dot">·</span><span class="q-bpm">${tr.bpm} BPM</span>
        </div>
      </div>
      <span class="who" style="background:${g.color}">${g.initials}</span>
      <span class="drag-handle">⠿</span>
      <button class="remove-btn" data-id="${tr.id}" aria-label="Remove">×</button>`;
    queueList.appendChild(item);
  }

  queueList.querySelectorAll('.remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id, 10);
      const card = btn.closest('.ondeck-card, .queue-item');
      if (card) card.classList.add('removing');
      setTimeout(() => { queue = queue.filter(t => t.id !== id); renderQueue(); }, 220);
    });
  });
}

/* ---- Library render ---- */
function renderLibrary(filter = '') {
  const q = filter.trim().toLowerCase();
  const visible = q ? LIBRARY.filter(t => t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)) : LIBRARY;
  libList.innerHTML = '';
  if (visible.length === 0) { libEmpty.classList.add('visible'); return; }
  libEmpty.classList.remove('visible');

  visible.forEach(tr => {
    const inQ = queue.some(t => t.name === tr.name && t.artist === tr.artist);
    const item = document.createElement('div');
    item.className = 'lib-item';
    keyVars(item, tr.key);
    item.innerHTML = `
      <span class="lib-key-rail"></span>
      <div class="lib-info">
        <div class="lib-name">${esc(tr.name)}</div>
        <div class="lib-meta">
          <span class="q-key">${esc(tr.key)}</span>
          <span class="q-dot">·</span><span class="q-bpm">${tr.bpm} BPM</span>
        </div>
      </div>
      <button class="add-btn ${inQ ? 'added' : ''}" data-id="${tr.id}">${inQ ? '✓ ADDED' : '+ QUEUE'}</button>`;
    libList.appendChild(item);
  });

  libList.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = parseInt(btn.dataset.id, 10);
      const tr = LIBRARY.find(t => t.id === id);
      if (!tr) return;
      if (queue.some(t => t.name === tr.name && t.artist === tr.artist)) { showToast('Already in the queue'); return; }
      queue.push({ ...tr, id: nextId++, by: 'you' });
      renderQueue(); renderLibrary(libSearch.value);
      showToast(`Added <b>${esc(tr.name)}</b> to the queue`);
    });
  });
}
libSearch.addEventListener('input', () => renderLibrary(libSearch.value));

/* ---- Tabs ---- */
function switchTab(to) {
  const isQ = to === 'queue';
  tabQueue.classList.toggle('active', isQ);
  tabLibrary.classList.toggle('active', !isQ);
  panelQueue.classList.toggle('active', isQ);
  panelLib.classList.toggle('active', !isQ);
}
tabQueue.addEventListener('click', () => switchTab('queue'));
tabLibrary.addEventListener('click', () => switchTab('library'));
$('fabLibrary').addEventListener('click', () => switchTab('library'));

/* ---- Toast ---- */
function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="t-dot"></span><span>${msg}</span>`;
  toastCont.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

/* ---- QR share ---- */
shareBtn.addEventListener('click', () => qrOverlay.classList.add('open'));
qrClose.addEventListener('click', () => qrOverlay.classList.remove('open'));
qrOverlay.addEventListener('click', e => { if (e.target === qrOverlay) qrOverlay.classList.remove('open'); });

/* ---- Rotate (landscape preview) ---- */
const rotateBtn = $('rotateBtn');
if (rotateBtn) rotateBtn.addEventListener('click', () => {
  document.documentElement.classList.toggle('landscape');
});

/* ---- Init ---- */
setPlaying(true);
renderNow();
renderQueue();
renderLibrary();
