import type { ServerResponse } from "node:http";
import { DomainError, type ErrorCode } from "../../domain/errors.ts";

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  FORBIDDEN_PATH: 403,
  TRACK_NOT_FOUND: 404,
  NOT_AUDIO: 404,
  INVALID_TEMPO: 400,
  INVALID_REQUEST: 400,
  PAYLOAD_TOO_LARGE: 413,
  REMOTE_DISABLED: 503,
  REMOTE_FAILED: 502,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  PLAN_REQUIRED: 403,
};

export function statusForError(err: unknown): number {
  if (err instanceof DomainError) return STATUS_BY_CODE[err.code];
  if (err instanceof SyntaxError) return 400; // malformed JSON body
  return 500;
}

export function sendError(res: ServerResponse, err: unknown): void {
  const status = statusForError(err);
  const message = err instanceof Error ? err.message : String(err);
  // Surface server-side faults (e.g. a 502 from the remote library) in
  // the process log / `docker logs`; 4xx are expected client errors.
  if (status >= 500) {
    console.error(
      `[error] HTTP ${status}: ${message}`,
      err instanceof Error && err.stack ? `\n${err.stack}` : "",
    );
  }
  sendJson(res, status, { error: message });
}
