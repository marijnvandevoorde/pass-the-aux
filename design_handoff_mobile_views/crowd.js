/* ============================================================
   Pass the Aux — CROWD page (guest, request-only)
   ============================================================ */
const NAME_KEY = 'pta-guest-name';

/* ---- name → stable color/initials ---- */
const PALETTE = ['#3f72b0', '#8466b0', '#e8862e', '#43c9bd', '#d8567f', '#5aa469', '#c9913a'];
function colorFor(name) {
  let h = 0; for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initialsFor(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ---- Camelot helpers (display only) ---- */
function parseKey(k) { const m = /^(\d{1,2})([AB])$/.exec(k); return m ? { num: +m[1], letter: m[2] } : null; }
function keyVars(el, key) {
  const p = parseKey(key); if (!p) return;
  const hue = Math.round(((p.num - 1) / 12) * 360);
  el.style.setProperty('--k-fg', `hsl(${hue} 68% 64%)`);
  el.style.setProperty('--k-bg', `hsl(${hue} 50% 13%)`);
  el.style.setProperty('--k-bd', `hsl(${hue} 42% 30%)`);
}

/* ---- Data ---- */
let nowPlaying = { name: 'Antidote', artist: 'FILOFIHI', key: '11B', bpm: 133, duration: 211, by: 'Theo' };

let upNext = [
  { id: 1, name: 'Spiral',        artist: 'William Proulx', key: '11B', bpm: 129, by: 'Theo'  },
  { id: 2, name: 'Glass Heart',   artist: 'Aero',           key: '12B', bpm: 131, by: 'Jules' },
  { id: 3, name: 'Nightcall',     artist: 'Kavinsky',       key: '1B',  bpm: 124, by: 'Mara'  },
  { id: 4, name: 'Saturn',        artist: 'Sleeper',        key: '8B',  bpm: 122, by: 'Nadia' },
];

const PLAYED = [
  { id: 90, name: 'Open Eye Signal', artist: 'Jon Hopkins', key: '7A', bpm: 128, by: 'Mara' },
  { id: 91, name: 'Tycho — Awake',   artist: 'Tycho',       key: '9B', bpm: 115, by: 'Jules' },
  { id: 92, name: 'Strobe',          artist: 'deadmau5',    key: '4B', bpm: 128, by: 'Theo' },
];

const CRATE = [
  { id: 101, name: 'Resonance',     artist: 'Home',         key: '10B', bpm: 128 },
  { id: 102, name: 'Tides',         artist: 'Lune',         key: '11A', bpm: 126 },
  { id: 103, name: 'Outrun',        artist: 'Power Glove',  key: '4A',  bpm: 118 },
  { id: 104, name: 'Replica',       artist: 'Sworn',        key: '11B', bpm: 134 },
  { id: 105, name: 'Velvet',        artist: 'Cassø',        key: '2B',  bpm: 140 },
  { id: 106, name: 'Afterglow',     artist: 'Tor',          key: '9B',  bpm: 120 },
  { id: 107, name: 'Midnight City', artist: 'M83',          key: '6A',  bpm: 105 },
  { id: 108, name: 'Cascade',       artist: 'Darn',         key: '12A', bpm: 130 },
  { id: 109, name: 'Lowtide',       artist: 'Bv',           key: '3A',  bpm: 92  },
];

let guest = null;          // { name, color, initials }
let requested = new Set(); // crate ids this guest requested
let isPlaying = true;
let currentTime = 0;
let waveData = [];

/* ---- Voting (one vote per song, per guest) ---- */
const BASE_VOTES = { 1: 4, 2: 2, 3: 6, 4: 1 };   // votes from the rest of the room
let myVotes = new Set();
try { myVotes = new Set(JSON.parse(localStorage.getItem('pta-votes') || '[]')); } catch (e) {}
function displayVotes(id) { return (BASE_VOTES[id] || 0) + (myVotes.has(id) ? 1 : 0); }
function toggleVote(id) {
  if (myVotes.has(id)) myVotes.delete(id); else myVotes.add(id);
  try { localStorage.setItem('pta-votes', JSON.stringify([...myVotes])); } catch (e) {}
}

/* ---- refs ---- */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const fmt = sec => { sec = Math.max(0, Math.round(sec)); return `${Math.floor(sec/60)}:${String(sec%60).padStart(2,'0')}`; };

/* ---- Waveform ---- */
const WAVE_BARS = 56;
function genWave(seedStr) {
  let seed = 0; for (const c of seedStr) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const out = [];
  for (let i = 0; i < WAVE_BARS; i++) {
    const t = i / WAVE_BARS;
    const env = 0.45 + 0.55 * Math.sin(t * Math.PI);
    const beat = 0.6 + 0.4 * Math.abs(Math.sin(t * Math.PI * 9));
    out.push(Math.max(0.14, Math.min(1, env * beat * (0.6 + 0.4 * rnd()))));
  }
  return out;
}
function buildWaves() {
  const small = $('wave'), big = $('npWave');
  [small, big].forEach((el, scale) => {
    el.innerHTML = '';
    waveData.forEach(h => {
      const b = document.createElement('div');
      b.className = 'wave-bar';
      b.style.height = (scale ? 14 + h * 32 : 12 + h * 26) + 'px';
      el.appendChild(b);
    });
  });
}
function paintWaves() {
  const idx = (currentTime / nowPlaying.duration) * WAVE_BARS;
  [$('wave'), $('npWave')].forEach(el => {
    [...el.children].forEach((b, i) => b.classList.toggle('played', i < idx));
  });
  $('timeElapsed').textContent = fmt(currentTime);
  $('timeRemain').textContent = '-' + fmt(nowPlaying.duration - currentTime);
  $('npElapsed').textContent = fmt(currentTime);
  $('npRemain').textContent = '-' + fmt(nowPlaying.duration - currentTime);
}

/* ---- Now playing render ---- */
function renderNow() {
  const by = nowPlaying.by;
  const whoHTML = `<span class="who" style="background:${colorFor(by)}">${initialsFor(by)}</span> requested by ${esc(by)}`;
  $('nowTitle').textContent = nowPlaying.name;
  $('nowArtist').textContent = nowPlaying.artist;
  const kc = $('nowKeyChip'); kc.innerHTML = `<span class="key-dot"></span>${esc(nowPlaying.key)}`; keyVars(kc, nowPlaying.key);
  $('nowBpmChip').innerHTML = `<b>${nowPlaying.bpm}</b> BPM`;
  $('reqBy').innerHTML = whoHTML;

  $('npTitle').textContent = nowPlaying.name;
  $('npArtist').textContent = nowPlaying.artist;
  const nk = $('npKeyChip'); nk.innerHTML = `<span class="key-dot"></span>${esc(nowPlaying.key)}`; keyVars(nk, nowPlaying.key);
  $('npBpmChip').innerHTML = `<b>${nowPlaying.bpm}</b> BPM`;
  $('npReqBy').innerHTML = whoHTML;

  // tint the fullscreen by current key
  const p = parseKey(nowPlaying.key);
  if (p) { const hue = Math.round(((p.num - 1) / 12) * 360); $('npFull').style.setProperty('--np-tint', `hsla(${hue} 70% 55% / 0.22)`); }

  waveData = genWave(nowPlaying.name + nowPlaying.artist);
  buildWaves(); paintWaves();
}

/* progress clock (display only — guest can't control) */
setInterval(() => {
  if (!isPlaying) return;
  currentTime += 0.5;
  if (currentTime >= nowPlaying.duration) advance();
  else paintWaves();
}, 500);

function advance() {
  if (upNext.length === 0) { currentTime = 0; paintWaves(); return; }
  const next = upNext.shift();
  nowPlaying = { ...next, duration: 178 + (next.id % 7) * 14 };
  currentTime = 0;
  renderNow(); renderQueue();
  showToast(`Now playing <b>${esc(nowPlaying.name)}</b>`);
}

/* ---- Up Next (read-only) ---- */
function renderQueue() {
  $('queueCount').textContent = upNext.length;
  const list = $('queueList');
  list.innerHTML = '';
  if (upNext.length === 0) {
    list.innerHTML = `<div class="lib-empty visible" style="padding-top:30px">Nothing queued yet — request something below 👇</div>`;
  }
  upNext.forEach((tr, i) => {
    const el = document.createElement('div');
    el.className = 'queue-item';
    keyVars(el, tr.key);
    const voted = myVotes.has(tr.id);
    el.innerHTML = `
      <span class="q-index">${i + 1}</span>
      <span class="q-key-rail"></span>
      <div class="q-info">
        <div class="q-name">${esc(tr.name)}</div>
        <div class="q-meta">
          <span class="q-key">${esc(tr.key)}</span>
          <span class="q-dot">·</span><span class="q-bpm">${tr.bpm} BPM</span>
          <span class="q-dot">·</span>
          <span class="who" style="background:${colorFor(tr.by)}">${initialsFor(tr.by)}</span>
          <span>${esc(tr.by)}</span>
        </div>
      </div>
      <button class="vote-pill ${voted ? 'voted' : ''}" data-vote="${tr.id}" aria-pressed="${voted}" title="${voted ? 'Remove your vote' : 'Vote for this track'}">
        <svg class="vp-arrow" width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M6 1.5 11 8H1z"/></svg>
        <span>${displayVotes(tr.id)}</span>
      </button>`;
    list.appendChild(el);
  });

  list.querySelectorAll('[data-vote]').forEach(b => {
    b.addEventListener('click', () => {
      const id = +b.dataset.vote;
      const wasVoted = myVotes.has(id);
      toggleVote(id);
      const tr = upNext.find(t => t.id === id);
      renderQueue();
      if (!wasVoted && tr) showToast(`Voted for <b>${esc(tr.name)}</b>`);
    });
  });

  // played section
  const pb = $('playedBody');
  pb.innerHTML = '';
  PLAYED.forEach(tr => {
    const el = document.createElement('div');
    el.className = 'queue-item played-item';
    keyVars(el, tr.key);
    el.innerHTML = `
      <span class="q-key-rail"></span>
      <div class="q-info">
        <div class="q-name">${esc(tr.name)}</div>
        <div class="q-meta"><span class="q-key">${esc(tr.key)}</span><span class="q-dot">·</span><span class="q-bpm">${tr.bpm} BPM</span><span class="q-dot">·</span><span>${esc(tr.by)}</span></div>
      </div>
      <span class="who" style="background:${colorFor(tr.by)}">${initialsFor(tr.by)}</span>`;
    pb.appendChild(el);
  });
}

/* ---- Crate (request) ---- */
function renderCrate(filter = '') {
  const q = filter.trim().toLowerCase();
  const items = q ? CRATE.filter(t => t.name.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)) : CRATE;
  const list = $('crateList');
  list.innerHTML = '';
  $('crateEmpty').classList.toggle('visible', items.length === 0);
  items.forEach(tr => {
    const pending = requested.has(tr.id);
    const queued = upNext.some(t => t.name === tr.name);
    const el = document.createElement('div');
    el.className = 'lib-item';
    keyVars(el, tr.key);
    let btn;
    if (queued) btn = `<button class="req-btn pending" disabled>✓ QUEUED</button>`;
    else if (pending) btn = `<button class="req-btn pending" disabled>SENT</button>`;
    else btn = `<button class="req-btn" data-id="${tr.id}">REQUEST</button>`;
    el.innerHTML = `
      <span class="lib-key-rail"></span>
      <div class="lib-info">
        <div class="lib-name">${esc(tr.name)}</div>
        <div class="lib-meta"><span class="q-key">${esc(tr.key)}</span><span class="q-dot">·</span><span class="q-bpm">${tr.bpm} BPM</span><span class="q-dot">·</span><span>${esc(tr.artist)}</span></div>
      </div>
      ${btn}`;
    list.appendChild(el);
  });
  list.querySelectorAll('.req-btn[data-id]').forEach(b => {
    b.addEventListener('click', () => {
      const id = +b.dataset.id;
      requested.add(id);
      const tr = CRATE.find(t => t.id === id);
      renderCrate($('crateSearch').value);
      showToast(`Requested <b>${esc(tr.name)}</b> — sent to the DJ`);
    });
  });
}

/* ---- Fullscreen now playing ---- */
function openFull() { const f = $('npFull'); f.classList.add('open'); f.classList.toggle('playing', isPlaying); }
function closeFull() { $('npFull').classList.remove('open'); }
$('nowHero').addEventListener('click', openFull);
$('npCollapse').addEventListener('click', closeFull);

/* ---- Tabs ---- */
function switchTab(to) {
  const isQ = to === 'queue';
  $('tabQueue').classList.toggle('active', isQ);
  $('tabCrate').classList.toggle('active', !isQ);
  $('panelQueue').classList.toggle('active', isQ);
  $('panelCrate').classList.toggle('active', !isQ);
}
$('tabQueue').addEventListener('click', () => switchTab('queue'));
$('tabCrate').addEventListener('click', () => switchTab('crate'));
$('fabCrate').addEventListener('click', () => switchTab('crate'));

/* DJ-decided session setting: show Up Next to the crowd (with voting) or not */
window.setCrowdUpNext = function (visible) {
  document.documentElement.classList.toggle('hide-upnext', !visible);
  if (!visible) switchTab('crate');
};

/* played toggle */
$('playedHead').addEventListener('click', () => {
  $('playedHead').classList.toggle('open');
  $('playedBody').classList.toggle('open');
});

/* search */
$('crateSearch').addEventListener('input', () => renderCrate($('crateSearch').value));

/* ---- Toast ---- */
function showToast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="t-dot"></span><span>${msg}</span>`;
  $('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

/* ---- Name gate ---- */
function setGuest(name) {
  guest = { name, color: colorFor(name), initials: initialsFor(name) };
  const av = $('guestAv'); av.textContent = guest.initials; av.style.background = guest.color;
  $('guestName').textContent = guest.name;
}
function dismissGate() {
  $('nameGate').classList.add('dismissed');
}
function openGate() {
  const g = $('nameGate');
  g.classList.remove('dismissed');
  const inp = $('gateInput');
  inp.value = guest ? guest.name : '';
  $('gateGo').disabled = !inp.value.trim();
  setTimeout(() => inp.focus(), 50);
}

const gateInput = $('gateInput'), gateGo = $('gateGo');
gateInput.addEventListener('input', () => { gateGo.disabled = !gateInput.value.trim(); });
gateInput.addEventListener('keydown', e => { if (e.key === 'Enter' && gateInput.value.trim()) submitGate(); });
function submitGate() {
  const name = gateInput.value.trim().slice(0, 24);
  if (!name) return;
  try { localStorage.setItem(NAME_KEY, name); } catch (e) {}
  setGuest(name);
  dismissGate();
  renderQueue(); renderCrate();
}
gateGo.addEventListener('click', submitGate);
$('guestChip').addEventListener('click', openGate);

/* ---- Init ---- */
let saved = null;
try { saved = localStorage.getItem(NAME_KEY); } catch (e) {}
renderNow();
renderQueue();
renderCrate();
if (saved) { setGuest(saved); dismissGate(); }
else { openGate(); }
