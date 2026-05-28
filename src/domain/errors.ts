export type ErrorCode =
  | "FORBIDDEN_PATH"
  | "TRACK_NOT_FOUND"
  | "NOT_AUDIO"
  | "INVALID_TEMPO"
  | "INVALID_REQUEST"
  | "PAYLOAD_TOO_LARGE"
  | "REMOTE_DISABLED"
  | "REMOTE_FAILED"
  | "NOT_FOUND"
  | "UNAUTHORIZED";

/** Base class for expected, domain-level failures (mapped to HTTP status by the interface layer). */
export class DomainError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class ForbiddenPathError extends DomainError {
  constructor(path: string) {
    super(`path escapes the library: ${path}`, "FORBIDDEN_PATH");
  }
}

export class TrackNotFoundError extends DomainError {
  constructor(path: string) {
    super(`track not found: ${path}`, "TRACK_NOT_FOUND");
  }
}

export class NotAudioError extends DomainError {
  constructor(path: string) {
    super(`not an audio file: ${path}`, "NOT_AUDIO");
  }
}

export class InvalidTempoError extends DomainError {
  constructor(value: unknown) {
    super(`invalid tempo: ${String(value)}`, "INVALID_TEMPO");
  }
}

export class InvalidRequestError extends DomainError {
  constructor(message: string) {
    super(message, "INVALID_REQUEST");
  }
}

/** Authentication/2FA failure. Mapped to HTTP 401. */
export class UnauthorizedError extends DomainError {
  constructor(message = "not authenticated") {
    super(message, "UNAUTHORIZED");
  }
}

export class PayloadTooLargeError extends DomainError {
  constructor() {
    super("request body too large", "PAYLOAD_TOO_LARGE");
  }
}

/** No active remote record store for this user. */
export class RemoteDisabledError extends DomainError {
  constructor() {
    super("remote library is not configured", "REMOTE_DISABLED");
  }
}

/** The remote library service failed or returned an error envelope. */
export class RemoteSourceError extends DomainError {
  constructor(message: string) {
    super(`remote library: ${message}`, "REMOTE_FAILED");
  }
}

/** A resource exists in the domain model but not in this user's scope. */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, "NOT_FOUND");
  }
}
