import {
  InvalidRequestError,
  NotFoundError,
  PlanRequiredError,
} from "../domain/errors.ts";
import {
  isRemoteLibraryKind,
  type NewRemoteLibrary,
  type RemoteLibrariesRepository,
  type RemoteLibraryKind,
  type RemoteLibraryRow,
} from "../domain/ports/remote-libraries-repository.ts";
import {
  canManageRemoteLibraries,
  type UserRepository,
} from "../domain/ports/user-repository.ts";
import type { RemoteCheck, RemoteSource } from "../domain/ports/remote-source.ts";

/** Builds the runtime source for a row (composition supplies it). */
export type RemoteSourceFactory = (row: RemoteLibraryRow) => RemoteSource | null;

/** A row's safe-to-serialise shape — `apiKey` is never returned. */
export interface RemoteLibraryPublic {
  id: string;
  kind: RemoteLibraryKind;
  name: string;
  baseUrl: string | null;
  isActive: boolean;
  createdAt: number;
}

export function toPublic(r: RemoteLibraryRow): RemoteLibraryPublic {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    baseUrl: r.baseUrl,
    isActive: r.isActive,
    createdAt: r.createdAt,
  };
}

const NAME_MAX = 120;
const URL_MAX = 500;
const KEY_MAX = 500;

/** CRUD use cases for the user's remote record stores. The HTTP layer
 *  passes the authenticated `uid` to every method — the repo enforces
 *  per-user isolation. */
export class ManageRemoteLibraries {
  readonly #repo: RemoteLibrariesRepository;
  readonly #users: UserRepository;
  readonly #sourceFor: RemoteSourceFactory | null;

  constructor(
    repo: RemoteLibrariesRepository,
    users: UserRepository,
    sourceFor: RemoteSourceFactory | null = null,
  ) {
    this.#repo = repo;
    this.#users = users;
    this.#sourceFor = sourceFor;
  }

  async list(uid: string): Promise<RemoteLibraryPublic[]> {
    const rows = await this.#repo.listForUser(uid);
    return rows.map(toPublic);
  }

  /** Whether this account's plan permits adding remote record stores.
   *  The settings UI uses it to gray out the section; `add()` enforces
   *  it server-side. Auth-disabled (uid "") and unknown users are not
   *  blocked — only a real account on the free plan is. */
  async canManage(uid: string): Promise<boolean> {
    const user = uid ? await this.#users.findById(uid) : null;
    return user === null ? true : canManageRemoteLibraries(user.plan);
  }

  async add(uid: string, body: unknown): Promise<RemoteLibraryPublic> {
    if (!(await this.canManage(uid))) throw new PlanRequiredError();
    const input = validateNew(body);
    const row = await this.#repo.create(uid, input);
    return toPublic(row);
  }

  async update(
    uid: string,
    id: string,
    body: unknown,
  ): Promise<RemoteLibraryPublic> {
    const patch = validatePatch(body);
    const row = await this.#repo.update(uid, id, patch);
    if (row === null) throw new NotFoundError("remote not found");
    return toPublic(row);
  }

  async delete(uid: string, id: string): Promise<void> {
    const ok = await this.#repo.delete(uid, id);
    if (!ok) throw new NotFoundError("remote not found");
  }

  /** "Test connection". `body.id` tests a saved store; the form's
   *  `kind`/`baseUrl`/`apiKey` test unsaved values (when editing, an
   *  empty `apiKey` keeps the stored one). Answers with a result, also
   *  when the store can't be reached; only bad input throws. */
  async test(uid: string, body: unknown): Promise<RemoteCheck> {
    if (body === null || typeof body !== "object") {
      throw new InvalidRequestError("invalid body");
    }
    const b = body as Record<string, unknown>;
    const id = typeof b.id === "string" ? b.id.trim() : "";
    let row: RemoteLibraryRow;
    if (id !== "") {
      const saved = (await this.#repo.listForUser(uid)).find((r) => r.id === id);
      if (saved === undefined) throw new NotFoundError("remote not found");
      const patch = validatePatch({ baseUrl: b.baseUrl, apiKey: b.apiKey });
      row = {
        ...saved,
        baseUrl: patch.baseUrl ?? saved.baseUrl,
        apiKey: patch.apiKey ?? saved.apiKey,
      };
    } else {
      if (!isRemoteLibraryKind(b.kind)) throw new InvalidRequestError("invalid kind");
      const baseUrl = optionalString(b.baseUrl, URL_MAX);
      const apiKey = optionalString(b.apiKey, KEY_MAX);
      row = {
        id: "test",
        userId: uid,
        kind: b.kind,
        name: "this store",
        baseUrl,
        apiKey,
        isActive: false,
        createdAt: 0,
      };
    }
    try {
      validateKindFields(row.kind, row.baseUrl, row.apiKey);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }
    const source = this.#sourceFor?.(row) ?? null;
    if (source === null) return fail("this kind of store isn't supported yet");
    if (source.check) return source.check();
    try {
      await source.search("a");
      return { ok: true, message: "Connected", tracks: null, indexing: false };
    } catch (e) {
      return fail((e instanceof Error ? e.message : String(e)).replace(/^remote library: /, ""));
    }
  }

  async setActive(uid: string, id: string): Promise<void> {
    const ok = await this.#repo.setActive(uid, id);
    if (!ok) throw new NotFoundError("remote not found");
  }
}

function fail(message: string): RemoteCheck {
  return { ok: false, message, tracks: null, indexing: false };
}

function validateNew(body: unknown): NewRemoteLibrary {
  if (body === null || typeof body !== "object") {
    throw new InvalidRequestError("invalid body");
  }
  const b = body as Record<string, unknown>;
  if (!isRemoteLibraryKind(b.kind)) {
    throw new InvalidRequestError("invalid kind");
  }
  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (name === "") throw new InvalidRequestError("name required");
  if (name.length > NAME_MAX) {
    throw new InvalidRequestError(`name too long (>${NAME_MAX})`);
  }
  const baseUrl = optionalString(b.baseUrl, URL_MAX);
  const apiKey = optionalString(b.apiKey, KEY_MAX);
  validateKindFields(b.kind, baseUrl, apiKey);
  return { kind: b.kind, name, baseUrl, apiKey };
}

function validatePatch(body: unknown): Partial<NewRemoteLibrary> {
  if (body === null || typeof body !== "object") {
    throw new InvalidRequestError("invalid body");
  }
  const b = body as Record<string, unknown>;
  const out: Partial<NewRemoteLibrary> = {};
  if (b.kind !== undefined) {
    if (!isRemoteLibraryKind(b.kind)) {
      throw new InvalidRequestError("invalid kind");
    }
    out.kind = b.kind;
  }
  if (b.name !== undefined) {
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (name === "") throw new InvalidRequestError("name required");
    if (name.length > NAME_MAX) {
      throw new InvalidRequestError(`name too long (>${NAME_MAX})`);
    }
    out.name = name;
  }
  if (b.baseUrl !== undefined) {
    out.baseUrl = optionalString(b.baseUrl, URL_MAX);
  }
  if (b.apiKey !== undefined) {
    out.apiKey = optionalString(b.apiKey, KEY_MAX);
  }
  return out;
}

function validateKindFields(
  kind: RemoteLibraryKind,
  baseUrl: string | null,
  apiKey: string | null,
): void {
  if (kind === "pta") {
    if (baseUrl === null) throw new InvalidRequestError("baseUrl required for pta");
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new InvalidRequestError("baseUrl must be http(s)");
    }
    if (apiKey === null) {
      throw new InvalidRequestError("apiKey (Bearer secret) required for pta");
    }
  } else {
    // jamendo / fma — no baseUrl (fixed endpoint), apiKey is the
    // client_id / API key from the provider.
    if (apiKey === null) {
      throw new InvalidRequestError(`apiKey required for ${kind}`);
    }
  }
}

function optionalString(v: unknown, max: number): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new InvalidRequestError("expected string");
  }
  const trimmed = v.trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) {
    throw new InvalidRequestError(`value too long (>${max})`);
  }
  return trimmed;
}
