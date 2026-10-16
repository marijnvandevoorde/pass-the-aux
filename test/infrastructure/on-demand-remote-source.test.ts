import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import {
  OnDemandRemoteSource,
  pointsAt,
  type WarmableLease,
} from "../../src/infrastructure/on-demand-remote-source.ts";
import { RemoteSourceError, RemoteStartingError } from "../../src/domain/errors.ts";
import type { RemoteSource } from "../../src/domain/ports/remote-source.ts";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A lease whose start takes `startMs`; counts holds and calls. */
function fakeLease(startMs = 0, fail?: Error) {
  const l = {
    holders: 0,
    warmed: 0,
    lostCount: 0,
    async acquire() {
      l.holders++;
      await wait(startMs);
      if (fail) {
        l.holders--;
        throw fail;
      }
    },
    release() {
      l.holders--;
    },
    lost() {
      l.lostCount++;
    },
    warm() {
      l.warmed++;
    },
  };
  return l satisfies WarmableLease;
}

function fakeRemote(over: Partial<RemoteSource> = {}): RemoteSource {
  return {
    id: "row-1",
    displayName: "Spotify",
    enabled: true,
    async search(_q, offset = 0) {
      return { items: [], total: 0, offset };
    },
    async download() {
      return {
        stream: Readable.from([Buffer.from("abc")]),
        contentType: "audio/mp4",
        ext: "m4a",
        size: 3,
      };
    },
    ...over,
  };
}

test("a call waits for a short start and then goes through, holding the server meanwhile", async () => {
  const lease = fakeLease(10);
  let heldDuringCall = 0;
  const src = new OnDemandRemoteSource(
    fakeRemote({
      async search(_q, offset = 0) {
        heldDuringCall = lease.holders;
        return { items: [], total: 7, offset };
      },
    }),
    lease,
    1000,
  );
  const page = await src.search("daft punk");
  assert.equal(page.total, 7);
  assert.equal(heldDuringCall, 1);
  assert.equal(lease.holders, 0);
  assert.equal(src.id, "row-1");
  assert.equal(src.displayName, "Spotify");
  assert.equal(src.enabled, true);
});

test("a start that takes too long answers 'starting up' and the start carries on", async () => {
  const lease = fakeLease(80);
  let searched = false;
  const src = new OnDemandRemoteSource(
    fakeRemote({
      async search(_q, offset = 0) {
        searched = true;
        return { items: [], total: 0, offset };
      },
    }),
    lease,
    10,
  );
  await assert.rejects(src.search("x"), (e: unknown) =>
    e instanceof RemoteStartingError && /Spotify is starting up, try again/.test(e.message),
  );
  assert.equal(searched, false);
  assert.equal(lease.holders, 1); // the start still holds it…
  await wait(120);
  assert.equal(lease.holders, 0); // …and hands it back once ready
});

test("a start that fails is reported as is", async () => {
  const lease = fakeLease(0, new RemoteSourceError("spotify-api: last start failed, backing off"));
  const src = new OnDemandRemoteSource(fakeRemote(), lease, 1000);
  await assert.rejects(src.search("x"), RemoteSourceError);
  assert.equal(lease.holders, 0);
});

test("a failing call releases the server and marks it for a health check", async () => {
  const lease = fakeLease();
  const src = new OnDemandRemoteSource(
    fakeRemote({
      async search() {
        throw new RemoteSourceError("request failed: ECONNREFUSED");
      },
      async download() {
        throw new RemoteSourceError("request failed: ECONNREFUSED");
      },
    }),
    lease,
    1000,
  );
  await assert.rejects(src.search("x"), RemoteSourceError);
  await assert.rejects(src.download("id"), RemoteSourceError);
  assert.equal(lease.holders, 0);
  assert.equal(lease.lostCount, 2);
});

test("a download holds the server until its stream is read", async () => {
  const lease = fakeLease();
  const src = new OnDemandRemoteSource(fakeRemote(), lease, 1000);
  const audio = await src.download("track");
  assert.equal(lease.holders, 1);
  const chunks: Buffer[] = [];
  for await (const c of audio.stream) chunks.push(c as Buffer);
  await wait(5);
  assert.equal(Buffer.concat(chunks).toString(), "abc");
  assert.equal(lease.holders, 0);
});

test("prepare() warms the server up", () => {
  const lease = fakeLease();
  new OnDemandRemoteSource(fakeRemote(), lease, 1000).prepare();
  assert.equal(lease.warmed, 1);
});

test("pointsAt matches the service by host and port", () => {
  const svc = "http://spotify-api:8000";
  assert.equal(pointsAt("http://spotify-api:8000", svc), true);
  assert.equal(pointsAt("http://spotify-api:8000/", svc), true);
  assert.equal(pointsAt("http://spotify-api.apps.svc.cluster.local:8000", svc), true);
  assert.equal(pointsAt("http://SPOTIFY-API:8000", svc), true);
  assert.equal(pointsAt("http://spotify-api:3000", svc), false);
  assert.equal(pointsAt("http://spotify-api-2:8000", svc), false);
  assert.equal(pointsAt("http://qbz:3000", svc), false);
  assert.equal(pointsAt("not a url", svc), false);
  assert.equal(pointsAt(null, svc), false);
});
