/**
 * E2E — Crowd request view (/crowd). Pins the no-bezel mobile layout
 * (centered <=600px on desktop), the first-name gate, requesting a
 * track, voting on Up Next, and the DJ's show-queue session setting.
 */
import { test, assert, PHONE, DESKTOP, BASE_URL } from "./harness.mjs";
import { apiCreateSession, apiQueue, joinCrowd, text } from "./helpers.mjs";
import { TRACKS } from "./seed.mjs";

test("crowd: no phone bezel, uses the .crowd-screen shell", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await apiCreateSession();
  await joinCrowd(page, sid, "Robin");
  for (const sel of [".phone-frame", ".dynamic-island", ".status-bar", ".home-indicator"]) {
    assert.equal(await page.$(sel), null, `${sel} should not exist`);
  }
  assert.ok(await page.$(".crowd-screen"), ".crowd-screen shell exists");
});

test("crowd: centered column capped at 600px on desktop", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  const sid = await apiCreateSession();
  await joinCrowd(page, sid, "Robin");
  const w = await page.evaluate(() => document.querySelector(".crowd-screen").getBoundingClientRect().width);
  assert.equal(Math.round(w), 600, `crowd column capped at 600 (got ${w})`);
});

test("crowd: name gate shows for a new guest, then dismisses on join", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await apiCreateSession();
  await page.goto(`${BASE_URL}/crowd?s=${sid}`);
  await page.waitForSelector("#nameGate");
  assert.equal(
    await page.evaluate(() => document.getElementById("nameGate").classList.contains("dismissed")),
    false,
    "gate is shown for a first-time guest",
  );
  await page.fill("#gateInput", "Robin");
  await page.click("#gateGo");
  await page.waitForTimeout(500);
  assert.ok(
    await page.evaluate(() => document.getElementById("nameGate").classList.contains("dismissed")),
    "gate dismisses after joining",
  );
  assert.equal(await text(page, "#guestName"), "Robin", "header chip shows the name");
});

test("crowd: a returning guest skips the gate", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await apiCreateSession();
  await joinCrowd(page, sid, "Robin"); // sets localStorage + reloads
  assert.ok(
    await page.evaluate(() => document.getElementById("nameGate").classList.contains("dismissed")),
    "gate is already dismissed for a returning guest",
  );
});

test("crowd: requesting a track flips the button", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await apiCreateSession();
  await joinCrowd(page, sid, "Robin");
  await page.click("#tabCrate");
  await page.waitForSelector(".req-btn[data-path]");
  await page.click(".req-btn[data-path]");
  await page.waitForTimeout(500);
  const label = await page.evaluate(() => {
    const b = document.querySelector(".req-btn.pending");
    return b ? b.textContent.trim() : "";
  });
  assert.ok(/SENT|QUEUED/.test(label), `request button flips to a pending state (got "${label}")`);
});

test("crowd: a vote reaches the server, counts per track, survives a reload and can be taken back", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await apiCreateSession();
  const tr = TRACKS[1]; // Nightcall
  await apiQueue(sid, { name: tr.title, path: tr.file, bpm: tr.bpm, by: "Theo" });
  await joinCrowd(page, sid, "Robin");
  await page.waitForSelector(".vote-pill");
  const pillText = () => page.evaluate(() => [...document.querySelectorAll(".vote-pill span")].map((x) => x.textContent).join(" "));
  const serverVotes = async () => (await (await fetch(`${BASE_URL}/api/session?id=${sid}`)).json()).votes;
  assert.equal(await pillText(), "VOTE");
  await page.click(".vote-pill");
  await page.waitForFunction(() => document.querySelector(".vote-pill .vp-count")?.textContent === "1");
  assert.ok(await page.evaluate(() => document.querySelector(".vote-pill").classList.contains("voted")));
  assert.equal(await pillText(), "VOTED 1");
  assert.deepEqual(await serverVotes(), { [tr.file]: 1 });
  // Another guest votes too: the count is everyone's.
  await fetch(`${BASE_URL}/api/session/vote`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: sid, path: tr.file, guest: "otherguest1", on: true }),
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".vote-pill .vp-count")?.textContent === "2");
  assert.equal(await pillText(), "VOTED 2", "the server remembers this guest's vote");
  await page.click(".vote-pill");
  await page.waitForFunction(() => !document.querySelector(".vote-pill").classList.contains("voted"));
  assert.equal(await pillText(), "VOTE 1");
  assert.deepEqual(await serverVotes(), { [tr.file]: 1 });
});

test("crowd: requested track is credited to the requester in Up Next", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await apiCreateSession();
  const tr = TRACKS[2];
  await apiQueue(sid, { name: tr.title, path: tr.file, bpm: tr.bpm, by: "Jules" });
  await joinCrowd(page, sid, "Robin");
  await page.waitForSelector(".queue-item .req-name");
  assert.equal(await text(page, ".queue-item .req-name"), "Jules");
});

test("crowd: showUpNext=false hides the Up Next tab", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await apiCreateSession({ showUpNext: false });
  await joinCrowd(page, sid, "Robin");
  await page.waitForTimeout(300);
  assert.ok(
    await page.evaluate(() => document.documentElement.classList.contains("hide-upnext")),
    "hide-upnext is applied",
  );
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector(".tab-bar")).display),
    "none",
    "the tab bar is hidden",
  );
});
