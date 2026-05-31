/** Shared page + API helpers for the E2E specs. */
import { BASE_URL } from "./harness.mjs";

// ── API (drives the server directly, no page) ──
export async function apiCreateSession(config = {}) {
  const r = await fetch(`${BASE_URL}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: { automix: false, autoFill: false, beatSync: false, fadeSeconds: 4, showUpNext: true, ...config } }),
  });
  return (await r.json()).id;
}

export async function apiQueue(sid, { name, path, bpm = null, by = null }) {
  const r = await fetch(`${BASE_URL}/api/session/queue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: sid, name, path, bpm, by }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

// ── Mobile DJ page ──
export async function openMobileDJ(page) {
  await page.goto(`${BASE_URL}/mobile`, { waitUntil: "networkidle" });
  await page.waitForSelector("#nowHero");
  // session create + library fetch settle
  await page.waitForFunction(() => !!localStorage.getItem("pta-mobile-session"), { timeout: 5000 });
  await page.waitForFunction(() => document.querySelectorAll("#libraryList .lib-item").length > 0 || true);
  return page.evaluate(() => localStorage.getItem("pta-mobile-session"));
}

export async function djAddTracks(page, n = 1) {
  await page.click("#tabLibrary");
  await page.waitForSelector(".lib-item .add-btn");
  for (let i = 0; i < n; i++) {
    await page.waitForSelector(".add-btn:not(.added)");
    const before = await page.$$eval(".add-btn.added", (els) => els.length);
    await page.click(".add-btn:not(.added)");
    // wait for the add to register (library re-renders the button as ✓ ADDED)
    await page.waitForFunction(
      (b) => document.querySelectorAll(".add-btn.added").length > b,
      before,
      { timeout: 5000 },
    );
  }
  await page.click("#tabQueue");
  await page.waitForTimeout(150);
}

// ── Crowd page ──
export async function joinCrowd(page, sid, name = "Robin") {
  await page.goto(`${BASE_URL}/crowd?s=${sid}`);
  await page.evaluate((n) => localStorage.setItem("pta-guest-name", n), name);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("#nowHero");
  await page.waitForTimeout(400);
}

export async function text(page, sel) {
  return (await page.textContent(sel))?.trim() ?? "";
}

export async function isHidden(page, sel) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
  }, sel);
}
