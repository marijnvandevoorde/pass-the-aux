import test from "node:test";
import assert from "node:assert/strict";
import { ScaledWorker } from "../../src/infrastructure/k8s-worker-lease.ts";
import { AnalyzerUnavailableError } from "../../src/domain/errors.ts";

/** A fake Deployment: scaling to 1 makes /healthz answer after `bootPolls`
 *  probes; scaling to 0 makes it go away. */
function fakeCluster(bootPolls = 2) {
  const scales: number[] = [];
  let replicas = 0;
  let polls = 0;
  const fetchImpl = (async () => {
    if (replicas === 0) throw new Error("ECONNREFUSED");
    polls++;
    if (polls <= bootPolls) return new Response(JSON.stringify({ model_loaded: false }));
    return new Response(JSON.stringify({ status: "ok", model_loaded: true }));
  }) as unknown as typeof fetch;
  return {
    scales,
    fetchImpl,
    get replicas() {
      return replicas;
    },
    scale: async (n: number) => {
      scales.push(n);
      replicas = n;
      polls = 0;
    },
  };
}

function worker(c: ReturnType<typeof fakeCluster>, over: Partial<ConstructorParameters<typeof ScaledWorker>[0]> = {}) {
  return new ScaledWorker({
    name: "pass-the-beat",
    scale: c.scale,
    fetchImpl: c.fetchImpl,
    healthUrl: "http://pass-the-beat:8000/healthz",
    idleMs: 30,
    readyTimeoutMs: 1000,
    backoffMs: 60_000,
    pollMs: 1,
    log: () => {},
    ...over,
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `cond` holds; fails after `ms`. Waits on the outcome
 *  instead of a fixed sleep, so a busy test runner can't flake it. */
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail("condition not met in time");
    await wait(2);
  }
}

test("scales up once for concurrent users, waits for the model, then idles to zero", async () => {
  const c = fakeCluster();
  const w = worker(c, { idleMs: 200 });
  try {
    await Promise.all([w.acquire(), w.acquire()]);
    assert.equal(c.replicas, 1);
    assert.deepEqual(c.scales, [1]);
    w.release();
    await wait(50);
    assert.equal(c.replicas, 1); // still held by the second user
    w.release();
    await w.acquire(); // reused while warm — no new scale-up
    assert.deepEqual(c.scales, [1]);
    w.release();
    await until(() => c.replicas === 0);
    assert.deepEqual(c.scales, [1, 0]);
  } finally {
    w.close();
  }
});

test("an already-running worker is used as is", async () => {
  const c = fakeCluster(0);
  await c.scale(1);
  c.scales.length = 0;
  const w = worker(c, { idleMs: 10_000 });
  try {
    await w.acquire();
    w.release();
    assert.deepEqual(c.scales, []);
  } finally {
    w.close();
  }
});

test("a start that never gets ready scales back down and backs off", async () => {
  const c = fakeCluster(1_000_000);
  const w = worker(c, { readyTimeoutMs: 30 });
  try {
    await assert.rejects(w.acquire(), AnalyzerUnavailableError);
    assert.deepEqual(c.scales, [1, 0]);
    // inside the back-off window: fails fast, no new scale-up
    await assert.rejects(w.acquire(), /backing off/);
    assert.deepEqual(c.scales, [1, 0]);
  } finally {
    w.close();
  }
});

test("lost() makes the next acquire wait for the worker again", async () => {
  const c = fakeCluster(0);
  const w = worker(c, { idleMs: 10_000 });
  try {
    await w.acquire();
    w.release();
    await c.scale(0); // the pod disappears behind our back
    w.lost();
    await w.acquire();
    assert.equal(c.replicas, 1);
    w.release();
  } finally {
    w.close();
  }
});

test("a worker left running by someone else is scaled down when idle", async () => {
  const c = fakeCluster(0);
  await c.scale(1);
  const w = worker(c, { idleMs: 20 });
  try {
    await until(() => c.replicas === 0);
    assert.equal(c.replicas, 0);
  } finally {
    w.close();
  }
});

test("an idle timer that fires before the clock says idle checks again", async () => {
  // The clock lags the timer: when the idle timer fires, only part of
  // idleMs has passed by `now()`. The old code returned and never
  // looked again (the flake behind the test above).
  const c = fakeCluster(0);
  await c.scale(1);
  let clock = 1_000;
  const w = worker(c, { idleMs: 20, now: () => clock });
  try {
    await wait(40); // the first timer has fired, the clock hasn't moved
    assert.equal(c.replicas, 1);
    clock += 20;
    await until(() => c.replicas === 0);
  } finally {
    w.close();
  }
});

test("warm() starts the worker without holding it, so it still idles to zero", async () => {
  const c = fakeCluster(1);
  const w = worker(c, { idleMs: 50 });
  try {
    w.warm();
    w.warm(); // a second warm-up while starting shares the same start
    await until(() => c.replicas === 1);
    assert.deepEqual(c.scales, [1]);
    await w.acquire(); // already up: no new scale
    w.release();
    assert.deepEqual(c.scales, [1]);
    await until(() => c.scales.length === 2);
    assert.deepEqual(c.scales, [1, 0]);
  } finally {
    w.close();
  }
});

test("a failed start throws the configured error and names the Deployment", async () => {
  class Custom extends Error {}
  const c = fakeCluster(1_000_000);
  const w = worker(c, {
    name: "spotify-api",
    readyTimeoutMs: 20,
    unavailable: (m) => new Custom(m),
  });
  try {
    await assert.rejects(w.acquire(), (e: unknown) => e instanceof Custom && /spotify-api did not start/.test(e.message));
    await assert.rejects(w.acquire(), /spotify-api: last start failed, backing off/);
  } finally {
    w.close();
  }
});
