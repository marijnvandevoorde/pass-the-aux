/**
 * E2E — Desktop workstation (/). A click-through of the main DJ flows:
 * boot past the audio-start overlay, browse/search the library, load a
 * track to a deck and play it, load the second deck, ride the
 * crossfader, open the crowd-join QR, and toggle automix.
 *
 * Uses tiny silent fixture audio — Web Audio decodes it fine headless.
 */
import { test, assert, DESKTOP } from "./harness.mjs";
import { BASE_URL } from "./harness.mjs";
import { text } from "./helpers.mjs";

async function boot(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#start-btn");
  await page.click("#start-btn", { force: true }); // create AudioContext, wire decks, load library
  await page.waitForSelector("#track-list .row", { timeout: 8000 });
}

const deckName = (id) => `.deck[data-deck="${id}"] .track-name`;

test("desktop: boots past the start overlay and lists the library", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await page.waitForSelector("#start-btn");
  assert.ok(await page.$("#start-overlay"), "start overlay present before boot");
  await page.click("#start-btn", { force: true });
  await page.waitForSelector("#track-list .row", { timeout: 8000 });
  assert.equal(await page.$("#start-overlay"), null, "start overlay removed after boot");
  const rows = await page.$$("#track-list .row");
  assert.equal(rows.length, 4, "all four seeded tracks are listed");
});

test("desktop: library search filters the list", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await boot(page);
  await page.fill("#lib-search", "Saturn");
  await page.waitForFunction(() => document.querySelectorAll("#track-list .row").length === 1, { timeout: 4000 });
  assert.ok((await text(page, "#track-list .row .r-name")).includes("Saturn"));
  await page.fill("#lib-search", "");
  await page.waitForFunction(() => document.querySelectorAll("#track-list .row").length === 4, { timeout: 4000 });
});

test("desktop: load a track to Deck A and play it", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await boot(page);
  assert.equal((await text(page, deckName("A"))), "— no track —", "Deck A starts empty");

  await page.click('#track-list .row [data-act="A"]');
  await page.waitForFunction(
    () => document.querySelector('.deck[data-deck="A"] .track-name').textContent.trim() !== "— no track —",
    { timeout: 8000 },
  );
  const loaded = await text(page, deckName("A"));
  assert.ok(loaded.length > 0 && loaded !== "— no track —", `Deck A loaded "${loaded}"`);

  await page.click('.deck[data-deck="A"] .play');
  await page.waitForFunction(
    () => document.querySelector('.deck[data-deck="A"] .play').classList.contains("active"),
    { timeout: 4000 },
  );
  assert.ok((await text(page, '.deck[data-deck="A"] .play')).includes("PAUSE"), "play button shows playing state");
});

test("desktop: load Deck B and ride the crossfader", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await boot(page);
  await page.click('#track-list .row:nth-child(1) [data-act="A"]');
  await page.click('#track-list .row:nth-child(2) [data-act="B"]');
  await page.waitForFunction(
    () => document.querySelector('.deck[data-deck="B"] .track-name').textContent.trim() !== "— no track —",
    { timeout: 8000 },
  );
  assert.notEqual(await text(page, deckName("B")), "— no track —", "Deck B loaded");

  // slam the crossfader to B
  await page.evaluate(() => {
    const x = document.querySelector("#xfader");
    x.value = "1";
    x.dispatchEvent(new Event("input", { bubbles: true }));
  });
  assert.equal(await page.inputValue("#xfader"), "1", "crossfader moved to B");
});

test("desktop: share opens the crowd-join QR with a /crowd link", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await boot(page);
  await page.click("#session-share");
  await page.waitForFunction(() => !document.querySelector("#sessionqr").hidden, { timeout: 5000 });
  const href = await page.getAttribute("#qr-url", "href");
  assert.ok(href && href.includes("/crowd?s="), `QR links to the crowd page (got ${href})`);
});

test("desktop: automix toggles on", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await boot(page);
  const toggle = "#am-toggle";
  assert.ok(await page.evaluate((s) => document.querySelector(s).classList.contains("am-off"), toggle), "automix starts off");
  await page.click(toggle);
  await page.waitForFunction((s) => document.querySelector(s).classList.contains("am-on"), toggle, { timeout: 3000 });
  assert.ok((await text(page, toggle)).includes("ON"), "automix label shows ON");
});
