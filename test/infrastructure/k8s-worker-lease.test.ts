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
    await wait(400);
    assert.equal(c.replicas, 0);
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
    await wait(100);
    assert.equal(c.replicas, 0);
  } finally {
    w.close();
  }
});
