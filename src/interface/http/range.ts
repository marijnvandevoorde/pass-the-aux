export type RangeResult =
  | { kind: "none" }
  | { kind: "unsatisfiable" }
  | { kind: "range"; start: number; end: number };

/** Parses a single `bytes=` HTTP Range header against a known file size. */
export function parseRange(
  header: string | undefined,
  size: number,
): RangeResult {
  if (!header) return { kind: "none" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return { kind: "unsatisfiable" };

  const rawStart = match[1] ?? "";
  const rawEnd = match[2] ?? "";
  const start = rawStart === "" ? 0 : Number.parseInt(rawStart, 10);
  const end = rawEnd === "" ? size - 1 : Number.parseInt(rawEnd, 10);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    start > end ||
    end >= size
  ) {
    return { kind: "unsatisfiable" };
  }
  return { kind: "range", start, end };
}
