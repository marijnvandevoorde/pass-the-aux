import test from "node:test";
import assert from "node:assert/strict";
import type { ServerResponse } from "node:http";
import { sendError, statusForError } from "../../src/interface/http/responder.ts";
import { RemoteStartingError } from "../../src/domain/errors.ts";

test("a remote that is starting up answers 503 with Retry-After and its message", () => {
  const err = new RemoteStartingError("Spotify");
  assert.equal(statusForError(err), 503);
  const headers: Record<string, unknown> = {};
  let status = 0;
  let body = "";
  const res = {
    setHeader: (k: string, v: unknown) => void (headers[k.toLowerCase()] = v),
    writeHead: (s: number, h: Record<string, unknown>) => {
      status = s;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    },
    end: (d: string) => void (body = d),
  } as unknown as ServerResponse;
  sendError(res, err);
  assert.equal(status, 503);
  assert.equal(headers["retry-after"], "5");
  assert.deepEqual(JSON.parse(body), { error: "Spotify is starting up, try again in a moment" });
});
