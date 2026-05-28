import test from "node:test";
import assert from "node:assert/strict";
import { ListLibrary } from "../../src/application/list-library.ts";
import type {
  AnalysisRecord,
  AnalysisRepository,
} from "../../src/domain/ports/analysis-repository.ts";

function store(rows: Record<string, AnalysisRecord>): AnalysisRepository {
  return {
    all: async () => rows,
    put: async () => {},
    page: async (_u, q) => {
      let items = Object.entries(rows).map(([id, record]) => ({
        id,
        record,
      }));
      if (q.q) {
        const n = q.q.toLowerCase();
        items = items.filter((i) =>
          `${i.record.artist ?? ""} ${i.record.title ?? ""} ${i.id}`
            .toLowerCase()
            .includes(n),
        );
      }
      const total = items.length;
      return { items: items.slice(q.offset, q.offset + q.limit), total };
    },
  };
}

const rec = (p: Partial<AnalysisRecord>): AnalysisRecord => ({
  bpm: 120,
  size: 1,
  mtime: 2,
  analyzedAt: 3,
  artist: null,
  title: null,
  ...p,
});

test("library is the analysis store, mapped to tracks, sorted by id", async () => {
  const tracks = await new ListLibrary(
    store({
      "B - Two.mp3": rec({ artist: "B", title: "Two", bpm: 128 }),
      "A - One.flac": rec({ artist: "A", title: "One", bpm: null }),
    }),
    "u1",
  ).execute();

  assert.deepEqual(
    tracks.map((t) => t.id),
    ["A - One.flac", "B - Two.mp3"], // sorted
  );
  const a = tracks[0]!;
  assert.equal(a.ext, ".flac");
  assert.equal(a.bpm, null); // nullable bpm tolerated
  assert.equal(a.display, "A — One");
  assert.equal(a.toJSON().path, "A - One.flac"); // wire id == path
  assert.equal(tracks[1]!.bpm, 128);
});

test("empty store → empty library (no FS scan)", async () => {
  assert.deepEqual(await new ListLibrary(store({}), "u1").execute(), []);
});

test("page() returns a searched, paginated slice + total", async () => {
  const rows: Record<string, AnalysisRecord> = {};
  for (let i = 0; i < 50; i++) {
    rows[`Artist - Track ${i}.mp3`] = rec({
      artist: "Artist",
      title: `Track ${i}`,
    });
  }
  rows["Other - Outlier.mp3"] = rec({ artist: "Other", title: "Outlier" });

  const ll = new ListLibrary(store(rows), "u1");
  const p1 = await ll.page({
    q: "",
    sort: "title",
    dir: "asc",
    limit: 20,
    offset: 0,
  });
  assert.equal(p1.total, 51);
  assert.equal(p1.tracks.length, 20);
  assert.equal(p1.offset, 0);

  const p3 = await ll.page({
    q: "",
    sort: "title",
    dir: "asc",
    limit: 20,
    offset: 40,
  });
  assert.equal(p3.tracks.length, 11); // last page

  const search = await ll.page({
    q: "outlier",
    sort: "title",
    dir: "asc",
    limit: 20,
    offset: 0,
  });
  assert.equal(search.total, 1);
  assert.equal(search.tracks[0]!.title, "Outlier");
});

test("falls back to filename when artist/title absent", async () => {
  const [t] = await new ListLibrary(
    store({ "Mixtape.mp3": rec({ artist: null, title: null }) }),
    "",
  ).execute();
  // Track.display uses name when title is null
  assert.equal(t!.display, "Mixtape.mp3");
});
