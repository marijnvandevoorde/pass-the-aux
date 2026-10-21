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

**Sanctioned runtime dependency:** `aws4fetch` — a small, dependency-free
SigV4 signer, used only by `src/infrastructure/s3-bucket.ts` when the
library lives in a bucket (`S3_BUCKET`). Chosen over the AWS SDK (~100
packages for five calls) and over a hand-rolled signer.

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

## Where the library lives

`MUSIC_DIR` on disk (default), or an S3-compatible bucket when `S3_BUCKET`
is set (production: OCI Object Storage). Both use the same layout,
`<uid>/<file>` with a `<base>.jpg` cover next to each track, and every
`Fs*` adapter has an `S3*` twin in `src/infrastructure/s3-library.ts`;
`main.ts` picks one set. A bucket can't be watched, so imports announce
themselves through `LibraryChangeNotifier`, and the 5-minute sweep is
the backstop. ffmpeg works on short-lived temp copies (`LocalFiles`).

## Beat grids and pass-the-beat

With `BEAT_ANALYZER=pass-the-beat`, `AnalyzeLibrary` stays local (key,
energy and a provisional BPM) and only `BuildBeatGrids` talks to the
sidecar, uploading each track. The grid's BPM then replaces the
provisional one. If the sidecar is unavailable, `analyzeBeats` throws
`AnalyzerUnavailableError` and the run stops without storing anything,
so no track is ever marked done with a fallback result. An empty grid
means "analysed, no pulse" (stored so it isn't retried; the API serves
it as 404). A sidecar 500 on one track (`TrackAnalysisFailedError`) is
retried on later sweeps and stored as empty only after 3 failures; tracks
that failed go to the back of the next sweep, so one bad track can't
block the rest. Tracks that need a grid soon (loaded, queued, crowd
requests: `GridDemand`) are built by a separate wanted-grid lane in
`main.ts`, one at a time beside the sweep; `GridDemand.claim` keeps the
two off the same track, so pass-the-beat sees at most two uploads at once.
The bar phase comes from the sidecar's `downbeatPhase`
when it sends one (pass-the-beat ≥ analyzerVersion 2). From analyzer v3
the sidecar also sends `barStarts` (every bar's downbeat; stored as
`beat_grids.bars_blob`, Int32 LE) and `mixOutBeat` (`mix_out_index`);
the browser counts bars from `barStarts` (`downbeatFlags`) and falls
back to `i % 4` from the phase without it. Schema changes are guarded
`addColumnIfMissing` calls in `sqlite-pool.ts` / `mysql-pool.ts`. With `PASS_THE_BEAT_K8S_DEPLOYMENT` set, `ScaledWorker`
scales the sidecar up for a batch and back to zero when idle.

## spotify-api on demand

The same `ScaledWorker` runs spotify-api (the Spotify remote record
store, repo `sptf`) on demand when `SPOTIFY_API_K8S_DEPLOYMENT` is set.
`main.ts` wraps an active `pta` remote whose base URL points at
`SPOTIFY_API_URL` in `OnDemandRemoteSource`: `GET /api/remote-status`
(asked when the app loads) warms it up, every search/import holds it,
and a call that finds it down waits `SPOTIFY_API_WAIT_SECONDS` before
answering 503 "starting up, try again in a moment" (`RemoteStartingError`)
while the start carries on. It goes back to zero after
`SPOTIFY_API_IDLE_SECONDS` (default 900) without Spotify calls.
spotify-api keeps no state a restart would lose: a cold start just logs
in to Spotify again.

## Party sessions

The party (crowd requests, played tracks, Up Next, now playing, votes)
lives in `SessionStore` (`infrastructure/session-store.ts`) in memory,
written through to `PartySessionRepository` (`party_session*` tables,
sqlite and mysql), so a restart or deploy keeps it and guests' QR links
keep working: an unknown id is loaded on first use. The playhead is
only stored with a new track or play/pause (the DJ re-sends it every
sync); an unchanged Up Next or played list isn't written. Every stored
change bumps `rev`; a cached session is re-checked every 5 s (and
before handing out or accepting a request), so the old and new pod of a
rolling deploy stay in step. Votes and played tracks are rows keyed by
a SHA-1 of the path, so two pods never undo each other. Sessions idle
for 48 h are deleted (`sweep`, hourly). A failed write is logged and
the party carries on from memory.

## Deploying

`npm run deploy` (`scripts/deploy.sh`) runs the shared `sv-deploy` from
the Oracle repo with `deploy.env`: it builds origin/main, rolls the
`pass-the-aux` Deployment on the cluster sv-oke and records the tag in
the Oracle repo. The ghcr/VPS flow is history.

## Companion projects (external repos)

Two optional companion services used to live here as submodules; they're
now their own repositories. This project runs fine without them; they
plug in over HTTP on a shared docker network (`pta`) when present:

- **[pass-the-remote](https://github.com/marijnvandevoorde/pass-the-remote)** — the self-hosted "remote record store" server. Scans a folder, indexes in SQLite, exposes the Pass the Aux wire contract (`/api/get-music`, `/api/stream-music`) gated by a Bearer secret. Container name `pass-the-remote`.
- **[pass-the-beat](https://github.com/marijnvandevoorde/pass-the-beat)** — neural beat-tracking sidecar wrapping the [beat-this](https://github.com/CPJKU/beat_this) model (`BEAT_ANALYZER=pass-the-beat`). Without it, the built-in BPM detector handles tracks with a clear beat; with it, beat-grids are dramatically more accurate, sync is solid, and DJ'ing is meaningfully better. Container name `pass-the-beat`.

These are *external* — never check them out inside this repo, never wire
them into `docker-compose.yml` directly (the opt-in
`docker-compose.dev.example.yml` builds them from sibling checkouts). The README's *Docker → Running with
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
- **Near-zero runtime dependencies.** The runtime deps are `mysql2` —
  used solely by the MySQL Storage adapters — and `aws4fetch`, used
  solely by the S3 bucket client. Everything else:
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
- `music/` is gitignored except `music/.gitkeep` and the CC0 demo OGGs listed
  in `CREDITS.md`; never commit other audio files or the local
  `.pass-the-aux.sqlite` database. Any audio committed anywhere (demo
  tracks, `public/samples/`) must be provably free to redistribute and
  credited in `CREDITS.md`.

## Testing

`node:test` (`test/**/*.test.ts`). Tests swap in-memory fakes for the
domain ports — keep ports narrow so this stays easy. The browser layer
(`src/web/`, Web Audio) is not unit-tested headlessly; cover logic in the
server layers instead.

UI work: run `npm run visual-test` (pixel diff of mobile, crowd, party
screen and desktop queue) before and after; `npm run visual-update` takes new
baselines. Local only: the baselines are made on macOS.

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
- Don't commit anything under `music/` (except `.gitkeep` and the CC0 demo
  OGGs), `.env`, or
  `public/js/` (generated).
- Don't import outward across layers or wire adapters outside `main.ts`.
- Don't mark a Notion card `Done` automatically — `In Review` is the
  handoff; a human closes it.
