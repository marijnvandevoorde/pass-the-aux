/**
 * E2E — Mobile DJ view (/mobile). Pins the no-bezel full-page layout,
 * the now-playing hero (cover + key/BPM), the mix-flow queue, the
 * fullscreen expand/close, the QR invite + show-queue toggle, and the
 * landscape layout.
 */
import { test, assert, PHONE, DESKTOP, LANDSCAPE } from "./harness.mjs";
import { openMobileDJ, djAddTracks, text, isHidden } from "./helpers.mjs";

test("mobile-dj: no phone bezel anywhere, just the .screen app shell", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  for (const sel of [".phone-frame", ".dynamic-island", ".status-bar", ".home-indicator"]) {
    assert.equal(await page.$(sel), null, `${sel} should not exist`);
  }
  assert.ok(await page.$(".screen"), ".screen shell should exist");
});

test("mobile-dj: full-bleed on phone, centered column on desktop", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  const phoneW = await page.evaluate(() => document.querySelector(".screen").getBoundingClientRect().width);
  assert.equal(Math.round(phoneW), 390, "phone screen is full width");

  await page.setViewportSize(DESKTOP);
  await page.waitForTimeout(100);
  const deskW = await page.evaluate(() => document.querySelector(".screen").getBoundingClientRect().width);
  assert.ok(deskW <= 460, `desktop screen is a capped column (got ${deskW})`);
  assert.ok(deskW >= 400, `desktop column not collapsed (got ${deskW})`);
});

test("mobile-dj: empty state, then a track plays with cover + key/BPM", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  assert.equal(await text(page, "#nowTitle"), "—", "starts with no track");

  await djAddTracks(page, 1); // library is title-sorted → "Glass Heart" first
  await page.waitForFunction(() => document.getElementById("nowTitle").textContent.trim() === "Glass Heart", { timeout: 4000 });
  assert.equal(await text(page, "#nowKeyLabel"), "12B");
  assert.equal(await text(page, "#nowBpmVal"), "131");

  // cover art points at the API and fades in
  const src = await page.getAttribute("#discCover", "src");
  assert.ok(src && src.includes("/api/cover?path="), "disc cover loads from /api/cover");
  await page.waitForFunction(() => document.getElementById("discCover").classList.contains("loaded"), { timeout: 4000 });
});

test("mobile-dj: queue shows on-deck card + a mix-flow badge", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  await djAddTracks(page, 2); // one plays, one goes on-deck
  await page.waitForSelector(".ondeck-card");
  assert.ok(await page.$(".ondeck-card .od-tag"), "on-deck card labelled");
  assert.ok(await page.$(".mix-link .mix-badge"), "a harmonic transition badge is shown");
});

test("mobile-dj: album tap opens fullscreen; X and grab handle close it", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  await djAddTracks(page, 1);

  const isOpen = () => page.evaluate(() => document.getElementById("npFull").classList.contains("open"));
  // the transport (next button) must NOT open it
  await page.click("#skipWrap").catch(() => {});
  assert.equal(await isOpen(), false, "skip does not open fullscreen");

  await page.click(".now-hero .disc-wrap");
  await page.waitForTimeout(300);
  assert.equal(await isOpen(), true, "tapping the album art opens fullscreen");
  assert.equal(await text(page, "#npTitle"), await text(page, "#nowTitle"), "same track in fullscreen");

  await page.click("#npClose");
  await page.waitForTimeout(300);
  assert.equal(await isOpen(), false, "close X dismisses fullscreen");

  await page.click(".now-hero .disc-wrap");
  await page.waitForTimeout(300);
  await page.click("#npCollapse");
  await page.waitForTimeout(300);
  assert.equal(await isOpen(), false, "grab handle dismisses fullscreen");
});

test("mobile-dj: QR invite overlay + show-queue toggle", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  await page.click("#shareBtn");
  await page.waitForTimeout(300);
  assert.ok(await page.evaluate(() => document.getElementById("qrOverlay").classList.contains("open")), "QR overlay opens");
  assert.ok(await page.$("#qrBox svg"), "a QR code is rendered");

  const checked = () => page.getAttribute("#upNextToggle", "aria-checked");
  const before = await checked();
  await page.click("#upNextToggle");
  await page.waitForTimeout(150);
  assert.notEqual(await checked(), before, "toggle flips state");
});

test("mobile-dj: landscape shows only the now-playing, hides the workspace", async ({ page }) => {
  await page.setViewportSize(LANDSCAPE);
  await openMobileDJ(page);
  assert.equal(await isHidden(page, ".workspace"), true, "workspace hidden in landscape");
  assert.equal(await isHidden(page, ".now-hero"), false, "now-playing visible in landscape");
});

test("mobile-dj: a refresh keeps the queue and the playing track, cued where it was", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  await djAddTracks(page, 3); // one plays, two queued
  const title = await text(page, "#nowTitle");
  await page.evaluate(() => {
    const d = document.getElementById("deckA");
    d.pause();
    d.currentTime = 12;
  });
  await page.waitForFunction(() => {
    const s = JSON.parse(localStorage.getItem("pta-mobile-state") ?? "null");
    return s && s.s.queue.length === 2 && s.s.positionSec >= 11;
  }, null, { timeout: 5000 });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction((t) => document.getElementById("nowTitle").textContent === t, title, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById("timeElapsed").textContent === "0:12", null, { timeout: 8000 });
  assert.equal(await text(page, "#queueCount"), "2", "both queued tracks are back");
  assert.equal(await text(page, "#playLabel"), "PAUSED", "waits for a tap to play");
});

test("mobile-dj: the waveform is the track's real levels from the server", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  const res = page.waitForResponse((r) => r.url().includes("/api/waveform"));
  await djAddTracks(page, 1);
  assert.equal((await res).status(), 200, "waveform fetched for the playing track");
  await page.waitForFunction(() => !document.getElementById("wave").classList.contains("wave-loading"));
  assert.equal(await page.$$eval("#wave .wave-bar", (b) => b.length), 58);
});
