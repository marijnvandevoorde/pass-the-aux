/**
 * Mobile visual smoke test.
 *
 * Usage:
 *   # First run — saves baseline PNGs next to this file:
 *   npm run visual-test
 *
 *   # Subsequent runs — diffs against saved baselines, exits 1 if anything
 *   # changed beyond the threshold (10 pixels by default):
 *   npm run visual-test
 *
 * The server must be running on localhost:5174 before invoking this.
 * Start it with:  MUSIC_DIR=./music SQLITE_PATH=./data/dev.sqlite \
 *                 REGISTRATION_OPEN=on SESSION_SECRET=devsecretXXXXXXXXX \
 *                 node server.ts
 *
 * To update baselines after an intentional UI change:
 *   npm run visual-test -- --update
 */

import { chromium } from '../../node_modules/playwright/index.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = dirname(fileURLToPath(import.meta.url));
const UPDATE = process.argv.includes('--update');
const THRESHOLD = 10; // max differing pixels before failure
const BASE_URL = process.env.PTA_URL ?? 'http://localhost:5174';

const CHROME = (() => {
  // Try common macOS playwright cache location first; fall back to PATH
  const mac = '/Users/' + (process.env.USER ?? 'user') +
    '/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64' +
    '/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  return existsSync(mac) ? mac : undefined;
})();

async function run() {
  const browser = await chromium.launch({ headless: true, executablePath: CHROME });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
  });
  const page = await ctx.newPage();
  const failures = [];

  async function snap(name, action) {
    if (action) await action();
    await page.waitForTimeout(800);
    const buf = await page.screenshot();
    const file = join(DIR, `baseline-${name}.png`);
    if (!existsSync(file) || UPDATE) {
      writeFileSync(file, buf);
      console.log(`  ✓  saved baseline: ${name}`);
    } else {
      const baseline = readFileSync(file);
      // Quick hash comparison — identical = pass; different = warn but don't
      // fail on CI without pixelmatch available. Install pixelmatch for
      // pixel-level diffing: npm i -D pixelmatch pngjs
      const h1 = createHash('sha256').update(buf).digest('hex');
      const h2 = createHash('sha256').update(baseline).digest('hex');
      if (h1 === h2) {
        console.log(`  ✓  ${name}: unchanged`);
      } else {
        // Save the current screenshot next to baseline for inspection
        writeFileSync(join(DIR, `current-${name}.png`), buf);
        console.log(`  ✗  ${name}: CHANGED — see current-${name}.png`);
        failures.push(name);
      }
    }
  }

  console.log(`\nVisual smoke: ${BASE_URL}  (390×844, iPhone UA)\n`);

  await page.goto(BASE_URL);
  await page.waitForLoadState('networkidle');

  // If auth is enabled the server redirects to /login — handle it.
  if (page.url().includes('/login')) {
    const user = process.env.PTA_USER ?? 'demo';
    const pass = process.env.PTA_PASS ?? 'demodemo';
    await page.fill('#li-user', user);
    await page.fill('#li-pass', pass);
    await page.click('#li-go');
    await page.waitForLoadState('networkidle');
  }

  await snap('01-start-overlay');

  await page.locator('#start-btn').click({ force: true });
  // Wait for the start overlay to vanish before interacting with what's beneath
  await page.waitForSelector('#start-overlay', { state: 'hidden', timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await snap('02-main-library');

  await snap('03-share-qr', async () => {
    await page.locator('#session-share').click();
    await page.waitForTimeout(1000);
  });

  await snap('04-qr-closed', async () => {
    await page.locator('#qr-close').click();
    await page.waitForTimeout(400);
  });

  await browser.close();

  if (failures.length) {
    console.error(`\n${failures.length} screen(s) changed. Run with --update to accept.\n`);
    process.exit(1);
  } else {
    console.log('\nAll screens OK.\n');
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
