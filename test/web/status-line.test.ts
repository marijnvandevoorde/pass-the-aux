import test from "node:test";
import assert from "node:assert/strict";
import { StatusLine } from "../../src/web/status-line.ts";

function line() {
  const shown: Array<[string, string]> = [];
  let pending: (() => void) | null = null;
  const s = new StatusLine({
    show: (text, kind) => shown.push([text, kind]),
    setTimer: (fn) => (pending = fn),
    clearTimer: () => (pending = null),
  });
  return { s, shown, fire: () => pending?.(), last: () => shown.at(-1) };
}

test("feedback shows, then the automix state comes back", () => {
  const { s, fire, last } = line();
  s.automix("next up on Deck B: Song");
  assert.deepEqual(last(), ["next up on Deck B: Song", "automix"]);
  s.feedback("Deck A cue set");
  assert.deepEqual(last(), ["Deck A cue set", "feedback"]);
  fire();
  assert.deepEqual(last(), ["next up on Deck B: Song", "automix"]);
});

test("an automix change during feedback waits for the feedback to time out", () => {
  const { s, fire, last } = line();
  s.automix("queue empty");
  s.feedback("queued \"Song\"");
  s.automix("loading Song…");
  assert.deepEqual(last(), ["queued \"Song\"", "feedback"]);
  fire();
  assert.deepEqual(last(), ["loading Song…", "automix"]);
});

test("empty feedback clears straight back to the automix state", () => {
  const { s, last } = line();
  s.automix("queue empty");
  s.feedback("loading library…");
  s.feedback("");
  assert.deepEqual(last(), ["queue empty", "automix"]);
});

test("without an automix state, feedback stays until the next message", () => {
  const { s, shown, fire, last } = line();
  s.feedback("could not load library: offline");
  fire(); // no timer was set
  assert.deepEqual(last(), ["could not load library: offline", "feedback"]);
  assert.equal(shown.length, 1);
  s.automix("automix armed");
  assert.deepEqual(last(), ["automix armed", "automix"]);
});
