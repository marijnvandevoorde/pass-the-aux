import test from "node:test";
import assert from "node:assert/strict";
import {
  emptySession,
  parse,
  restoredCrossfade,
  resumeDecision,
  serialize,
  type SessionState,
} from "../../src/web/session.ts";

function withActive(path: string | null, queue: string[] = []): SessionState {
  const s = emptySession();
  s.active = path ? { path, offsetSec: 42 } : null;
  s.queue = queue.map((p) => ({ name: p, path: p, bpm: null }));
  return s;
}

test("serialize → parse round-trips; config/queue preserved", () => {
  const s = emptySession();
  s.config.autoFill = true;
  s.queue = [{ name: "A", path: "a.mp3", bpm: 128 }];
  const out = parse(serialize(s));
  assert.ok(out);
  assert.equal(out.config.autoFill, true);
  assert.deepEqual(out.queue, s.queue);
});

test("both decks round-trip; legacy session w/o decks still parses", () => {
  const s = emptySession();
  s.decks = {
    A: { path: "a.mp3", offsetSec: 12.5, playing: true },
    B: { path: "b.mp3", offsetSec: 0, playing: false },
  };
  const out = parse(serialize(s));
  assert.ok(out);
  assert.deepEqual(out.decks, s.decks);
  // a pre-decks payload (no `decks` key) is still valid
  const legacy = parse(
    JSON.stringify({
      v: 1,
      s: { config: {}, queue: [], played: [], active: null },
    }),
  );
  assert.ok(legacy);
  assert.equal(legacy.decks, undefined);
});

test("parse rejects junk / missing / wrong version", () => {
  assert.equal(parse(null), null);
  assert.equal(parse("{not json"), null);
  assert.equal(parse(JSON.stringify({ v: 99, s: {} })), null);
  assert.equal(parse(JSON.stringify({ v: 1, s: { config: {} } })), null);
});

test("resumeDecision: resume the active track when still in library", () => {
  const lib = new Set(["x.mp3"]);
  assert.deepEqual(resumeDecision(withActive("x.mp3"), lib), {
    kind: "resume",
    path: "x.mp3",
    offsetSec: 42,
  });
});

test("resumeDecision: active gone → next queued that exists", () => {
  const lib = new Set(["q.mp3"]);
  assert.deepEqual(
    resumeDecision(withActive("gone.mp3", ["q.mp3"]), lib),
    { kind: "next" },
  );
});

test("resumeDecision: nothing usable → none", () => {
  assert.deepEqual(resumeDecision(withActive(null, []), new Set()), {
    kind: "none",
  });
  assert.deepEqual(
    resumeDecision(withActive("gone", ["alsogone"]), new Set(["other"])),
    { kind: "none" },
  );
});

test("crossfader position round-trips; old sessions and junk restore to the centre", () => {
  const s = emptySession();
  s.crossfade = -0.62;
  assert.equal(restoredCrossfade(parse(serialize(s))), -0.62);
  assert.equal(restoredCrossfade(parse(serialize(emptySession()))), 0); // saved before this field
  assert.equal(restoredCrossfade({ ...s, crossfade: 7 }), 1);
  assert.equal(restoredCrossfade({ ...s, crossfade: Number.NaN }), 0);
  assert.equal(restoredCrossfade(null), 0);
});
