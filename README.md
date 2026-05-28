<p align="center">
  <img src="passtheaux.png" alt="Pass the Aux" width="180" />
</p>

# Pass the Aux

A small-party DJ mixer for the rest of us — two browser decks, a curated
set built collaboratively with friends, crowd suggestions over a QR code,
and an optional extended search across your own remote record stores.

Full TypeScript, layered/DDD, **near-zero runtime dependencies**: Node
runs the server `.ts` directly via native type-stripping. The browser
bundle is the only build step.

## Features

- **Local library** — point it at any folder of audio files
  (`.mp3 .wav .flac .ogg .m4a .aac .opus`), scanned recursively.
- **Automatic BPM analysis** — in the browser via the Web Audio API
  (offline low-pass + peak/interval detection). Persisted to the
  database (SQLite or MySQL), keyed by file size + mtime, so each track
  is analyzed exactly once.
- **Search** — filter the library by name, sub-folder, or BPM.
- **Two decks** — independent waveform, play/pause, cue, click-to-seek,
  one-click BPM **SYNC**, pitch-bend nudge, and a rotary-knob channel
  strip: vinyl tempo (±8%), 3-band EQ and channel volume.
- **Equal-power crossfader** + master gain (with a safety limiter).
- **Settings** (⚙ in the header) — choose separate master and
  headphone/cue output devices for silent deck pre-listening (PFL); manage
  your **remote record stores**.
- **Performance FX panel** — beginner-first XY pad (filter, echo,
  reverb, gate, flanger, phaser, bit-crush, alarm), one-touch macros,
  and a synth sample-pad grid.
- **Queue & automix** — auto-crossfades to the next queued track,
  preloading the idle deck so the blend is seamless.
- **Crowd requests** — share a session as a QR code or link; guests open
  the `/crowd` page on their phones to add tracks straight to the queue.
- **Extended search** — search across your configured remote record
  stores (self-hosted Pass the Aux servers, Jamendo, etc.) and import a
  track straight into your local library.
- Bonus: drag any audio file from your OS onto the page to load it.

## Remote record stores

Pass the Aux doesn't ship with a built-in catalog. Instead, you add your
own remote record stores in **Settings → Remote record stores**. Each
remote is stored per-user; exactly one is active at a time and powers
the extended-search overlay.

Three kinds are supported:

| Kind        | What it is                                                              |
| ----------- | ----------------------------------------------------------------------- |
| `pta`       | A self-hosted music server speaking the Pass the Aux wire contract — e.g. [pass-the-remote](https://github.com/marijnvandevoorde/pass-the-remote). URL + Bearer secret. |
| `jamendo`   | Creative Commons catalog (Jamendo). Free `client_id` — pick one up at [developer.jamendo.com](https://developer.jamendo.com/). |
| `fma`       | Free Music Archive. *Adapter paused — FMA closed its public API.*       |

You can run as many `pta` remotes as you want (your NAS, a friend's
server, ...) and switch active via a chip in the search overlay.

## Companion projects

Pass the Aux runs standalone. Two optional companion projects — each in
its own repository — make it nicer:

| Project | What it adds |
| ------- | ------------ |
| [pass-the-remote](https://github.com/marijnvandevoorde/pass-the-remote) | A self-hosted **remote record store**. Points at a folder, indexes it in SQLite, and exposes the Pass the Aux wire contract on `:3000` gated by a Bearer secret. Add it as a remote in Settings → Remote record stores. |
| [pass-the-beat](https://github.com/marijnvandevoorde/pass-the-beat)     | A neural beat-tracking sidecar wrapping the [beat-this](https://github.com/CPJKU/beat_this) model. Without it, Pass the Aux still does in-browser BPM detection (fine for tracks with a clear beat). With it, beat-grids land far more accurately, sync is rock-solid, and DJ'ing is meaningfully smoother — flip on with `BEAT_ANALYZER=pass-the-beat`. |

See *Docker → Running with companions* below for a side-by-side compose
setup.

## Architecture

Bounded context: **Music Library**. The server is layered with
dependency inversion — inner layers never import outer ones.

```
src/
  domain/          entities & value objects (Track, Tempo, TrackId),
                   errors, and ports (repository/source interfaces)
  application/     use cases: ListLibrary, SaveAnalysis, StreamAudio,
                   ManageRemoteLibraries, ...
  infrastructure/  adapters: filesystem repos, sqlite + mysql repos,
                   the remote record store HTTP client, JamendoSource, ...
  interface/http/  delivery: router, range parsing, responders, statics
  main.ts          composition root (wires adapters into use cases)
  web/             browser app — its own real-time "Mixing" context,
                   compiled to public/js
```

Tests swap in-memory fakes for the ports.

## Run

Requires **Node ≥ 24** (native TypeScript type-stripping + stable
`node:sqlite`). Use `nvm use 24` first if your default is older.

```bash
git clone https://github.com/marijnvandevoorde/pass-the-aux.git
cd pass-the-aux
npm install               # dev tooling only (TypeScript) — only mysql2 at runtime
MUSIC_DIR=/path/to/music npm start
# open http://localhost:5174
```

Drop any folder of `.mp3 .wav .flac .ogg .m4a .aac .opus` files at
`MUSIC_DIR` and the server scans it on boot. If you skip `MUSIC_DIR`, it
defaults to `./music` next to the repo — create the folder and add
audio there, or use the drag-and-drop one-off loader in the browser.

### Docker

```bash
docker compose up --build         # http://localhost:5174
```

`docker-compose.yml` brings up just the mixer on a shared bridge network
named `pta`. `docker-compose.prod.yml` is the same behind Traefik.

The image targets **Node 24+**; a multi-stage build compiles the browser
bundle and the runtime stage ships no dependencies. Mount your library by
editing the `volumes:` entry in `docker-compose.yml`.

#### Running with companions

Both companion projects join the same `pta` network, so the mixer can
reach them by container name (`pass-the-remote`, `pass-the-beat`).
Check them out next to this repo:

```bash
# Sibling checkouts:
#   ~/code/pass-the-aux/      (this repo)
#   ~/code/pass-the-remote/   (optional: the remote record store server)
#   ~/code/pass-the-beat/     (optional: neural beat-tracking sidecar)

git clone https://github.com/marijnvandevoorde/pass-the-remote.git ../pass-the-remote
git clone https://github.com/marijnvandevoorde/pass-the-beat.git   ../pass-the-beat
```

Start this project first — it owns the `pta` network:

```bash
docker compose up -d --build
```

Then bring up the companions; each declares `pta` as an external network
and registers itself as `pass-the-remote` / `pass-the-beat`. From inside
each companion repo:

```bash
docker compose up -d --build
```

Flip on the neural analyzer by setting `BEAT_ANALYZER=pass-the-beat` in this
project's `.env`. Add the remote record store under **Settings → Remote
record stores** (URL `http://pass-the-remote:3000` and the Bearer secret
you set when starting pass-the-remote).

#### Full stack with published images (MySQL + companions)

No source checkout required. Each repo's release workflow publishes a
container image to the GitHub Container Registry on every `vX.Y.Z` tag, so
you can run the whole project — the mixer on **MySQL**, the neural
**pass-the-beat** sidecar, and an externally-reachable **pass-the-remote**
record store — from prebuilt images.

> The images are public on `ghcr.io`, so `docker compose` pulls them with
> no login. (If you're publishing your own fork: after the first tagged
> release, set each package's visibility to **Public** once in its GitHub
> package settings.)

Put secrets in a `.env` next to the compose file (it stays out of git):

```bash
# Generate strong values:
#   openssl rand -hex 16   # passwords
#   openssl rand -hex 32   # secrets
MYSQL_ROOT_PASSWORD=...    # MySQL root
DB_PASSWORD=...            # MySQL app user
SESSION_SECRET=...         # signs session cookies + encrypts TOTP (≥16 chars)
REMOTE_SECRET=...          # Bearer secret clients send to pass-the-remote

# Host folders:
MUSIC_DIR=/path/to/music         # the mixer's local library (shared with pass-the-beat)
RECORDSTORE_DIR=/path/to/catalog # pass-the-remote's separate, served catalog
# REMOTE_PORT=3000               # host port pass-the-remote is exposed on
```

```yaml
# compose.yml
name: pass-the-aux

services:
  # Persistence for the mixer (STORAGE_DRIVER=mysql). Internal only —
  # the mixer reaches it as `mysql:3306` on the shared `pta` network.
  # (Mirrors docker-compose.mysql.yml; add a `ports:` mapping if you
  # want to reach the DB from the host.)
  mysql:
    image: mysql:8.4
    command: --innodb-buffer-pool-size=128M
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?set MYSQL_ROOT_PASSWORD in .env}
      MYSQL_DATABASE: ${DB_NAME:-passtheaux}
      MYSQL_USER: ${DB_USER:-passtheaux}
      MYSQL_PASSWORD: ${DB_PASSWORD:?set DB_PASSWORD in .env}
    volumes:
      - ./data/mysql:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "127.0.0.1", "-uroot", "-p${MYSQL_ROOT_PASSWORD}"]
      interval: 5s
      timeout: 5s
      retries: 20
    restart: unless-stopped
    networks: [pta]

  # The mixer.
  pass-the-aux:
    image: ghcr.io/marijnvandevoorde/pass-the-aux:latest
    ports:
      - "${PASS_THE_AUX_PORT:-5174}:5174"
    environment:
      - HOST=0.0.0.0
      - PORT=5174
      - MUSIC_DIR=/app/music
      - STORAGE_DRIVER=mysql
      - DB_HOST=mysql
      - DB_PORT=3306
      - DB_NAME=${DB_NAME:-passtheaux}
      - DB_USER=${DB_USER:-passtheaux}
      - DB_PASSWORD=${DB_PASSWORD:?set DB_PASSWORD in .env}
      - SESSION_SECRET=${SESSION_SECRET:?set SESSION_SECRET in .env}
      # First boot only: open registration to create your account, then
      # set REGISTRATION_OPEN=off in .env and re-run `up -d`.
      - REGISTRATION_OPEN=${REGISTRATION_OPEN:-on}
      # Use the neural sidecar for beat-grids.
      - BEAT_ANALYZER=pass-the-beat
      - PASS_THE_BEAT_URL=http://pass-the-beat:8000
    volumes:
      - ${MUSIC_DIR:-./music}:/app/music
      - ./data/pass-the-aux:/data
    depends_on:
      mysql:
        condition: service_healthy
      pass-the-beat:
        condition: service_started
    restart: unless-stopped
    networks: [pta]

  # Neural beat-tracking sidecar — internal only, reached as
  # http://pass-the-beat:8000 on the `pta` network.
  pass-the-beat:
    image: ghcr.io/marijnvandevoorde/pass-the-beat:latest
    environment:
      - BEATTHIS_CHECKPOINT=final0
      - BEATTHIS_DEVICE=cpu
    volumes:
      - ${MUSIC_DIR:-./music}:/music:ro
    healthcheck:
      test: ["CMD", "python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/healthz', timeout=3).status == 200 else 1)"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s
    restart: unless-stopped
    networks: [pta]

  # Self-hosted record store — EXPOSED on the host so other devices (a
  # phone on the LAN, a friend's mixer over the internet) can reach it.
  # Every request is gated by `Authorization: Bearer ${REMOTE_SECRET}`.
  pass-the-remote:
    image: ghcr.io/marijnvandevoorde/pass-the-remote:latest
    ports:
      - "${REMOTE_PORT:-3000}:3000"
    environment:
      - HOST=0.0.0.0
      - PORT=3000
      - MUSIC_DIR=/music
      - DB_PATH=/data/library.db
      - REMOTE_SECRET=${REMOTE_SECRET:?set REMOTE_SECRET in .env}
      - SCAN_INTERVAL_S=${SCAN_INTERVAL_S:-300}
    volumes:
      - ${RECORDSTORE_DIR:-./recordstore}:/music:ro
      - ./data/pass-the-remote:/data
    restart: unless-stopped
    networks: [pta]

networks:
  pta:
    name: pta
    driver: bridge
```

Bring it up:

```bash
docker compose up -d
#   pass-the-aux    → http://localhost:5174        (open it, create your account)
#   pass-the-remote → http://<this-host>:3000      (reachable from anywhere; Bearer-gated)
#   pass-the-beat   → internal sidecar (no host port)
#   mysql           → internal (no host port)
```

Then wire the record store into the mixer under **Settings → Remote
record stores**:

- **kind** `pta`
- **URL** `http://pass-the-remote:3000` (the mixer reaches it by name on
  the `pta` network; use `http://<host-ip>:${REMOTE_PORT}` from other devices)
- **secret** your `REMOTE_SECRET`

Once your account exists, set `REGISTRATION_OPEN=off` in `.env` and
`docker compose up -d` again to close public sign-ups.

## Configuration

All config comes from the environment (see `.env.example`; copy to
`.env`, which is gitignored — put any future secrets there, never in
source).

| Var                       | Default                | Purpose                                                                       |
| ------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `HOST`                    | `0.0.0.0`              | `127.0.0.1` = this machine only                                               |
| `PORT`                    | `5174`                 | listen port                                                                   |
| `MUSIC_DIR`               | `./music`              | library root                                                                  |
| `BODY_LIMIT_BYTES`        | `1000000`              | max request body                                                              |
| `STORAGE_DRIVER`          | `sqlite`               | `sqlite` (default, zero-dep via `node:sqlite`) or `mysql`                     |
| `SQLITE_PATH`             | `<MUSIC_DIR>/.pass-the-aux.sqlite` | SQLite database file (only when `STORAGE_DRIVER=sqlite`).         |
| `SESSION_SECRET`          | _(none)_               | HMAC key for session cookies + TOTP encryption (≥16 chars).                   |
| `BEAT_ANALYZER`           | `local`                | `local` = built-in BPM; `pass-the-beat` = the pass-the-beat sidecar.          |
| `PASS_THE_BEAT_URL`       | `http://pass-the-beat:8000`| Base URL of the pass-the-beat sidecar (only used when `BEAT_ANALYZER=pass-the-beat`). |

Remote record stores are configured per-user in **Settings → Remote
record stores** — there is no env-driven seed.

## Development

```bash
npm run typecheck   # tsc, no emit (server, tests)
npm run build       # compile src/web -> public/js
npm test            # node:test suite (domain, application, infra, e2e)
npm run dev         # rebuild on web changes + restart server on src changes
```

## How to use

1. Click **Start Pass the Aux** (browsers require a gesture before audio).
2. Load tracks with **→ A / → B**, or **+ Queue** them and toggle
   **AUTOMIX**; **Analyze missing BPM** pre-computes the library.
3. **PLAY/CUE** to control decks, **SYNC** to beat-match, the
   **crossfader** to blend, **Fade to next** for a manual automix cut.
4. Add a remote record store in ⚙ Settings to unlock the **extended
   search** overlay — search across Jamendo, your home NAS, or a friend's
   Pass the Aux server.

## Limitations

- Tempo change is vinyl-style (pitch moves with speed) — no independent
  time-stretching.
- BPM detection is tuned for music with a clear beat; rubato/beatless
  material may not resolve.
- Codec support depends on the browser's `decodeAudioData`.
- The browser layer can't be unit-tested headlessly (Web Audio); the
  server is covered by the `node:test` suite.
