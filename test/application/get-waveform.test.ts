import test from "node:test";
import assert from "node:assert/strict";
import { GetWaveform } from "../../src/application/get-waveform.ts";
import type { WaveformSource } from "../../src/domain/ports/waveform-source.ts";
import type { Waveform } from "../../src/domain/waveform.ts";
import type { WaveformRepository } from "../../src/domain/ports/waveform-repository.ts";
import { ForbiddenPathError } from "../../src/domain/errors.ts";

function fakeSource(result: (id: string) => Waveform | null) {
  const calls: string[] = [];
  const src: WaveformSource = {
    async waveform(id) {
      calls.push(id);
      await new Promise((r) => setTimeout(r, 5));
      return result(id);
    },
  };
  return { src, calls };
}

const W: Waveform = { durationSec: 200, peaks: [0.1, 0.9] };

test("computes once, then serves from the cache", async () => {
  const { src, calls } = fakeSource(() => W);
  const uc = new GetWaveform(src);
  assert.deepEqual(await uc.execute("a.mp3"), W);
  assert.deepEqual(await uc.execute("a.mp3"), W);
  assert.deepEqual(calls, ["a.mp3"]);
});

test("concurrent requests for one track share a single decode", async () => {
  const { src, calls } = fakeSource(() => W);
  const uc = new GetWaveform(src);
  const [a, b] = await Promise.all([uc.execute("a.mp3"), uc.execute("a.mp3")]);
  assert.deepEqual(a, W);
  assert.deepEqual(b, W);
  assert.equal(calls.length, 1);
});

test("an unreadable track isn't cached (the file may still be arriving)", async () => {
  let ready = false;
  const { src, calls } = fakeSource(() => (ready ? W : null));
  const uc = new GetWaveform(src);
  assert.equal(await uc.execute("a.mp3"), null);
  ready = true;
  assert.deepEqual(await uc.execute("a.mp3"), W);
  assert.equal(calls.length, 2);
});

test("path traversal is refused before touching the source", async () => {
  const { src, calls } = fakeSource(() => W);
  const uc = new GetWaveform(src);
  await assert.rejects(uc.execute("../secret.mp3"), ForbiddenPathError);
  assert.equal(calls.length, 0);
});

function memoryStore() {
  const rows = new Map<string, Waveform>();
  const store: WaveformRepository = {
    async get(uid, id) {
      return rows.get(`${uid}::${id}`) ?? null;
    },
    async put(uid, id, w) {
      rows.set(`${uid}::${id}`, w);
    },
  };
  return { store, rows };
}

test("a decoded waveform is stored, and a new instance (a restart) reads it back without decoding", async () => {
  const { store, rows } = memoryStore();
  const first = fakeSource(() => W);
  assert.deepEqual(await new GetWaveform(first.src, store, "u1").execute("a.mp3"), W);
  assert.ok(rows.has("u1::a.mp3"));
  const second = fakeSource(() => W);
  const uc = new GetWaveform(second.src, store, "u1");
  assert.deepEqual(await uc.execute("a.mp3"), W);
  assert.deepEqual(second.calls, []);
});

test("a failing store only costs a decode", async () => {
  const store: WaveformRepository = {
    async get() {
      throw new Error("db down");
    },
    async put() {
      throw new Error("db down");
    },
  };
  const { src, calls } = fakeSource(() => W);
  assert.deepEqual(await new GetWaveform(src, store).execute("a.mp3"), W);
  assert.equal(calls.length, 1);
});
