import test from "node:test";
import assert from "node:assert/strict";
import { describeFetchError } from "../../src/infrastructure/fetch-error.ts";

test("unwraps undici's cause code into a readable reason", () => {
  const e = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
  });
  assert.equal(
    describeFetchError(e, "http://nas.local:3000/api/get-music"),
    "can't reach nas.local:3000 (connection refused — is the server running?)",
  );
});

test("unknown errors keep their message", () => {
  assert.equal(describeFetchError(new Error("weird")), "request failed: weird");
});

test("DNS failures point at the URL", () => {
  const e = new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } });
  assert.match(describeFetchError(e, "https://nope.example/x"), /host not found/);
});
