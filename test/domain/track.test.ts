import test from "node:test";
import assert from "node:assert/strict";
import { Track } from "../../src/domain/track.ts";

const base = {
  id: "house/a.mp3",
  name: "a.mp3",
  dir: "house",
  ext: ".mp3",
  size: 1000,
  mtime: 42,
  bpm: null,
};

test("Track exposes its properties", () => {
  const t = new Track(base);
  assert.equal(t.id, "house/a.mp3");
  assert.equal(t.bpm, null);
});

test("withBpm returns a new instance, leaving the original untouched", () => {
  const t = new Track(base);
  const analysed = t.withBpm(128);
  assert.equal(analysed.bpm, 128);
  assert.equal(t.bpm, null);
  assert.notEqual(analysed, t);
});

test("toJSON keeps a `path` alias of `id` for the client", () => {
  const json = new Track(base).withBpm(124).toJSON();
  assert.equal(json.path, json.id);
  assert.equal(json.path, "house/a.mp3");
  assert.equal(json.bpm, 124);
});

test("toJSON carries analysis fields so they survive a reload", () => {
  const json = new Track(base)
    .withAnalysis({
      bpm: 128,
      key: "A",
      mode: "minor",
      camelot: "8A",
      energy: 0.7,
    })
    .toJSON();
  assert.equal(json.bpm, 128);
  assert.equal(json.key, "A");
  assert.equal(json.mode, "minor");
  assert.equal(json.camelot, "8A");
  assert.equal(json.energy, 0.7);
});

test("withTags preserves analysis fields in the wire format", () => {
  const json = new Track(base)
    .withAnalysis({ bpm: 120, camelot: "5A", energy: 0.4 })
    .withTags("Title", "Artist")
    .toJSON();
  assert.equal(json.camelot, "5A");
  assert.equal(json.energy, 0.4);
  assert.equal(json.artist, "Artist");
});
