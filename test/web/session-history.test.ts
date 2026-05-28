import test from "node:test";
import assert from "node:assert/strict";
import { SessionHistory } from "../../src/web/session-history.ts";

test("records and recognises seen tracks", () => {
  const h = new SessionHistory();
  assert.equal(h.has("a.mp3"), false);
  h.record("a.mp3");
  assert.equal(h.has("a.mp3"), true);
  assert.equal(h.size, 1);
});

test("ignores empty / null ids", () => {
  const h = new SessionHistory();
  h.record(null);
  h.record(undefined);
  h.record("");
  assert.equal(h.size, 0);
  assert.equal(h.has(null), false);
  assert.equal(h.has(""), false);
});

test("re-recording a seen track is idempotent (manual re-queue allowed)", () => {
  const h = new SessionHistory();
  h.record("x.flac");
  h.record("x.flac");
  assert.equal(h.size, 1);
  assert.equal(h.has("x.flac"), true); // still allowed; just not double-counted
});

test("clear resets the session", () => {
  const h = new SessionHistory();
  h.record("a");
  h.record("b");
  h.clear();
  assert.equal(h.size, 0);
  assert.equal(h.has("a"), false);
});
