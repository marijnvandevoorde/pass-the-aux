import test from "node:test";
import assert from "node:assert/strict";
import {
  JamendoSource,
  mapTrack,
} from "../../src/infrastructure/jamendo-source.ts";

/** Build a fake fetch that records calls and returns a fixed Response. */
function fakeFetch(
  responses: Array<{
    status?: number;
    json?: unknown;
    body?: string;
    contentType?: string;
  }>,
): {
  fn: typeof fetch;
  calls: URL[];
} {
  const calls: URL[] = [];
  let i = 0;
  const fn = (async (input: URL | string | Request) => {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : new URL(input.url);
    calls.push(url);
    const r = responses[i++];
    if (!r) throw new Error("unexpected extra fetch call");
    const headers = new Headers({
      "content-type": r.contentType ?? "application/json",
    });
    const body =
      r.body !== undefined
        ? r.body
        : r.json !== undefined
          ? JSON.stringify(r.json)
          : "";
    return new Response(body, { status: r.status ?? 200, headers });
  }) as typeof fetch;
  return { fn, calls };
}

test("jamendo: mapTrack pulls the audio URL + cover", () => {
  const t = mapTrack({
    id: "12345",
    name: "Song",
    duration: 234,
    artist_name: "Artist",
    album_name: "Album",
    album_image: "https://i/album.jpg",
    image: "https://i/track.jpg",
    audio: "https://cdn/track.mp3",
  });
  assert.equal(t.remoteId, "12345");
  assert.equal(t.title, "Song");
  assert.equal(t.artist, "Artist");
  assert.equal(t.album, "Album");
  assert.equal(t.coverUrl, "https://i/album.jpg"); // album wins
  assert.equal(t.durationSec, 234);
  assert.equal(t._audio, "https://cdn/track.mp3");
});

test("jamendo: search hits /v3.0/tracks/ with client_id + paginates by offset", async () => {
  const { fn, calls } = fakeFetch([
    {
      json: {
        headers: { status: "success", code: 0 },
        results: [
          {
            id: "1",
            name: "A",
            duration: 100,
            artist_name: "X",
            album_name: "Y",
            audio: "https://cdn/a.mp3",
          },
          {
            id: "2",
            name: "B",
            duration: 200,
            artist_name: "X",
            album_name: "Y",
            audio: "https://cdn/b.mp3",
          },
        ],
      },
    },
  ]);
  const src = new JamendoSource({
    id: "row1",
    displayName: "Jam",
    clientId: "MYID",
    fetchImpl: fn,
  });
  const page = await src.search("test", 20);
  assert.equal(page.items.length, 2);
  assert.equal(page.offset, 20);
  assert.equal(page.items[0]?.title, "A");
  assert.equal(page.items[1]?.remoteId, "2");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.host, "api.jamendo.com");
  assert.equal(calls[0]!.searchParams.get("client_id"), "MYID");
  assert.equal(calls[0]!.searchParams.get("offset"), "20");
  assert.equal(calls[0]!.searchParams.get("search"), "test");
});

test("jamendo: full pages hint at more results, partial pages don't", async () => {
  const tracks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: String(i + 1),
      name: `T${i + 1}`,
      duration: 100,
      artist_name: "X",
      album_name: "Y",
      audio: `https://cdn/${i + 1}.mp3`,
    }));
  const { fn } = fakeFetch([
    { json: { headers: { status: "success" }, results: tracks(10) } },
    { json: { headers: { status: "success" }, results: tracks(4) } },
  ]);
  const src = new JamendoSource({
    id: "r", displayName: "J", clientId: "ID", fetchImpl: fn,
  });
  const full = await src.search("q", 0);
  // 10 items + the "+1 there's more" hint.
  assert.equal(full.total, 11);
  const tail = await src.search("q", 10);
  assert.equal(tail.total, 14);
});

test("jamendo: enabled flips with the client_id", () => {
  const enabled = new JamendoSource({
    id: "r", displayName: "J", clientId: "ID",
    fetchImpl: (async () => new Response()) as typeof fetch,
  });
  assert.equal(enabled.enabled, true);
  const off = new JamendoSource({
    id: "r", displayName: "J", clientId: null,
    fetchImpl: (async () => new Response()) as typeof fetch,
  });
  assert.equal(off.enabled, false);
});

test("jamendo: download streams the cached audio URL with the right CT", async () => {
  const { fn, calls } = fakeFetch([
    {
      json: {
        headers: { status: "success" },
        results: [
          {
            id: "42",
            name: "Track",
            duration: 100,
            artist_name: "X",
            album_name: "Y",
            audio: "https://cdn/42.mp3",
          },
        ],
      },
    },
    {
      // The audio fetch.
      body: "FAKEMP3BYTES",
      contentType: "audio/mpeg",
    },
  ]);
  const src = new JamendoSource({
    id: "r", displayName: "J", clientId: "ID", fetchImpl: fn,
  });
  await src.search("x");
  const audio = await src.download("42");
  assert.equal(audio.contentType, "audio/mpeg");
  assert.equal(audio.ext, "mp3");
  // Second call is the audio URL (not the API).
  assert.equal(calls[1]?.toString(), "https://cdn/42.mp3");
});

test("jamendo: download falls back to a lookup when cache misses", async () => {
  const { fn, calls } = fakeFetch([
    {
      // The lookup-by-id call.
      json: {
        headers: { status: "success" },
        results: [{ id: "99", audio: "https://cdn/99.mp3" }],
      },
    },
    { body: "BYTES", contentType: "audio/mpeg" },
  ]);
  const src = new JamendoSource({
    id: "r", displayName: "J", clientId: "ID", fetchImpl: fn,
  });
  const audio = await src.download("99");
  assert.equal(audio.contentType, "audio/mpeg");
  assert.equal(calls[0]!.searchParams.get("id"), "99");
  assert.equal(calls[1]?.toString(), "https://cdn/99.mp3");
});

test("jamendo: API-level errors surface as RemoteSourceError", async () => {
  const { fn } = fakeFetch([
    {
      json: {
        headers: {
          status: "failed",
          code: 6,
          error_message: "invalid client_id",
        },
        results: [],
      },
    },
  ]);
  const src = new JamendoSource({
    id: "r", displayName: "J", clientId: "BOGUS", fetchImpl: fn,
  });
  await assert.rejects(
    () => src.search("hi"),
    /invalid client_id/,
  );
});
