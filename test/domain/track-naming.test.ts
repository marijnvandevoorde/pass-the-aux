import test from "node:test";
import assert from "node:assert/strict";
import {
  parseTrackName,
  stripExtension,
} from "../../src/domain/track-naming.ts";

test("stripExtension drops the last extension only", () => {
  assert.equal(stripExtension("Song.mp3"), "Song");
  assert.equal(stripExtension("a.b.flac"), "a.b");
  assert.equal(stripExtension("NoExt"), "NoExt");
  assert.equal(stripExtension(".hidden"), ".hidden");
});

test("splits on the FIRST ' - ' → artist / title", () => {
  assert.deepEqual(parseTrackName("Daft Punk - Get Lucky.mp3"), {
    artist: "Daft Punk",
    title: "Get Lucky",
  });
  // Only the first separator splits; the rest stays in the title.
  assert.deepEqual(parseTrackName("AC-DC - T.N.T - Live.flac"), {
    artist: "AC-DC",
    title: "T.N.T - Live",
  });
});

test("no ' - ' → whole filename-minus-ext is the title", () => {
  assert.deepEqual(parseTrackName("Bohemian Rhapsody.mp3"), {
    artist: null,
    title: "Bohemian Rhapsody",
  });
});

test("a blank side falls back to title-only", () => {
  assert.deepEqual(parseTrackName(" - Orphan.mp3"), {
    artist: null,
    title: "- Orphan",
  });
  assert.deepEqual(parseTrackName("Artist - .mp3"), {
    artist: null,
    title: "Artist -",
  });
});
