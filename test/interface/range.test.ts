import test from "node:test";
import assert from "node:assert/strict";
import { parseRange } from "../../src/interface/http/range.ts";

const SIZE = 1000;

test("no header → none", () => {
  assert.deepEqual(parseRange(undefined, SIZE), { kind: "none" });
});

test("explicit range", () => {
  assert.deepEqual(parseRange("bytes=0-99", SIZE), {
    kind: "range",
    start: 0,
    end: 99,
  });
});

test("open-ended range runs to the last byte", () => {
  assert.deepEqual(parseRange("bytes=100-", SIZE), {
    kind: "range",
    start: 100,
    end: 999,
  });
});

test("bytes=- is treated as the whole file", () => {
  assert.deepEqual(parseRange("bytes=-", SIZE), {
    kind: "range",
    start: 0,
    end: 999,
  });
});

test("unsatisfiable ranges", () => {
  for (const h of ["bytes=5-2", "bytes=0-1000", "bytes=1000-1001", "bytes=abc", "items=0-1", "bytes=0-99, 200-299"]) {
    assert.equal(parseRange(h, SIZE).kind, "unsatisfiable", h);
  }
});
