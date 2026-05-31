import http from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ListLibrary } from "../../application/list-library.ts";
import type { SaveAnalysis } from "../../application/save-analysis.ts";
import type { StreamAudio } from "../../application/stream-audio.ts";
import type { ManageCrates } from "../../application/manage-crates.ts";
import type { GetCover } from "../../application/get-cover.ts";
import type { SearchRemote } from "../../application/search-remote.ts";
import type { ImportRemoteTrack } from "../../application/import-remote-track.ts";
import type { ManageRemoteLibraries } from "../../application/manage-remote-libraries.ts";
import type { EnrichLibrary } from "../../application/enrich-library.ts";
import type { AnalyzeLibrary } from "../../application/analyze-library.ts";
import type { BuildBeatGrids } from "../../application/build-beat-grids.ts";
import type { GetBeatGrid } from "../../application/get-beat-grid.ts";
import type { Config } from "../../infrastructure/config.ts";
import type { SessionStore } from "../../infrastructure/session-store.ts";
import type { AuthService } from "../../application/auth-service.ts";
import { sendJson, sendError } from "./responder.ts";
import { readJsonBody } from "./body.ts";
import { parseRange } from "./range.ts";
import { serveStatic, serveHtmlTemplate } from "./static-files.ts";
import { APP_VERSION } from "../../infrastructure/app-version.ts";

/** Static assets ship at <repo>/public. Hard-coded — no deployment has
 *  ever wanted to serve them from elsewhere, and the Docker image bakes
 *  this layout in. */
const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../public",
);

export interface UseCases {
  listLibrary: ListLibrary;
  saveAnalysis: SaveAnalysis;
  streamAudio: StreamAudio;
  manageCrates: ManageCrates;
  getCover: GetCover;
  searchRemote: SearchRemote;
  importRemoteTrack: ImportRemoteTrack;
  manageRemoteLibraries: ManageRemoteLibraries;
  enrichLibrary: EnrichLibrary;
  analyzeLibrary: AnalyzeLibrary;
  buildBeatGrids: BuildBeatGrids;
  getBeatGrid: GetBeatGrid;
}

/** Composition supplies this (an infrastructure watcher); the interface
 *  layer only depends on the shape, not the implementation. */
export interface LibraryEvents {
  subscribe(listener: () => void): () => void;
}

const SESSION_COOKIE = "dj_sess";

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      out[part.slice(0, i).trim()] = decodeURIComponent(
        part.slice(i + 1).trim(),
      );
    }
  }
  return out;
}

function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; ` +
      `SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`,
  );
}

function clearSessionCookie(res: ServerResponse): void {
  res.setHeader(
    "Set-Cookie",
    `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`,
  );
}

/** Routes a guest (crowd) or unauthenticated visitor may reach. The
 *  DJ SPA entry and all DJ data/mutation APIs are gated. */
function isPublicRoute(method: string, p: string): boolean {
  if (p === "/" || p === "/index.html" || p === "/mobile" || p === "/mobile.html") return false; // DJ SPA → login
  if (!p.startsWith("/api/")) return true; // static (bundled JS/CSS, /crowd, /login)
  if (p.startsWith("/api/auth/")) return true;
  if (method === "GET" && p === "/api/version") return true;
  if (
    method === "GET" &&
    (p === "/api/library" ||
      p === "/api/remote-search" ||
      p === "/api/remote-status" ||
      p === "/api/audio" ||
      p === "/api/cover" ||
      p === "/api/beat-grid" ||
      p === "/api/events" ||
      p === "/api/session")
  ) {
    return true;
  }
  if (
    method === "POST" &&
    (p === "/api/session/sync" || p === "/api/session/queue")
  ) {
    return true; // crowd → DJ live queue
  }
  return false; // analyze, crates, remote-import, POST /api/session (create)
}

export function buildServer(
  useCasesFor: (uid: string) => UseCases,
  config: Config,
  events: LibraryEvents,
  sessions: SessionStore,
  auth: AuthService,
): Server {
  // per-request scope. `ctx.uc` is the use-case set bound to
  // the caller's music dir; `ctx.uid` is the owning account ("" when
  // auth is off → legacy flat layout).
  interface Ctx {
    uc: UseCases;
    uid: string;
  }
  const handlers: Record<
    string,
    (
      req: IncomingMessage,
      res: ServerResponse,
      url: URL,
      ctx: Ctx,
    ) => Promise<void>
  > = {
    "GET /api/library": async (_req, res, url, ctx) => {
      const sp = url.searchParams;
      const sortRaw = sp.get("sort");
      const { tracks, total, offset, limit } =
        await ctx.uc.listLibrary.page({
          q: sp.get("q") ?? "",
          sort:
            sortRaw === "bpm" || sortRaw === "energy" ? sortRaw : "title",
          dir: sp.get("dir") === "desc" ? "desc" : "asc",
          limit: Math.max(1, Math.min(200, Number(sp.get("limit")) || 20)),
          offset: Math.max(0, Number(sp.get("offset")) || 0),
        });
      sendJson(res, 200, {
        musicDir: config.musicDir,
        count: total,
        total,
        offset,
        limit,
        tracks,
      });
    },

    // Server-side enrichment: persist tags/key/cover (+ TBPM bpm) for
    // tracks that have never been analysed. DJ-only (auth-gated).
    "POST /api/scan": async (_req, res, _url, ctx) => {
      const result = await ctx.uc.enrichLibrary.execute();
      sendJson(res, 200, { ok: true, ...result });
    },

    // Backend bulk audio analysis (ffmpeg + DSP) of EVERY row missing
    // any of bpm/key/mode/camelot/energy. Runs in the background (can
    // be long); the library fills in as rows update. DJ-only.
    "POST /api/analyze-all": async (_req, res, _url, ctx) => {
      void ctx.uc.analyzeLibrary.execute().catch(() => {
        /* best-effort background job */
      });
      sendJson(res, 200, { ok: true, started: true });
    },

    // bulk beat-grid backfill for every track without one
    // (or with an out-of-date analyzer version). Background job. DJ-only.
    "POST /api/build-grids": async (_req, res, _url, ctx) => {
      void ctx.uc.buildBeatGrids.execute().catch(() => {
        /* best-effort background job */
      });
      sendJson(res, 200, { ok: true, started: true });
    },

    "POST /api/analyze": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        path?: unknown;
        bpm?: unknown;
        key?: unknown;
        mode?: unknown;
        camelot?: unknown;
        energy?: unknown;
      };
      const result = await ctx.uc.saveAnalysis.execute(body?.path, body?.bpm, {
        key: body?.key,
        mode: body?.mode,
        camelot: body?.camelot,
        energy: body?.energy,
      });
      sendJson(res, 200, { ok: true, ...result });
    },

    // per-track beat grid (server-computed, persisted in
    // BeatGridRepository). Browser fetches this when a deck loads, so
    // we keep it OUT of /api/library to avoid bloating the page payload.
    "GET /api/beat-grid": async (_req, res, url, ctx) => {
      const path = url.searchParams.get("path") ?? "";
      const grid = await ctx.uc.getBeatGrid.execute(path);
      if (!grid) {
        sendJson(res, 404, { error: "no beat grid" });
        return;
      }
      sendJson(res, 200, {
        path,
        durationSec: grid.durationSec,
        beats: Array.from(grid.beats),
        downbeatPhase: grid.downbeatPhase,
        firstSolidCueSec:
          grid.firstSolidBeatIndex >= 0
            ? grid.beats[grid.firstSolidBeatIndex] ?? null
            : null,
        confidence: grid.confidence,
      });
    },

    "GET /api/cover": async (_req, res, url, ctx) => {
      const cover = await ctx.uc.getCover.execute(
        url.searchParams.get("path") ?? "",
      );
      if (!cover) {
        sendJson(res, 404, { error: "no cover" });
        return;
      }
      const body = Buffer.from(cover.data);
      res.writeHead(200, {
        "Content-Type": cover.mime || "image/jpeg",
        "Content-Length": body.length,
        "Cache-Control": "public, max-age=86400",
      });
      res.end(body);
    },

    "POST /api/session": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        id?: unknown;
        config?: Partial<{
          automix: boolean;
          autoFill: boolean;
          beatSync: boolean;
          fadeSeconds: number;
          showUpNext: boolean;
        }>;
      };
      const c = body?.config ?? {};
      const id = sessions.create(
        {
          automix: c.automix === true,
          autoFill: c.autoFill === true,
          beatSync: c.beatSync !== false,
          fadeSeconds:
            typeof c.fadeSeconds === "number" ? c.fadeSeconds : 8,
          showUpNext: c.showUpNext !== false,
        },
        body?.id,
        ctx.uid, // this session is owned by the logged-in DJ
      );
      sendJson(res, 200, {
        id,
        url: `${config.publicBaseUrl}/crowd?s=${id}`,
      });
    },

    "GET /api/session": async (_req, res, url, ctx) => {
      const snap = sessions.get(url.searchParams.get("id") ?? "");
      if (!snap) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      sendJson(res, 200, snap);
    },

    // DJ poll: hand back crowd adds since last call, record what the
    // DJ has played/loaded so the same track can't be re-queued.
    "POST /api/session/sync": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        id?: unknown;
        played?: unknown;
        nowPlaying?: unknown;
      };
      const id = typeof body?.id === "string" ? body.id : "";
      const played = Array.isArray(body?.played)
        ? (body.played as unknown[]).filter(
            (p): p is string => typeof p === "string",
          )
        : [];
      if (!sessions.has(id)) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      const np = body?.nowPlaying;
      if (np === null) {
        sessions.setNowPlaying(id, null);
      } else if (np !== undefined && typeof np === "object") {
        const o = np as Record<string, unknown>;
        if (typeof o.name === "string") {
          sessions.setNowPlaying(id, {
            name: o.name,
            artist: typeof o.artist === "string" ? o.artist : null,
            bpm: typeof o.bpm === "number" ? o.bpm : null,
            path: typeof o.path === "string" ? o.path : null,
            by: typeof o.by === "string" ? o.by : null,
          });
        }
      }
      sendJson(res, 200, { pending: sessions.drain(id, played) });
    },

    // wipe the played-tracks dedup set so guests
    // can re-request earlier songs. NOT public — DJ-only, and only the
    // owning DJ can clear their own session.
    "POST /api/session/clear-played": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        id?: unknown;
      };
      const id = typeof body?.id === "string" ? body.id : "";
      if (!sessions.has(id)) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      // Auth is "DJ-only and owner-only". When auth is disabled (no
      // SESSION_SECRET, ctx.uid === ""), owner is "" too — falls
      // through. With auth on, ctx.uid is the logged-in DJ and must
      // match the session's owner.
      if (sessions.ownerOf(id) !== ctx.uid) {
        sendJson(res, 403, { error: "not the session owner" });
        return;
      }
      sessions.clearPlayed(id);
      sendJson(res, 200, { ok: true });
    },

    // DJ updates live session config (e.g. showUpNext toggle).
    // Owner-only; merges only the fields provided.
    "PATCH /api/session/config": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        id?: unknown;
        showUpNext?: unknown;
      };
      const id = typeof body?.id === "string" ? body.id : "";
      if (!sessions.has(id)) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      if (sessions.ownerOf(id) !== ctx.uid) {
        sendJson(res, 403, { error: "not the session owner" });
        return;
      }
      if (typeof body?.showUpNext === "boolean") {
        sessions.patchConfig(id, { showUpNext: body.showUpNext });
      }
      sendJson(res, 200, { ok: true });
    },

    // Crowd add. Local track → enqueue by path; remote track →
    // download into the library first, then enqueue. Replays of an
    // already played/queued track are rejected.
    "POST /api/session/queue": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        id?: unknown;
        name?: unknown;
        path?: unknown;
        bpm?: unknown;
        remoteId?: unknown;
        by?: unknown;
      };
      const id = typeof body?.id === "string" ? body.id : "";
      if (!sessions.has(id)) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      // the guest who requested it (first-name, capped) — credited in the
      // DJ's queue and on the now-playing card.
      const by =
        typeof body?.by === "string" && body.by.trim() !== ""
          ? body.by.trim().slice(0, 24)
          : null;
      // crowd adds land in the session OWNER's library (the
      // session id is in the body, so re-scope here).
      const ownerUc = useCasesFor(sessions.ownerOf(id));
      let item: { name: string; path: string; bpm: number | null; by: string | null };
      if (
        typeof body?.remoteId === "string" &&
        body.remoteId.trim() !== ""
      ) {
        const label =
          typeof body?.name === "string" && body.name.trim() !== ""
            ? body.name.trim()
            : body.remoteId.trim();
        const { path } = await ownerUc.importRemoteTrack.execute(
          body.remoteId,
          label,
        );
        item = { name: label, path, bpm: null, by };
      } else {
        const path =
          typeof body?.path === "string" ? body.path.trim() : "";
        if (path === "") {
          sendJson(res, 400, { error: "missing path" });
          return;
        }
        item = {
          name:
            typeof body?.name === "string" && body.name.trim() !== ""
              ? body.name.trim()
              : path,
          path,
          bpm: typeof body?.bpm === "number" ? body.bpm : null,
          by,
        };
      }
      const status = sessions.enqueue(id, item);
      if (status === "not-found") {
        sendJson(res, 404, { error: "session not found" });
      } else if (status === "played") {
        sendJson(res, 409, { error: "already played", name: item.name });
      } else {
        sendJson(res, 200, { ok: true, name: item.name });
      }
    },

    "GET /crowd": async (_req, res) => {
      await serveHtmlTemplate(res, "/crowd.html", PUBLIC_DIR, { APP_VERSION });
    },

    "GET /mobile": async (_req, res) => {
      await serveHtmlTemplate(res, "/mobile.html", PUBLIC_DIR, { APP_VERSION });
    },

    "GET /party-mode": async (_req, res) => {
      await serveStatic(res, "/party-mode-prototype.html", PUBLIC_DIR);
    },

    // ── Auth / 2FA ──────────────────────────────────────
    "GET /login": async (_req, res, _url, ctx) => {
      await serveStatic(res, "/login.html", PUBLIC_DIR);
    },

    // Public capability probe so the login page can hide the
    // "create account" link when self-service registration is closed.
    "GET /api/auth/status": async (_req, res, _url, _ctx) => {
      sendJson(res, 200, { registrationOpen: config.registrationOpen });
    },

    // Build stamp — used by ops to confirm a deploy landed.
    "GET /api/version": async (_req, res, _url, _ctx) => {
      sendJson(res, 200, { version: APP_VERSION });
    },

    "POST /api/auth/register": async (req, res, _url, ctx) => {
      if (!config.registrationOpen) {
        sendJson(res, 403, { error: "Registration is closed" });
        return;
      }
      const b = (await readJsonBody(req, config.bodyLimitBytes)) as {
        username?: string;
        password?: string;
      };
      const e = await auth.register(b?.username ?? "", b?.password ?? "");
      sendJson(res, 200, {
        username: e.username,
        otpauthUri: e.otpauthUri,
        secret: e.secret,
        recoveryCodes: e.recoveryCodes,
      });
    },

    "POST /api/auth/confirm": async (req, res, _url, ctx) => {
      const b = (await readJsonBody(req, config.bodyLimitBytes)) as {
        username?: string;
        password?: string;
        code?: string;
      };
      const token = await auth.confirmTotp(
        b?.username ?? "",
        b?.password ?? "",
        b?.code ?? "",
      );
      setSessionCookie(res, token);
      sendJson(res, 200, { ok: true });
    },

    "POST /api/auth/skip-mfa": async (req, res, _url, ctx) => {
      const b = (await readJsonBody(req, config.bodyLimitBytes)) as {
        username?: string;
        password?: string;
      };
      const token = await auth.skipMfa(
        b?.username ?? "",
        b?.password ?? "",
      );
      setSessionCookie(res, token);
      sendJson(res, 200, { ok: true });
    },

    "POST /api/auth/login": async (req, res, _url, ctx) => {
      const b = (await readJsonBody(req, config.bodyLimitBytes)) as {
        username?: string;
        password?: string;
        code?: string;
      };
      const token = await auth.login(
        b?.username ?? "",
        b?.password ?? "",
        b?.code ?? "",
      );
      setSessionCookie(res, token);
      sendJson(res, 200, { ok: true });
    },

    "POST /api/auth/logout": async (_req, res, _url, ctx) => {
      clearSessionCookie(res);
      sendJson(res, 200, { ok: true });
    },

    // Plain link target so the header needs no JS (keeps app.ts clean).
    "GET /logout": async (_req, res, _url, ctx) => {
      clearSessionCookie(res);
      res.writeHead(302, { Location: "/login" });
      res.end();
    },

    "GET /api/auth/me": async (req, res, _url, ctx) => {
      const user = await auth.userFromToken(
        parseCookies(req.headers.cookie)[SESSION_COOKIE],
      );
      if (!user) {
        sendJson(res, 200, { authenticated: false });
        return;
      }
      sendJson(res, 200, {
        authenticated: true,
        username: user.username,
      });
    },

    "GET /api/events": async (req, res, _url, ctx) => {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write(": connected\n\n");
      const unsubscribe = events.subscribe(() => {
        res.write("data: changed\n\n");
      });
      const heartbeat = setInterval(() => res.write(": ping\n\n"), 25000);
      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.on("close", cleanup);
      res.on("close", cleanup);
    },

    "GET /api/crates": async (_req, res, _url, ctx) => {
      const crates = await ctx.uc.manageCrates.list();
      sendJson(res, 200, { crates });
    },

    "POST /api/crates": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        name?: unknown;
        trackIds?: unknown;
      };
      const result = await ctx.uc.manageCrates.save(
        body?.name,
        body?.trackIds,
      );
      sendJson(res, 200, { ok: true, ...result });
    },

    "POST /api/crates/delete": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        name?: unknown;
      };
      const result = await ctx.uc.manageCrates.remove(body?.name);
      sendJson(res, 200, { ok: true, ...result });
    },

    // Capability probe so the client can hide remote search when no
    // remote is configured for this user.
    "GET /api/remote-status": async (_req, res, _url, ctx) => {
      sendJson(res, 200, { enabled: await ctx.uc.searchRemote.enabled() });
    },

    "GET /api/remote/sources": async (_req, res, _url, ctx) => {
      const items = await ctx.uc.manageRemoteLibraries.list(ctx.uid);
      const canManage = await ctx.uc.manageRemoteLibraries.canManage(ctx.uid);
      sendJson(res, 200, { items, canManage });
    },
    "POST /api/remote/sources": async (req, res, _url, ctx) => {
      const body = await readJsonBody(req, config.bodyLimitBytes);
      const created = await ctx.uc.manageRemoteLibraries.add(ctx.uid, body);
      sendJson(res, 201, created);
    },
    "PATCH /api/remote/sources": async (req, res, url, ctx) => {
      const id = (url.searchParams.get("id") ?? "").trim();
      const body = await readJsonBody(req, config.bodyLimitBytes);
      const updated = await ctx.uc.manageRemoteLibraries.update(
        ctx.uid,
        id,
        body,
      );
      sendJson(res, 200, updated);
    },
    "DELETE /api/remote/sources": async (_req, res, url, ctx) => {
      const id = (url.searchParams.get("id") ?? "").trim();
      await ctx.uc.manageRemoteLibraries.delete(ctx.uid, id);
      sendJson(res, 200, { ok: true });
    },
    "POST /api/remote/active": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        id?: unknown;
      };
      const id = typeof body?.id === "string" ? body.id.trim() : "";
      await ctx.uc.manageRemoteLibraries.setActive(ctx.uid, id);
      sendJson(res, 200, { ok: true });
    },

    "GET /api/remote-search": async (_req, res, url, ctx) => {
      const page = await ctx.uc.searchRemote.execute(
        url.searchParams.get("q"),
        url.searchParams.get("offset"),
      );
      sendJson(res, 200, { ...page, enabled: true });
    },

    "POST /api/remote-import": async (req, res, _url, ctx) => {
      const body = (await readJsonBody(req, config.bodyLimitBytes)) as {
        remoteId?: unknown;
        name?: unknown;
      };
      const result = await ctx.uc.importRemoteTrack.execute(
        body?.remoteId,
        body?.name,
      );
      sendJson(res, 200, { ok: true, ...result });
    },

    "GET /api/audio": async (req, res, url, ctx) => {
      const stat = await ctx.uc.streamAudio.stat(
        url.searchParams.get("path") ?? "",
      );
      const range = parseRange(req.headers.range, stat.size);
      if (range.kind === "unsatisfiable") {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        res.end();
        return;
      }
      if (range.kind === "range") {
        res.writeHead(206, {
          "Content-Type": stat.contentType,
          "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": range.end - range.start + 1,
          "Cache-Control": "no-cache",
        });
        ctx.uc.streamAudio.open(stat.id, range).pipe(res);
        return;
      }
      res.writeHead(200, {
        "Content-Type": stat.contentType,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
      ctx.uc.streamAudio.open(stat.id, null).pipe(res);
    },
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(
        req.url ?? "/",
        `http://${req.headers.host ?? "localhost"}`,
      );
      const method = req.method ?? "GET";
      const authedUser = auth.configured
        ? await auth.userFromToken(
            parseCookies(req.headers.cookie)[SESSION_COOKIE],
          )
        : null;

      // auth gate. Disabled when SESSION_SECRET is unset so
      // existing setups keep working; enabled the moment it's set.
      if (
        auth.configured &&
        !isPublicRoute(method, url.pathname) &&
        !authedUser
      ) {
        const wantsHtml =
          url.pathname === "/" ||
          url.pathname.endsWith(".html") ||
          (req.headers.accept ?? "").includes("text/html");
        if (wantsHtml) {
          res.writeHead(302, { Location: "/login" });
          res.end();
        } else {
          sendJson(res, 401, { error: "authentication required" });
        }
        return;
      }

      // which account's music dir this request acts in. The DJ
      // → their own; an unauthenticated crowd request → the session
      // owner (id in ?s= / ?id=); otherwise root (auth off → legacy).
      let uid = authedUser?.id ?? "";
      if (!uid) {
        const sid =
          url.searchParams.get("s") ?? url.searchParams.get("id") ?? "";
        if (sid) uid = sessions.ownerOf(sid);
      }
      const ctx: Ctx = { uc: useCasesFor(uid), uid };

      const handler = handlers[`${method} ${url.pathname}`];
      if (handler) {
        await handler(req, res, url, ctx);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        sendJson(res, 404, { error: "unknown endpoint" });
        return;
      }
      // The DJ SPA entry is the one HTML doc that needs templated
      // substitution — we bake APP_VERSION into the script URL (so a
      // new deploy busts the cached `app.js`) and into the footer
      // chip. Other static files (CSS, JS bundle, /crowd, /login)
      // stay on the plain `serveStatic` path.
      if (url.pathname === "/" || url.pathname === "/index.html") {
        await serveHtmlTemplate(res, url.pathname, PUBLIC_DIR, {
          APP_VERSION,
        });
        return;
      }
      await serveStatic(res, url.pathname, PUBLIC_DIR);
    } catch (err) {
      sendError(res, err);
    }
  });
}
