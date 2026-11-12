import test from "node:test";
import assert from "node:assert/strict";
import { LibrarySweep } from "../../src/application/library-sweep.ts";

function refused(): Error {
  return Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:3306"), {
    code: "ECONNREFUSED",
  });
}

test("a database outage is logged, not thrown, and the next run retries", async () => {
  let down = true;
  const swept: string[] = [];
  const logs: string[] = [];
  const sweep = new LibrarySweep({
    userIds: async () => {
      if (down) throw refused();
      return ["u1", "u2"];
    },
    sweepUser: async (uid) => {
      swept.push(uid);
    },
    log: (m) => logs.push(m),
  });

  await sweep.run(); // must resolve: a rejection here kills the process
  assert.deepEqual(swept, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0] ?? "", /ECONNREFUSED/);

  down = false;
  await sweep.run();
  assert.deepEqual(swept, ["u1", "u2"]);
});

test("one user's failure does not stop the others", async () => {
  const swept: string[] = [];
  const sweep = new LibrarySweep({
    userIds: async () => ["u1", "u2"],
    sweepUser: async (uid) => {
      if (uid === "u1") throw refused();
      swept.push(uid);
    },
    log: () => {},
  });
  await sweep.run();
  assert.deepEqual(swept, ["u2"]);
});

test("no accounts sweeps the legacy root once", async () => {
  const swept: string[] = [];
  const sweep = new LibrarySweep({
    userIds: async () => [],
    sweepUser: async (uid) => {
      swept.push(uid);
    },
  });
  await sweep.run();
  assert.deepEqual(swept, [""]);
});

test("a run requested mid-sweep is coalesced into one more pass", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let passes = 0;
  const sweep = new LibrarySweep({
    userIds: async () => {
      passes++;
      return ["u1"];
    },
    sweepUser: async () => {
      if (passes === 1) await gate;
    },
  });
  const first = sweep.run();
  await new Promise((r) => setImmediate(r));
  await sweep.run(); // returns at once, marks pending
  await sweep.run();
  release();
  await first;
  assert.equal(passes, 2);
});
