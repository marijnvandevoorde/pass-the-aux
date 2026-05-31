/**
 * E2E — the crowd→DJ requester flow end to end. Pins that a crowd
 * request is credited by name in the DJ's queue and on the now-playing
 * card (chip + fullscreen), that the DJ's own adds are NOT credited,
 * and that the DJ's "show queue to crowd" toggle propagates live.
 */
import { test, assert, PHONE } from "./harness.mjs";
import { openMobileDJ, joinCrowd, apiQueue, djAddTracks, text } from "./helpers.mjs";
import { TRACKS } from "./seed.mjs";

test("flow: a crowd request is credited by name in the DJ queue", async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  const sid = await openMobileDJ(page);

  // A guest requests a track (server records `by`); the DJ syncs (~4s).
  const tr = TRACKS[3]; // Saturn
  await apiQueue(sid, { name: tr.title, path: tr.file, bpm: tr.bpm, by: "Mara" });

  await page.waitForFunction(
    () => !!document.querySelector(".ondeck-card .req-name, .queue-item .req-name"),
    { timeout: 8000 },
  );
  const who = await text(page, ".ondeck-card .req-name, .queue-item .req-name");
  assert.equal(who, "Mara", "the on-deck/queued request shows the requester");
});

test("flow: the requested track shows the requester once it is playing", async ({ page }) => {
  await page.setViewportSize(PHONE);
  const sid = await openMobileDJ(page);
  const tr = TRACKS[1]; // Nightcall
  await apiQueue(sid, { name: tr.title, path: tr.file, bpm: tr.bpm, by: "Mara" });

  // wait for the sync to land it on-deck, then start playback (it is queue[0])
  await page.waitForFunction(() => !!document.querySelector(".ondeck-card"), { timeout: 8000 });
  await djAddTracks(page, 1); // nothing playing yet → advance() plays queue[0] (the request)

  await page.waitForFunction(
    () => document.getElementById("nowTitle").textContent.trim() === "Nightcall",
    { timeout: 5000 },
  );
  assert.equal(await text(page, "#nowReq .req-name"), "Mara", "now-playing chip credits the requester");

  await page.click(".now-hero .disc-wrap");
  await page.waitForTimeout(300);
  assert.ok((await text(page, "#npReq")).includes("Mara"), "fullscreen credits the requester");
});

test("flow: the DJ's own library adds are not credited to anyone", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await openMobileDJ(page);
  await djAddTracks(page, 2); // self-added
  const reqNames = await page.$$(".queue-item .req-name, .ondeck-card .req-name");
  assert.equal(reqNames.length, 0, "no requester pill on DJ-added tracks");
});

test("flow: DJ 'show queue to crowd' toggle propagates to the crowd live", async ({ page, context }) => {
  await page.setViewportSize(PHONE);
  const sid = await openMobileDJ(page);

  // a crowd guest on the same session, Up Next visible by default
  const crowd = await context.newPage();
  await crowd.setViewportSize(PHONE);
  await joinCrowd(crowd, sid, "Robin");
  assert.equal(
    await crowd.evaluate(() => document.documentElement.classList.contains("hide-upnext")),
    false,
    "crowd sees Up Next by default",
  );

  // DJ turns it off
  await page.click("#shareBtn");
  await page.waitForTimeout(200);
  await page.click("#upNextToggle");
  await page.waitForTimeout(200);

  // crowd reflects it on its next poll
  await crowd.waitForFunction(
    () => document.documentElement.classList.contains("hide-upnext"),
    { timeout: 12000 },
  );
  assert.ok(true, "crowd hid Up Next after the DJ toggled it off");
});
