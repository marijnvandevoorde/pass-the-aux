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
