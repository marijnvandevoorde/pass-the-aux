/**
 * Visual regression test: the mobile DJ, the crowd page, the party screen
 * and the desktop queue panel, compared pixel by pixel with the committed
 * baselines in this folder.
 *
 *   npm run visual-test             # compare; exits 1 when a screen changed
 *   npm run visual-test -- --update # accept the current screens as baselines
 *
 * It seeds test/visual/test.sqlite with the three CC0 demo tracks, starts
 * its own server (auth off, cover lookup off) on VISUAL_PORT (5189), and
 * drives headless Chromium. A changed screen is saved as current-<name>.png
 * next to its baseline, with diff-<name>.png marking the changed pixels.
 *
 * Baselines depend on fonts and rendering: they're made on macOS. Run it
 * locally before and after UI work; it is not a CI gate.
 */
import { chromium } from '../../node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { seed, MUSIC_DIR } from './seed-db.mjs';
import { decodePng } from './png-diff.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(DIR, '../..');
const UPDATE = process.argv.includes('--update');
const PORT = Number(process.env.VISUAL_PORT ?? 5189);
const BASE = `http://localhost:${PORT}`;
/** Share of pixels allowed to differ (antialiasing noise), per screen. */
const MAX_DIFF_RATIO = 0.002;
/** Per-channel difference below which a pixel counts as unchanged. */
const TOLERANCE = 24;
const SESSION = 'visual';

const PHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
};

// ── server ──
async function startServer() {
  const db = seed();
  const child = spawn('node', ['server.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ENV_FILE: '/dev/null',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      MUSIC_DIR,
      SQLITE_PATH: db,
      STORAGE_DRIVER: 'sqlite',
      PUBLIC_BASE_URL: BASE,
      COVER_LOOKUP: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/version`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  if (Date.now() >= deadline) {
    child.kill('SIGKILL');
    throw new Error('server did not start:\n' + log);
  }
  // Let the boot-time library sweep run first: it may rewrite rows.
  await new Promise((r) => setTimeout(r, 3000));
  return child;
}

// ── comparison ──
function encodeDiffPng(width, height, mask) {
  // Grey image with changed pixels in red: enough to spot what moved.
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const o = y * (width * 3 + 1) + 1 + x * 3;
      const hit = mask[y * width + x];
      raw[o] = hit ? 255 : 40;
      raw[o + 1] = hit ? 0 : 40;
      raw[o + 2] = hit ? 0 : 40;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let crcTable;
function crc32(buf) {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const failures = [];
async function check(name, buf) {
  const file = join(DIR, `baseline-${name}.png`);
  const current = join(DIR, `current-${name}.png`);
  const diffFile = join(DIR, `diff-${name}.png`);
  for (const f of [current, diffFile]) if (existsSync(f)) unlinkSync(f);
  if (UPDATE || !existsSync(file)) {
    writeFileSync(file, buf);
    console.log(`  ✓  ${name}: baseline saved`);
    return;
  }
  const a = decodePng(readFileSync(file));
  const b = decodePng(buf);
  if (a.width !== b.width || a.height !== b.height) {
    writeFileSync(current, buf);
    console.log(`  ✗  ${name}: size ${b.width}×${b.height}, baseline ${a.width}×${a.height}`);
    failures.push(name);
    return;
  }
  const mask = new Uint8Array(a.width * a.height);
  let n = 0;
  for (let i = 0, p = 0; i < a.data.length; i += 4, p++) {
    if (
      Math.abs(a.data[i] - b.data[i]) > TOLERANCE ||
      Math.abs(a.data[i + 1] - b.data[i + 1]) > TOLERANCE ||
      Math.abs(a.data[i + 2] - b.data[i + 2]) > TOLERANCE
    ) { mask[p] = 1; n++; }
  }
  const ratio = n / (a.width * a.height);
  if (ratio <= MAX_DIFF_RATIO) {
    console.log(`  ✓  ${name}${n ? ` (${n} px noise)` : ''}`);
    return;
  }
  writeFileSync(current, buf);
  writeFileSync(diffFile, encodeDiffPng(a.width, a.height, mask));
  console.log(`  ✗  ${name}: ${n} px changed (${(ratio * 100).toFixed(2)} %), see current-${name}.png / diff-${name}.png`);
  failures.push(name);
}

/** Screenshot without moving parts: animations off, caret hidden, and the
 *  given selectors masked (clocks, toasts). */
async function shot(target, page, mask = []) {
  return target.screenshot({
    animations: 'disabled',
    caret: 'hide',
    mask: mask.map((s) => page.locator(s)),
    maskColor: '#ff00ff',
  });
}

/** Toasts come and go on a timer: wait until none is showing. */
const noToasts = (page) => page.waitForFunction(
  () => (document.getElementById('toastContainer')?.childElementCount ?? 0) === 0,
  null,
  { timeout: 8000 },
);

/** Wait until the waveform holds real levels (not the loading pulse). */
const waveReady = (page, sel) => page.waitForFunction(
  (s) => {
    const el = document.querySelector(s);
    return el && !el.classList.contains('wave-loading') && !el.classList.contains('wave-empty');
  },
  sel,
  { timeout: 10000 },
);

/** Pause whichever <audio> deck plays and park it at `sec`. */
const parkMobile = (page, sec) => page.evaluate(async (t) => {
  for (const d of [document.getElementById('deckA'), document.getElementById('deckB')]) {
    if (d && d.src && !d.paused) {
      d.pause();
      d.currentTime = t;
      await new Promise((r) => d.addEventListener('timeupdate', r, { once: true }));
    }
  }
}, sec);

/** A browser context that only talks to the test server: no Google
 *  Fonts, no tag manager, so screens don't depend on the network. */
async function newContext(browser, opts) {
  const ctx = await browser.newContext(opts);
  await ctx.route((url) => !url.href.startsWith(BASE), (route) => route.abort());
  return ctx;
}

// ── screens ──
async function run() {
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required', '--font-render-hinting=none'],
  });
  try {
    console.log(`\nVisual test @ ${BASE}${UPDATE ? '  (updating baselines)' : ''}\n`);

    // Mobile DJ ─────────────────────────────────────────────
    const phone = await newContext(browser, PHONE);
    await phone.addInitScript((sid) => {
      try {
        if (!sessionStorage.getItem('visual-init')) {
          sessionStorage.setItem('visual-init', '1');
          localStorage.clear();
          localStorage.setItem('sv-consent', 'denied');
          localStorage.setItem('pta-mobile-session', sid);
        }
      } catch { /* ignore */ }
    }, SESSION);
    const m = await phone.newPage();
    await m.goto(`${BASE}/mobile`, { waitUntil: 'networkidle' });
    await m.waitForSelector('#libraryList .add-btn');
    await noToasts(m);
    await check('mobile-01-empty', await shot(m, m));

    await m.click('#tabLibrary');
    await noToasts(m);
    await check('mobile-02-library', await shot(m, m));

    // Queue all three: the first starts, two wait (ON DECK + queue).
    for (let i = 0; i < 3; i++) await m.locator('#libraryList .add-btn:not(.added)').first().click();
    await m.click('#tabQueue');
    await waveReady(m, '#wave');
    await parkMobile(m, 30);
    await noToasts(m);
    await check('mobile-03-set', await shot(m, m));

    await m.click('#nowHero .disc-wrap');
    await waveReady(m, '#npWave');
    await noToasts(m);
    await check('mobile-04-now-playing', await shot(m, m));
    await m.click('#npCollapse');

    // Let a sync carry the playhead and queue to the server, then reload:
    // the set must come back as it was (cued at 0:30, paused).
    await m.waitForTimeout(4500);
    await m.reload({ waitUntil: 'networkidle' });
    await m.waitForFunction(() => document.getElementById('nowTitle')?.textContent !== '—', null, { timeout: 8000 });
    await waveReady(m, '#wave');
    await m.waitForFunction(() => document.getElementById('timeElapsed')?.textContent === '0:30', null, { timeout: 8000 });
    await noToasts(m);
    await check('mobile-05-restored', await shot(m, m));

    // Crowd (phone) ─────────────────────────────────────────
    const guest = await newContext(browser, PHONE);
    await guest.addInitScript(() => {
      try {
        localStorage.setItem('sv-consent', 'denied');
        localStorage.setItem('pta-guest-name', 'Robin');
      } catch { /* ignore */ }
    });
    const c = await guest.newPage();
    await c.goto(`${BASE}/crowd?s=${SESSION}`, { waitUntil: 'networkidle' });
    await waveReady(c, '#wave');
    await c.waitForSelector('#queueList .queue-item');
    await noToasts(c);
    await check('crowd-01-now-and-up-next', await shot(c, c));

    // Party screen (laptop on the TV) ───────────────────────
    const tv = await newContext(browser, { viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await tv.addInitScript(() => {
      try {
        localStorage.setItem('sv-consent', 'denied');
        localStorage.setItem('pta-guest-name', 'Party');
      } catch { /* ignore */ }
    });
    const p = await tv.newPage();
    await p.goto(`${BASE}/crowd?s=${SESSION}`, { waitUntil: 'networkidle' });
    await p.click('#nowHero');
    await waveReady(p, '#npWave');
    await p.waitForSelector('#npJoinQr svg');
    await noToasts(p);
    await check('party-01-screen', await shot(p, p));

    // Desktop: queue panel with the pinned NEXT row ─────────
    const desk = await newContext(browser, { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
    await desk.addInitScript(() => {
      try {
        if (!sessionStorage.getItem('visual-init')) {
          sessionStorage.setItem('visual-init', '1');
          localStorage.clear();
          localStorage.setItem('sv-consent', 'denied');
        }
      } catch { /* ignore */ }
    });
    const d = await desk.newPage();
    await d.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await d.click('#start-btn', { force: true });
    await d.waitForSelector('#track-list .row');
    const rows = d.locator('#track-list .row');
    await rows.nth(0).locator('[data-act="A"]').click();
    await d.waitForFunction(() => document.querySelector('.deck[data-deck="A"] .track-name')?.textContent.trim() !== '— no track —');
    await d.click('.deck[data-deck="A"] .play');
    await rows.nth(1).locator('[data-act="Q"]').click();
    await rows.nth(2).locator('[data-act="Q"]').click();
    await d.click('#am-toggle');
    await d.waitForSelector('#queue-list .q-next', { timeout: 10000 });
    await d.waitForFunction(() => !document.querySelector('#queue-list .q-next')?.textContent.includes('loading'));
    await d.click('.deck[data-deck="A"] .play'); // pause: the countdown stops
    await check('desktop-01-queue-next', await shot(d.locator('#queue-side'), d, ['#am-countdown', '#app-version']));
  } finally {
    await browser.close();
    server.kill('SIGKILL');
  }

  if (failures.length) {
    console.error(`\n${failures.length} screen(s) changed. If that was intended: npm run visual-update\n`);
    process.exit(1);
  }
  console.log('\nAll screens match.\n');
}

run().catch((e) => { console.error(e); process.exit(1); });
