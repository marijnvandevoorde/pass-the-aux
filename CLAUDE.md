# CLAUDE.md

Guidance for Claude Code working in this repository. Read `README.md` for
the user-facing overview; this file is the working contract.

## What this is

**Pass the Aux** — a small-party DJ mixer for the rest of us. Two browser
decks, a curated set built collaboratively with friends, and an optional
extended search over user-configured remote record stores.

Full TypeScript, layered/DDD, **near-zero runtime dependencies** — Node runs
the server `.ts` directly via native type-stripping; the browser bundle is
the only build step.

**Sanctioned runtime dependency:** `mysql2` — the *only* allowed runtime
dep. Confined to the MySQL Storage adapters in `src/infrastructure/mysql-*`
and reached only when `STORAGE_DRIVER=mysql`. The default `sqlite` driver
uses the built-in `node:sqlite` and stays dependency-free. Adding any
further runtime dep needs explicit approval.

**Sanctioned system tool:** `ffmpeg` — a *system binary*, not an npm dep.
Used only by `src/infrastructure/ffmpeg-audio-analyzer.ts` to decode audio
→ PCM for server-side BPM/key/energy analysis (the DSP itself reuses the
browser's pure `src/web/tempo-estimate.ts` / `track-features.ts`).
Spawned via `child_process`; absent ffmpeg ⇒ analysis is skipped
gracefully (no crash). Installed in the Docker runtime image.

## Commands

```bash
npm run typecheck   # tsc -p tsconfig.json — no emit (src, test, server.ts)
npm run build       # tsc -p tsconfig.web.json — compiles src/web -> public/js
npm test            # node:test suite (domain, application, infra, http e2e)
npm start           # build web bundle, then run server.ts (port 5174)
npm run serve       # run server without rebuilding the bundle
```

Before considering any code change done: `npm run typecheck && npm test`,
plus `npm run build` if anything under `src/web/` changed.

## Architecture — the rules that matter

Single bounded context (**Music Library**), strict dependency inversion.
Inner layers must never import outer ones:

```
domain/         entities, value objects (Track, Tempo, TrackId), errors,
                and ports (repository/source interfaces). Imports nothing.
application/    use cases (ListLibrary, SaveAnalysis, StreamAudio,
                ManageRemoteLibraries, ...). Depends only on domain ports.
infrastructure/ adapters: fs repos, sqlite + mysql repos, config,
                mime, path-safety, the remote-library HTTP client.
interface/http/ delivery: router, range parsing, responders, statics.
main.ts         composition root — the ONLY place adapters are wired
                into use cases. Keep wiring here, not scattered.
web/            browser app (Deck, Mixer, Automix, bpm); its own
                real-time "Mixing" context, compiled to public/js.
```

When adding a feature: define/extend a port in `domain/ports/`, implement
the use case in `application/`, add the adapter in `infrastructure/`, wire
it in `main.ts`. Don't let HTTP or `fs` types leak into domain/application.

## Companion projects (external repos)

Two optional companion services used to live here as submodules; they're
now their own repositories. This project runs fine without them; they
plug in over HTTP on a shared docker network (`pta`) when present:

- **[pass-the-remote](https://github.com/marijnvandevoorde/pass-the-remote)** — the self-hosted "remote record store" server. Scans a folder, indexes in SQLite, exposes the Pass the Aux wire contract (`/api/get-music`, `/api/stream-music`) gated by a Bearer secret. Container name `pass-the-remote`.
- **[pass-the-beat](https://github.com/marijnvandevoorde/pass-the-beat)** — neural beat-tracking sidecar wrapping the [beat-this](https://github.com/CPJKU/beat_this) model (`BEAT_ANALYZER=pass-the-beat`). Without it, the built-in BPM detector handles tracks with a clear beat; with it, beat-grids are dramatically more accurate, sync is solid, and DJ'ing is meaningfully better. Container name `pass-the-beat`.

These are *external* — never check them out inside this repo, never wire
them into our compose file directly. The README's *Docker → Running with
companions* shows the side-by-side compose pattern.

## Remote record stores

Each user can configure N **remote record stores** (Settings → Remote
record stores). One is `is_active` and serves the extended-search overlay.
Three kinds are supported:

- `pta` — a server speaking the Pass the Aux wire contract (e.g. a
  [pass-the-remote](https://github.com/marijnvandevoorde/pass-the-remote)
  instance, or anything else implementing the same endpoints). Needs a
  base URL and a Bearer secret.
- `jamendo` — Creative Commons catalog. Needs a free Jamendo `client_id`
  (stored in the row's `apiKey`). Adapter: `JamendoSource`.
- `fma` — Free Music Archive. *(adapter paused — FMA closed its public API.)*

Storage: `remote_libraries` table (same schema in both sqlite and mysql).
The repository enforces exactly-one-active per user.

## Code conventions

- **ESM, `.ts` extensions in relative imports** (`./foo.ts`) — required by
  `allowImportingTsExtensions` + `verbatimModuleSyntax`. Use
  `import type` for type-only imports.
- TS is **strict** with `noUncheckedIndexedAccess`, `noImplicitOverride`,
  `noFallthroughCasesInSwitch`, `erasableSyntaxOnly`, `isolatedModules`.
  No enums / namespaces / parameter properties (type-stripping only erases
  types — `erasableSyntaxOnly` enforces this).
- **Near-zero runtime dependencies.** The only runtime dep is `mysql2` —
  used solely by the MySQL Storage adapters. Everything else:
  `devDependencies` are tooling only (TypeScript, `@types/node`). Do not
  add another runtime dep without explicit approval — reach for the Node
  stdlib first (`node:sqlite`, `node:crypto`, `node:http`).
- Entities are immutable (see `Track.withBpm` returning a new instance);
  expose a `toJSON()` wire format rather than leaking internals.
- Config comes from the environment (`src/infrastructure/config.ts`,
  `.env.example`). `.env` is gitignored — secrets there, never in source.
  Remote record stores are NOT env-driven: they're configured per-user
  via Settings → Remote record stores (the `ManageRemoteLibraries` use
  case + repository).
- `music/` is gitignored except `music/.gitkeep`; never commit audio files
  or the local `.pass-the-aux.sqlite` database.

## Testing

`node:test` (`test/**/*.test.ts`). Tests swap in-memory fakes for the
domain ports — keep ports narrow so this stays easy. The browser layer
(`src/web/`, Web Audio) is not unit-tested headlessly; cover logic in the
server layers instead.

## Project tracking — Notion

Sprint/state is tracked on the **Pass the Aux — Scrum Board** Notion
database:

- Data source: `collection://f959b4f4-7937-40bf-a281-75e1afed06b7`
- Query the data source to discover the current sprint — never
  hard-code it; sprints roll over.
- `Status` flow: `Backlog → To Do → In Progress → In Review → Done`
  (`Cancelled` is terminal).
- `Priority`: `P0 — Critical` → `P3 — Low` (P0 first).
- Other props: `Type` (multi-select), `Story Points`, `Notes`,
  `Task` (title), `ID` (auto-increment).

When you finish a tracked task, move its card forward (typically to
`In Review`) and leave a short note. The **`/sprint-task`** skill
automates "pick the next sprint item → implement → update Notion".
Use the Notion MCP tools (`notion-query-database-view`,
`notion-update-page`, `notion-fetch`) to read/update cards.

## Don'ts

- Don't add runtime dependencies (beyond the sanctioned `mysql2`) or a
  build step for the server.
- Don't commit anything under `music/` (except `.gitkeep`), `.env`, or
  `public/js/` (generated).
- Don't import outward across layers or wire adapters outside `main.ts`.
- Don't mark a Notion card `Done` automatically — `In Review` is the
  handoff; a human closes it.
