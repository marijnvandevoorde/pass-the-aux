import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createApp } from "../../src/main.ts";
import type { Config } from "../../src/infrastructure/config.ts";
import { writeTinyWav } from "../fixtures/wav.ts";

async function startServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const musicDir = await fsp.mkdtemp(path.join(os.tmpdir(), "djm-e2e-"));
  writeTinyWav(path.join(musicDir, "demo.wav"), 1000);

  const config: Config = {
    host: "127.0.0.1",
    port: 0,
    musicDir,
    bodyLimitBytes: 1_000_000,
    publicBaseUrl: "http://localhost:5174",
    storageDriver: "sqlite",
    db: {
      host: "127.0.0.1",
      port: 3306,
      user: "passtheaux",
      password: "",
      database: "passtheaux",
    },
    sqlitePath: path.join(musicDir, ".pass-the-aux.sqlite"),
    sessionSecret: "test-secret",
    coverLookup: false,
    registrationOpen: false,
    beatAnalyzer: "local",
    passTheBeatUrl: "http://pass-the-beat:8000",
  };
  const server = createApp(config);
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((res) => server.close(() => res())),
  };
}

test("library is DB-sourced: empty until scanned, then lists tracks", async () => {
  const s = await startServer();
  try {
    // DB-sourced: nothing until the scan/enrich job has run.
    const before = (await (await fetch(`${s.base}/api/library`)).json()) as {
      count: number;
    };
    assert.equal(before.count, 0);

    const scan = await fetch(`${s.base}/api/scan`, { method: "POST" });
    assert.equal(scan.status, 200);

    const res = await fetch(`${s.base}/api/library`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      count: number;
      tracks: Array<{ path: string; bpm: number | null }>;
    };
    assert.equal(body.count, 1);
    assert.equal(body.tracks[0]!.path, "demo.wav");
    assert.equal(body.tracks[0]!.bpm, null); // no TBPM, lookups off
  } finally {
    await s.close();
  }
});

test("POST /api/analyze persists a BPM that then appears in the library", async () => {
  const s = await startServer();
  try {
    const post = await fetch(`${s.base}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "demo.wav", bpm: 123.45 }),
    });
    assert.equal(post.status, 200);
    assert.deepEqual(await post.json(), {
      ok: true,
      path: "demo.wav",
      bpm: 123.5,
    });

    const lib = (await (await fetch(`${s.base}/api/library`)).json()) as {
      tracks: Array<{ bpm: number | null }>;
    };
    assert.equal(lib.tracks[0]!.bpm, 123.5);
  } finally {
    await s.close();
  }
});

test("POST /api/analyze rejects traversal (403) and bad tempo (400)", async () => {
  const s = await startServer();
  try {
    const trav = await fetch(`${s.base}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "../escape.wav", bpm: 120 }),
    });
    assert.equal(trav.status, 403);

    const bad = await fetch(`${s.base}/api/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "demo.wav", bpm: -1 }),
    });
    assert.equal(bad.status, 400);
  } finally {
    await s.close();
  }
});

test("crates round-trip: POST saves, GET lists, delete removes", async () => {
  const s = await startServer();
  try {
    const save = await fetch(`${s.base}/api/crates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Set", trackIds: ["demo.wav"] }),
    });
    assert.equal(save.status, 200);
    assert.deepEqual(await save.json(), { ok: true, name: "My Set", count: 1 });

    const list = (await (await fetch(`${s.base}/api/crates`)).json()) as {
      crates: Array<{ name: string; trackIds: string[] }>;
    };
    assert.deepEqual(list.crates, [{ name: "My Set", trackIds: ["demo.wav"] }]);

    const del = await fetch(`${s.base}/api/crates/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "My Set" }),
    });
    assert.equal(del.status, 200);
    const after = (await (await fetch(`${s.base}/api/crates`)).json()) as {
      crates: unknown[];
    };
    assert.equal(after.crates.length, 0);
  } finally {
    await s.close();
  }
});

test("POST /api/crates rejects empty name (400) and traversal id (403)", async () => {
  const s = await startServer();
  try {
    const empty = await fetch(`${s.base}/api/crates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "  ", trackIds: [] }),
    });
    assert.equal(empty.status, 400);

    const trav = await fetch(`${s.base}/api/crates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", trackIds: ["../secret"] }),
    });
    assert.equal(trav.status, 403);
  } finally {
    await s.close();
  }
});

test("GET /api/cover: no art → 404, traversal → 403", async () => {
  const s = await startServer();
  try {
    assert.equal(
      (await fetch(`${s.base}/api/cover?path=demo.wav`)).status,
      404,
    );
    assert.equal(
      (await fetch(`${s.base}/api/cover?path=../../etc/passwd`)).status,
      403,
    );
  } finally {
    await s.close();
  }
});

test("GET /api/audio streams the whole file", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/audio?path=demo.wav`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "audio/wav");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.equal(bytes.length, 44 + 1000 * 2);
  } finally {
    await s.close();
  }
});

test("GET /api/audio honours a Range request", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/audio?path=demo.wav`, {
      headers: { Range: "bytes=0-9" },
    });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get("content-range"), `bytes 0-9/${44 + 2000}`);
    assert.equal((await res.arrayBuffer()).byteLength, 10);
  } finally {
    await s.close();
  }
});

test("GET /api/audio: unsatisfiable range → 416, traversal → 403, missing → 404", async () => {
  const s = await startServer();
  try {
    assert.equal(
      (
        await fetch(`${s.base}/api/audio?path=demo.wav`, {
          headers: { Range: "bytes=999999-1000000" },
        })
      ).status,
      416,
    );
    assert.equal(
      (await fetch(`${s.base}/api/audio?path=../../etc/passwd`)).status,
      403,
    );
    assert.equal(
      (await fetch(`${s.base}/api/audio?path=nope.wav`)).status,
      404,
    );
  } finally {
    await s.close();
  }
});

test("GET /api/remote-status reports disabled when unconfigured", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/remote-status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: false });
  } finally {
    await s.close();
  }
});

test("GET /api/remote-search → 503 when the remote is disabled", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/remote-search?q=test`);
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /not configured/);
  } finally {
    await s.close();
  }
});

test("POST /api/remote-import → 503 when the remote is disabled", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/remote-import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteId: "1", quality: "6", name: "X" }),
    });
    assert.equal(res.status, 503);
  } finally {
    await s.close();
  }
});

test("GET /crowd serves the guest request page", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/crowd`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /Request a track|js\/crowd\.js/);
  } finally {
    await s.close();
  }
});

test("POST /api/session honours a DJ-chosen id (sanitised) in the url", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "My Party 2026!", config: {} }),
    });
    assert.equal(res.status, 200);
    const { id, url } = (await res.json()) as { id: string; url: string };
    assert.equal(id, "myparty2026");
    assert.match(url, /\/crowd\?s=myparty2026$/);
  } finally {
    await s.close();
  }
});

test("session: create → crowd queue → DJ drains → replay blocked", async () => {
  const s = await startServer();
  try {
    const created = await fetch(`${s.base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { automix: true } }),
    });
    assert.equal(created.status, 200);
    const { id, url } = (await created.json()) as {
      id: string;
      url: string;
    };
    assert.match(id, /^[a-z0-9]{1,8}$/);
    assert.match(url, /\/crowd\?s=/);

    const q = await fetch(`${s.base}/api/session/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: "Demo", path: "demo.wav", bpm: 120 }),
    });
    assert.equal(q.status, 200);

    const snap = (await (
      await fetch(`${s.base}/api/session?id=${id}`)
    ).json()) as { pending: Array<{ path: string }> };
    assert.deepEqual(
      snap.pending.map((p) => p.path),
      ["demo.wav"],
    );

    const sync = await fetch(`${s.base}/api/session/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, played: [] }),
    });
    assert.equal(sync.status, 200);
    const drained = (await sync.json()) as {
      pending: Array<{ path: string }>;
    };
    assert.deepEqual(
      drained.pending.map((p) => p.path),
      ["demo.wav"],
    );

    // Same track again → blocked as a replay.
    const dup = await fetch(`${s.base}/api/session/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: "Demo", path: "demo.wav" }),
    });
    assert.equal(dup.status, 409);

    // Unknown session id is rejected, not silently accepted.
    const bad = await fetch(`${s.base}/api/session/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "zzz", name: "x", path: "demo.wav" }),
    });
    assert.equal(bad.status, 404);
  } finally {
    await s.close();
  }
});

test("POST /api/session/clear-played: clears dedup so the same track can be re-queued", async () => {
  const s = await startServer();
  try {
    const created = await fetch(`${s.base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ config: { automix: true } }),
    });
    const { id } = (await created.json()) as { id: string };

    // First add succeeds; immediate replay is rejected (SESSION·4).
    const a1 = await fetch(`${s.base}/api/session/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: "Demo", path: "demo.wav" }),
    });
    assert.equal(a1.status, 200);
    const dup = await fetch(`${s.base}/api/session/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: "Demo", path: "demo.wav" }),
    });
    assert.equal(dup.status, 409);

    // Clear played history.
    const cleared = await fetch(`${s.base}/api/session/clear-played`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    assert.equal(cleared.status, 200);
    assert.deepEqual(await cleared.json(), { ok: true });

    // Re-adding now succeeds.
    const a2 = await fetch(`${s.base}/api/session/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name: "Demo", path: "demo.wav" }),
    });
    assert.equal(a2.status, 200);
  } finally {
    await s.close();
  }
});

test("POST /api/session/clear-played: 404 for an unknown session id", async () => {
  const s = await startServer();
  try {
    const res = await fetch(`${s.base}/api/session/clear-played`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "nope" }),
    });
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test("GET /api/beat-grid: 404 when missing, library payload stays beat-free", async () => {
  const s = await startServer();
  try {
    // No grids written yet — 404 is the contract.
    const missing = await fetch(`${s.base}/api/beat-grid?path=demo.wav`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "no beat grid" });

    // Empty path → also 404 (use-case returns null, route surfaces 404).
    const empty = await fetch(`${s.base}/api/beat-grid?path=`);
    assert.equal(empty.status, 404);

    // Invariant: /api/library must never inline beat arrays.
    await fetch(`${s.base}/api/scan`, { method: "POST" });
    const libBody = await (await fetch(`${s.base}/api/library`)).text();
    assert.ok(!libBody.includes("\"beats\":"), "library must not inline beats");
  } finally {
    await s.close();
  }
});

test("unknown API route → 404; root serves the SPA", async () => {
  const s = await startServer();
  try {
    const api = await fetch(`${s.base}/api/nope`);
    assert.equal(api.status, 404);
    assert.deepEqual(await api.json(), { error: "unknown endpoint" });

    const root = await fetch(`${s.base}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get("content-type") ?? "", /text\/html/);
    assert.match(
      await root.text(),
      /PASS&nbsp;THE&nbsp;AUX|PASS THE AUX|id="start-btn"/,
    );
  } finally {
    await s.close();
  }
});
