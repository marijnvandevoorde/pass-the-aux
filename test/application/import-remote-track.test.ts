import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { ImportRemoteTrack } from "../../src/application/import-remote-track.ts";
import {
  InvalidRequestError,
  RemoteDisabledError,
} from "../../src/domain/errors.ts";
import type {
  RemoteAudio,
  RemoteSource,
} from "../../src/domain/ports/remote-source.ts";
import type { LibraryWriter } from "../../src/domain/ports/library-writer.ts";

function harness(enabled = true): {
  resolve: () => Promise<RemoteSource | null>;
  writer: LibraryWriter;
  dl: Array<{ id: string }>;
  wr: Array<{ base: string; ext: string }>;
  preexisting: { path: string | null };
} {
  const dl: Array<{ id: string }> = [];
  const wr: Array<{ base: string; ext: string }> = [];
  const preexisting: { path: string | null } = { path: null };
  const source: RemoteSource = {
    id: "fake",
    displayName: "Fake",
    enabled,
    async search() {
      return { items: [], total: 0, offset: 0 };
    },
    async download(remoteId): Promise<RemoteAudio> {
      dl.push({ id: remoteId });
      return {
        stream: Readable.from(Buffer.from("AUDIO")),
        contentType: "audio/flac",
        ext: "flac",
        size: 5,
      };
    },
  };
  const writer: LibraryWriter = {
    async write(_s, base, ext) {
      wr.push({ base, ext });
      return `${base}.${ext}`;
    },
    async existing() {
      return preexisting.path;
    },
  };
  return { resolve: async () => source, writer, dl, wr, preexisting };
}

test("a disabled source rejects with RemoteDisabledError", async () => {
  const h = harness(false);
  await assert.rejects(
    new ImportRemoteTrack(h.resolve, h.writer).execute("1"),
    RemoteDisabledError,
  );
});

test("missing/non-string remoteId → InvalidRequestError", async () => {
  const h = harness();
  const uc = new ImportRemoteTrack(h.resolve, h.writer);
  await assert.rejects(uc.execute("  "), InvalidRequestError);
  await assert.rejects(uc.execute(123), InvalidRequestError);
});

test("skips the download when the target already exists", async () => {
  const h = harness();
  h.preexisting.path = "Daft Punk - Get Lucky.mp3";
  const r = await new ImportRemoteTrack(h.resolve, h.writer).execute(
    "trk-9",
    "Daft Punk - Get Lucky",
  );
  assert.deepEqual(r, { path: "Daft Punk - Get Lucky.mp3" });
  assert.equal(h.dl.length, 0, "no remote download performed");
  assert.equal(h.wr.length, 0, "nothing written");
});

test("name falls back to remoteId; returns the written path", async () => {
  const h = harness();
  const r = await new ImportRemoteTrack(h.resolve, h.writer).execute(
    "trk-7",
    "   ",
  );
  // ext comes from the adapter's audio response (faked as flac here);
  // the real RemoteLibrarySource derives ext from Content-Type.
  assert.deepEqual(h.wr, [{ base: "trk-7", ext: "flac" }]);
  assert.deepEqual(r, { path: "trk-7.flac" });
});
