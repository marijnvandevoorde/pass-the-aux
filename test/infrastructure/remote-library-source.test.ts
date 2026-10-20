import test from "node:test";
import assert from "node:assert/strict";
import { RemoteLibrarySource } from "../../src/infrastructure/remote-library-source.ts";

type Route = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fake `fetch` answering by path; records the Authorization header. */
function fakeFetch(routes: Record<string, Route>) {
  const auths: string[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    auths.push(String((init?.headers as Record<string, string> | undefined)?.Authorization));
    const route = routes[url.pathname];
    if (!route) return new Response("not found", { status: 404 });
    return route(url, init);
  }) as typeof fetch;
  return { impl, auths };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function source(fetchImpl: typeof fetch, baseUrl = "http://nas.local:3000") {
  return new RemoteLibrarySource({ id: "r1", displayName: "NAS", baseUrl, secret: "s3", fetchImpl });
}

const track = (thumbnail: string | null) => ({
  id: "t1",
  title: "Song",
  performer: { name: "Artist" },
  album: { title: "Album", image: { thumbnail } },
  duration: 200,
  streamable: true,
});

test("check: status with tracks and the secret", async () => {
  const f = fakeFetch({
    "/api/status": () => json({ success: true, data: { tracks: 1234, scanning: false, lastError: null } }),
  });
  const r = await source(f.impl).check();
  assert.deepEqual(r, { ok: true, message: "Connected · 1234 tracks", tracks: 1234, indexing: false });
  assert.equal(f.auths[0], "Bearer s3");
});

test("check: still indexing, and the server's own warning", async () => {
  const scanning = fakeFetch({
    "/api/status": () => json({ success: true, data: { tracks: 10, scanning: true } }),
  });
  const a = await source(scanning.impl).check();
  assert.equal(a.indexing, true);
  assert.match(a.message, /still indexing/);

  const empty = fakeFetch({
    "/api/status": () =>
      json({ success: true, data: { tracks: 0, scanning: false, lastError: "no audio files found in /music" } }),
  });
  assert.match((await source(empty.impl).check()).message, /the server says: no audio files found/);
});

test("check: the remote's error text for a wrong secret", async () => {
  const f = fakeFetch({
    "/api/status": () =>
      json({ success: false, error: "wrong secret: it must match REMOTE_SECRET on the Pass the Remote server" }, 401),
  });
  const r = await source(f.impl).check();
  assert.equal(r.ok, false);
  assert.match(r.message, /^wrong secret/);
});

test("check: an older remote without /api/status is tested with a search", async () => {
  const ok = fakeFetch({
    "/api/status": () => json({ success: false, error: "unknown endpoint" }, 404),
    "/api/get-music": () => json({ success: true, data: { tracks: { items: [track(null)], total: 42 } } }),
  });
  const r = await source(ok.impl).check();
  assert.equal(r.ok, true);
  assert.match(r.message, /doesn't report its status.*42 tracks/);

  const wrong = fakeFetch({
    "/api/status": () => json({ success: false, error: "unknown endpoint" }, 404),
    "/api/get-music": () => json({ success: false, error: "unauthorized" }, 401),
  });
  assert.deepEqual(await source(wrong.impl).check(), {
    ok: false, message: "unauthorized", tracks: null, indexing: false,
  });
});

test("check: a URL that isn't a remote at all says to check it", async () => {
  const f = fakeFetch({}); // every path: plain-text 404
  const r = await source(f.impl).check();
  assert.equal(r.ok, false);
  assert.match(r.message, /check the base URL/);
});

test("check: unreachable server gives the cause from #50", async () => {
  const impl = (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
  }) as typeof fetch;
  const r = await source(impl).check();
  assert.deepEqual(r, {
    ok: false,
    message: "can't reach nas.local:3000 (connection refused — is the server running?)",
    tracks: null,
    indexing: false,
  });
});

test("search: covers on the remote's own host are fetched through the source", async () => {
  const f = fakeFetch({
    "/api/get-music": () =>
      json({
        success: true,
        data: {
          tracks: {
            items: [
              track("http://nas.local:3000/api/cover?track_id=t1"),
              { ...track("https://cdn.example/a.jpg"), id: "t2" },
            ],
            total: 2,
          },
        },
      }),
  });
  const page = await source(f.impl).search("song");
  assert.equal(page.items[0]?.coverViaSource, true);
  assert.equal(page.items[1]?.coverViaSource, undefined);
  assert.equal(page.items[1]?.coverUrl, "https://cdn.example/a.jpg");
});

test("cover: raster images only, with the secret", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const f = fakeFetch({
    "/api/cover": (url) =>
      url.searchParams.get("track_id") === "svg"
        ? new Response("<svg/>", { headers: { "Content-Type": "image/svg+xml" } })
        : url.searchParams.get("track_id") === "none"
          ? json({ success: false, error: "no cover for this track" }, 404)
          : new Response(png, { headers: { "Content-Type": "image/png" } }),
  });
  const src = source(f.impl);
  const ok = await src.cover("t1");
  assert.equal(ok?.mime, "image/png");
  assert.deepEqual(ok?.data, png);
  assert.equal(f.auths[0], "Bearer s3");
  assert.equal(await src.cover("svg"), null);
  assert.equal(await src.cover("none"), null);
});
