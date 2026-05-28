import test from "node:test";
import assert from "node:assert/strict";
import { EnrichLibrary } from "../../src/application/enrich-library.ts";
import { Track } from "../../src/domain/track.ts";
import type { TrackRepository } from "../../src/domain/ports/track-repository.ts";
import type {
  AnalysisRecord,
  AnalysisRepository,
} from "../../src/domain/ports/analysis-repository.ts";
import type { TagReader } from "../../src/domain/ports/tag-reader.ts";

const tr = (id: string): Track =>
  new Track({ id, name: id, dir: "", ext: ".mp3", size: 1, mtime: 2, bpm: null });

function setup(opts: {
  tracks: Track[];
  existing?: Record<string, AnalysisRecord>;
  tags?: TagReader;
}) {
  const db: Record<string, AnalysisRecord> = { ...(opts.existing ?? {}) };
  const analyses: AnalysisRepository = {
    all: async () => db,
    page: async () => ({ items: [], total: 0 }),
    put: async (_u, id, rec) => {
      db[id] = { ...rec, analyzedAt: 1 };
    },
  };
  const tracks: TrackRepository = {
    list: async () => opts.tracks,
    findById: async () => null,
  };
  const tags: TagReader = opts.tags ?? {
    read: async () => null,
    readCover: async () => null,
  };
  return { uc: new EnrichLibrary(tracks, analyses, "u1", tags), db };
}

test("untagged, never-analysed track → row from filename, bpm null", async () => {
  const { uc, db } = setup({ tracks: [tr("Queen - One Vision.mp3")] });
  const r = await uc.execute();
  assert.deepEqual(r, { scanned: 1, enriched: 1 });
  const row = db["Queen - One Vision.mp3"]!;
  assert.equal(row.artist, "Queen");
  assert.equal(row.title, "One Vision");
  assert.equal(row.bpm, null);
});

test("ID3 TBPM/TKEY become the bpm/key fallback", async () => {
  const { uc, db } = setup({
    tracks: [tr("x - y.mp3")],
    tags: {
      read: async () => ({ artist: "A", title: "B", bpm: 128, key: "8A" }),
      readCover: async () => null,
    },
  });
  await uc.execute();
  const row = db["x - y.mp3"]!;
  assert.equal(row.bpm, 128);
  assert.equal(row.key, "8A");
  assert.equal(row.artist, "A");
  assert.equal(row.title, "B");
});

test("a null-bpm row is re-attempted; BpmSource fills it, names kept", async () => {
  const existing = {
    "Queen - One Vision.mp3": {
      bpm: null,
      size: 1,
      mtime: 2,
      analyzedAt: 9,
      artist: "Queen",
      title: "One Vision",
    } as AnalysisRecord,
  };
  const db: Record<string, AnalysisRecord> = { ...existing };
  const analyses: AnalysisRepository = {
    all: async () => db,
    page: async () => ({ items: [], total: 0 }),
    put: async (_u, id, rec) => {
      db[id] = { ...rec, analyzedAt: 1 };
    },
  };
  const tracks: TrackRepository = {
    list: async () => [tr("Queen - One Vision.mp3")],
    findById: async () => null,
  };
  let calls = 0;
  const bpmSource = {
    lookup: async () => {
      calls++;
      return { bpm: 139, key: "Am" };
    },
  };
  const uc = new EnrichLibrary(
    tracks,
    analyses,
    "u1",
    { read: async () => null, readCover: async () => null },
    null,
    null,
    bpmSource,
  );
  const r = await uc.execute();
  assert.deepEqual(r, { scanned: 1, enriched: 1 });
  const row = db["Queen - One Vision.mp3"]!;
  assert.equal(row.bpm, 139);
  assert.equal(row.key, "Am");
  assert.equal(row.artist, "Queen"); // preserved
  assert.equal(row.title, "One Vision");
  assert.equal(calls, 1);
});

test("BpmSource is NOT called when tags already give bpm AND key", async () => {
  const db: Record<string, AnalysisRecord> = {};
  let calls = 0;
  const uc = new EnrichLibrary(
    { list: async () => [tr("x - y.mp3")], findById: async () => null },
    {
      all: async () => ({}),
      page: async () => ({ items: [], total: 0 }),
      put: async (_u, id, rec) => {
        db[id] = { ...rec, analyzedAt: 1 };
      },
    },
    "u1",
    {
      read: async () => ({ artist: "A", title: "B", bpm: 126, key: "5A" }),
      readCover: async () => null,
    },
    null,
    null,
    {
      lookup: async () => {
        calls++;
        return { bpm: 99, key: "1A" };
      },
    },
  );
  await uc.execute();
  assert.equal(db["x - y.mp3"]!.bpm, 126); // from TBPM tag
  assert.equal(db["x - y.mp3"]!.key, "5A"); // from TKEY tag
  assert.equal(calls, 0); // nothing missing → no network
});

test("a FULLY complete row (bpm+key+cover) is left untouched", async () => {
  const existing = {
    "z.mp3": {
      bpm: 174,
      size: 1,
      mtime: 2,
      analyzedAt: 9,
      key: "8A",
      artist: "Set",
      title: "By Client",
    } as AnalysisRecord,
  };
  const db: Record<string, AnalysisRecord> = { ...existing };
  let calls = 0;
  const uc = new EnrichLibrary(
    { list: async () => [tr("z.mp3")], findById: async () => null },
    {
      all: async () => db,
    page: async () => ({ items: [], total: 0 }),
      put: async (_u, id, rec) => {
        db[id] = { ...rec, analyzedAt: 1 };
      },
    },
    "u1",
    {
      read: async () => null,
      // no cover store wired → sidecar requirement vacuously met;
      // bpm+key already set → the row is complete and is skipped.
      readCover: async () => ({ mime: "image/jpeg", data: new Uint8Array([1]) }),
    },
    null,
    null,
    {
      lookup: async () => {
        calls++;
        return { bpm: 1, key: "x" };
      },
    },
  );
  const r = await uc.execute();
  assert.deepEqual(r, { scanned: 1, enriched: 0 });
  assert.equal(db["z.mp3"]!.bpm, 174); // never clobbered
  assert.equal(calls, 0);
});

test("a row WITH bpm but missing cover/key is still completed", async () => {
  const existing = {
    "w.mp3": {
      bpm: 128,
      size: 1,
      mtime: 2,
      analyzedAt: 9,
      artist: "DJ",
      title: "Track",
    } as AnalysisRecord, // has client bpm, no key, no cover
  };
  const db: Record<string, AnalysisRecord> = { ...existing };
  const uc = new EnrichLibrary(
    { list: async () => [tr("w.mp3")], findById: async () => null },
    {
      all: async () => db,
    page: async () => ({ items: [], total: 0 }),
      put: async (_u, id, rec) => {
        db[id] = { ...rec, analyzedAt: 1 };
      },
    },
    "u1",
    { read: async () => null, readCover: async () => null },
    null,
    null,
    { lookup: async () => ({ bpm: 999, key: "11B" }) },
  );
  const r = await uc.execute();
  assert.deepEqual(r, { scanned: 1, enriched: 1 }); // re-touched to fill key
  assert.equal(db["w.mp3"]!.bpm, 128); // client bpm preserved, NOT 999
  assert.equal(db["w.mp3"]!.key, "11B"); // gap filled from the source
});

// A fake CoverStore that records writes into an in-memory map.
function memStore() {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    store: {
      has: async (id: string) => files.has(id),
      read: async (id: string) => files.get(id) ?? null,
      write: async (id: string, bytes: Uint8Array) => {
        files.set(id, bytes);
      },
    },
  };
}

test("embedded ID3 art is extracted to a .jpg sidecar (no network)", async () => {
  const { files, store } = memStore();
  let fetched = 0;
  const uc = new EnrichLibrary(
    { list: async () => [tr("Uffie - Pop The Glock.mp3")], findById: async () => null },
    {
      all: async () => ({}),
      page: async () => ({ items: [], total: 0 }),
      put: async () => {},
    },
    "u1",
    {
      read: async () => null,
      readCover: async () => ({ mime: "image/jpeg", data: new Uint8Array([7, 7, 7]) }),
    },
    {
      fetch: async () => {
        fetched++;
        return new Uint8Array([9]);
      },
    },
    store,
  );
  await uc.execute();
  // sidecar written from the embedded bytes, remote never called
  assert.deepEqual(
    files.get("Uffie - Pop The Glock.mp3"),
    new Uint8Array([7, 7, 7]),
  );
  assert.equal(fetched, 0);
});

test("no embedded art → sidecar fetched from the cover service", async () => {
  const { files, store } = memStore();
  const uc = new EnrichLibrary(
    { list: async () => [tr("Artist - Song.mp3")], findById: async () => null },
    {
      all: async () => ({}),
      page: async () => ({ items: [], total: 0 }),
      put: async () => {},
    },
    "u1",
    { read: async () => null, readCover: async () => null },
    { fetch: async () => new Uint8Array([4, 2]) },
    store,
  );
  await uc.execute();
  assert.deepEqual(files.get("Artist - Song.mp3"), new Uint8Array([4, 2]));
});

test("a sidecar already on disk is not re-fetched/re-extracted", async () => {
  const { files, store } = memStore();
  files.set("done.mp3", new Uint8Array([1])); // sidecar present
  let reads = 0;
  let fetched = 0;
  const uc = new EnrichLibrary(
    { list: async () => [tr("done.mp3")], findById: async () => null },
    {
      all: async () => ({
        "done.mp3": {
          bpm: 120,
          size: 1,
          mtime: 2,
          analyzedAt: 9,
          key: "8A",
          artist: "A",
          title: "B",
        } as AnalysisRecord,
      }),
      page: async () => ({ items: [], total: 0 }),
      put: async () => {},
    },
    "u1",
    {
      read: async () => null,
      readCover: async () => {
        reads++;
        return { mime: "image/jpeg", data: new Uint8Array([2]) };
      },
    },
    {
      fetch: async () => {
        fetched++;
        return new Uint8Array([3]);
      },
    },
    store,
  );
  const r = await uc.execute();
  assert.deepEqual(r, { scanned: 1, enriched: 0 }); // fully complete → skip
  assert.deepEqual(files.get("done.mp3"), new Uint8Array([1])); // untouched
  assert.equal(reads, 0);
  assert.equal(fetched, 0);
});
