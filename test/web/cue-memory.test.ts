import test from "node:test";
import assert from "node:assert/strict";
import { CueMemory, mixInPoint } from "../../src/web/cue-memory.ts";

test("CueMemory remembers a manual cue per track", () => {
  const m = new CueMemory();
  m.set("u/a.mp3", 32.5);
  assert.equal(m.get("u/a.mp3"), 32.5);
  assert.equal(m.get("u/b.mp3"), null);
  assert.equal(m.get(null), null);
});

test("CueMemory round-trips through serialize/parse", () => {
  const m = new CueMemory();
  m.set("u/a.mp3", 12.3456);
  const back = CueMemory.parse(m.serialize());
  assert.equal(back.get("u/a.mp3"), 12.346);
});

test("CueMemory.parse survives garbage", () => {
  assert.equal(CueMemory.parse("{not json").get("x"), null);
  assert.equal(CueMemory.parse('[["x", "nope"]]').get("x"), null);
});

test("CueMemory ignores invalid input", () => {
  const m = new CueMemory();
  m.set("", 3);
  m.set("x", -1);
  m.set("y", Number.NaN);
  assert.equal(m.serialize(), "[]");
});

test("mixInPoint uses pass-the-beat's first solid downbeat", () => {
  assert.equal(mixInPoint({ firstSolidCueSec: 31.2 }), 31.2);
  assert.equal(mixInPoint({ firstSolidCueSec: null }), null);
});
