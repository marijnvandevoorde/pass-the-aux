import fs from "node:fs";
import type { Server } from "node:http";
import { loadConfig, loadEnv, type Config } from "./infrastructure/config.ts";
import { FsTrackRepository } from "./infrastructure/fs-track-repository.ts";
import { FsAudioSource } from "./infrastructure/fs-audio-source.ts";
import { createDbPool } from "./infrastructure/mysql-pool.ts";
import { MysqlAnalysisRepository } from "./infrastructure/mysql-analysis-repository.ts";
import { MysqlCrateRepository } from "./infrastructure/mysql-crate-repository.ts";
import { MysqlUserRepository } from "./infrastructure/mysql-user-repository.ts";
import { openDb as openSqliteDb } from "./infrastructure/sqlite-pool.ts";
import { SqliteAnalysisRepository } from "./infrastructure/sqlite-analysis-repository.ts";
import { SqliteCrateRepository } from "./infrastructure/sqlite-crate-repository.ts";
import { SqliteUserRepository } from "./infrastructure/sqlite-user-repository.ts";
import { SqliteBeatGridRepository } from "./infrastructure/sqlite-beat-grid-repository.ts";
import { SqliteRemoteLibrariesRepository } from "./infrastructure/sqlite-remote-libraries-repository.ts";
import { AuthService } from "./application/auth-service.ts";
import type { AnalysisRepository } from "./domain/ports/analysis-repository.ts";
import type { CrateRepository } from "./domain/ports/crate-repository.ts";
import type { UserRepository } from "./domain/ports/user-repository.ts";
import { FsLibraryWatcher } from "./infrastructure/fs-library-watcher.ts";
import { SessionStore } from "./infrastructure/session-store.ts";
import { Id3TagReader } from "./infrastructure/id3-tag-reader.ts";
import { buildRemoteSource } from "./infrastructure/remote-source-factory.ts";
import { MysqlRemoteLibrariesRepository } from "./infrastructure/mysql-remote-libraries-repository.ts";
import type { RemoteLibrariesRepository } from "./domain/ports/remote-libraries-repository.ts";
import { ManageRemoteLibraries } from "./application/manage-remote-libraries.ts";
import { FsLibraryWriter } from "./infrastructure/fs-library-writer.ts";
import { ListLibrary } from "./application/list-library.ts";
import { SaveAnalysis } from "./application/save-analysis.ts";
import { StreamAudio } from "./application/stream-audio.ts";
import { ManageCrates } from "./application/manage-crates.ts";
import { GetCover } from "./application/get-cover.ts";
import { SearchRemote } from "./application/search-remote.ts";
import { ImportRemoteTrack } from "./application/import-remote-track.ts";
import { EnrichLibrary } from "./application/enrich-library.ts";
import { AnalyzeLibrary } from "./application/analyze-library.ts";
import { BuildBeatGrids } from "./application/build-beat-grids.ts";
import { GetBeatGrid } from "./application/get-beat-grid.ts";
import { FfmpegAudioAnalyzer } from "./infrastructure/ffmpeg-audio-analyzer.ts";
import { BeatThisAnalyzer } from "./infrastructure/beat-this-analyzer.ts";
import type { AudioAnalyzer } from "./domain/ports/audio-analyzer.ts";
import { MysqlBeatGridRepository } from "./infrastructure/mysql-beat-grid-repository.ts";
import type { BeatGridRepository } from "./domain/ports/beat-grid-repository.ts";
import { RemoteCoverArtSource } from "./infrastructure/remote-cover-art-source.ts";
import { FsCoverStore } from "./infrastructure/fs-cover-store.ts";
import { AcousticBrainzSource } from "./infrastructure/acousticbrainz-source.ts";
import { buildServer, type UseCases } from "./interface/http/build-server.ts";
import { lanAddresses } from "./interface/http/lan.ts";
import path from "node:path";

/** Composition root: wires concrete infrastructure into the use cases.
 *  `backgroundWatch` starts the folder-watch enrichment loop — only
 *  the real server (start()) enables it; tests build the app without
 *  background timers so they stay deterministic. */
export function createApp(
  config: Config,
  opts: { backgroundWatch?: boolean } = {},
): Server {
  // Exactly one storage backend, picked by STORAGE_DRIVER. No
  // fallback — if mysql is selected the DB must be reachable.
  let analyses: AnalysisRepository;
  let crates: CrateRepository;
  let users: UserRepository;
  let beatGrids: BeatGridRepository;
  let remoteLibs: RemoteLibrariesRepository;
  if (config.storageDriver === "mysql") {
    const pool = createDbPool(config.db);
    analyses = new MysqlAnalysisRepository(pool);
    crates = new MysqlCrateRepository(pool);
    users = new MysqlUserRepository(pool);
    beatGrids = new MysqlBeatGridRepository(pool);
    remoteLibs = new MysqlRemoteLibrariesRepository(pool);
  } else {
    // sqlite (default) — single node:sqlite file, zero runtime deps.
    const db = openSqliteDb(config.sqlitePath);
    analyses = new SqliteAnalysisRepository(db);
    crates = new SqliteCrateRepository(db);
    users = new SqliteUserRepository(db);
    beatGrids = new SqliteBeatGridRepository(db);
    remoteLibs = new SqliteRemoteLibrariesRepository(db);
  }
  const auth = new AuthService(users, config.sessionSecret);
  const watcher = new FsLibraryWatcher(config.musicDir);
  const manageRemoteLibraries = new ManageRemoteLibraries(remoteLibs, users);

  /** Per-user resolver: looks up the active remote-library row and
   *  turns it into a runtime RemoteSource. Remotes are managed entirely
   *  through Settings → Remote record stores. */
  const resolveActiveRemote = async (uid: string) => {
    const row = await remoteLibs.getActive(uid);
    return row === null ? null : buildRemoteSource(row);
  };

  const coverSource = new RemoteCoverArtSource(config.coverLookup);
  const bpmSource = new AcousticBrainzSource(config.coverLookup);
  const sessions = new SessionStore();

  // Each account works inside music/<uid>/. The fs adapters
  // are rebound per uid; the storage repos take the uid (real user_id
  // column / nested JSON). uid "" → music/ (auth disabled → legacy
  // flat layout, no regression). Memoised per uid.
  const cache = new Map<string, UseCases>();
  const useCasesFor = (uid: string): UseCases => {
    const hit = cache.get(uid);
    if (hit) return hit;
    const dir = uid ? path.join(config.musicDir, uid) : config.musicDir;
    const fsTracks = new FsTrackRepository(dir);
    const fsTags = new Id3TagReader(dir);
    const coverStore = new FsCoverStore(dir);
    // The analysis engine that enriches `analysis` + builds
    // beat grids. `local` is the in-house ffmpeg + Ellis-DP DSP;
    // `pass-the-beat` routes through the sidecar (and wraps the local
    // one for key/energy + the unreachable fallback). Shared by
    // AnalyzeLibrary and BuildBeatGrids so both run on the same engine.
    const analyzer: AudioAnalyzer =
      config.beatAnalyzer === "pass-the-beat"
        ? new BeatThisAnalyzer({
            baseUrl: config.passTheBeatUrl,
            musicSubdir: uid,
            fallback: new FfmpegAudioAnalyzer(dir),
          })
        : new FfmpegAudioAnalyzer(dir);
    const resolveSource = () => resolveActiveRemote(uid);
    const uc: UseCases = {
      listLibrary: new ListLibrary(analyses, uid),
      saveAnalysis: new SaveAnalysis(
        fsTracks,
        analyses,
        uid,
        fsTags,
        coverSource,
        coverStore,
      ),
      streamAudio: new StreamAudio(new FsAudioSource(dir)),
      manageCrates: new ManageCrates(crates, uid),
      getCover: new GetCover(fsTags, coverStore),
      searchRemote: new SearchRemote(resolveSource),
      importRemoteTrack: new ImportRemoteTrack(
        resolveSource,
        new FsLibraryWriter(dir),
      ),
      manageRemoteLibraries,
      enrichLibrary: new EnrichLibrary(
        fsTracks,
        analyses,
        uid,
        fsTags,
        coverSource,
        coverStore,
        bpmSource,
      ),
      analyzeLibrary: new AnalyzeLibrary(analyses, analyzer, uid),
      buildBeatGrids: new BuildBeatGrids(analyses, beatGrids, analyzer, uid),
      getBeatGrid: new GetBeatGrid(beatGrids, uid),
    };
    cache.set(uid, uc);
    return uc;
  };

  // Background library watch (server only): on boot + on debounced
  // fs changes, run EnrichLibrary per ACCOUNT — a new song is
  // analysed (tags/key + AcousticBrainz BPM) and its cover fetched
  // right away. CRITICAL: sweep ONLY real user ids. uid "" would
  // bind FsTrackRepository to the music ROOT, which recursively
  // contains every user's music/<uid>/ subtree → it would write
  // junk rows (user_id="", track_id="<uid>/file"). Only when there
  // are no accounts at all (legacy flat, no per-user subdirs) do we
  // sweep the root as "".
  if (opts.backgroundWatch) {
    let sweeping = false;
    let pending = false;
    const sweepAll = async (): Promise<void> => {
      // Coalesce instead of drop: a change arriving mid-sweep must not
      // be lost. Sweeps are long now (enrich + ffmpeg per user), so a
      // plain `if (sweeping) return` silently discarded files dropped
      // in while a pass was running — the "not triggering often" bug.
      if (sweeping) {
        pending = true;
        return;
      }
      sweeping = true;
      try {
        do {
          pending = false;
          const real = await users.allIds();
          const ids = real.length > 0 ? real : [""];
          for (const uid of ids) {
            try {
              const uc = useCasesFor(uid);
              await uc.enrichLibrary.execute(); // tags/cover/AcousticBrainz
              await uc.analyzeLibrary.execute(); // ffmpeg+DSP bpm/key/energy
              await uc.buildBeatGrids.execute(); // phase grid
            } catch {
              /* per-user best-effort — next sweep retries */
            }
          }
        } while (pending); // a change landed during the pass — re-run
      } finally {
        sweeping = false;
      }
    };
    let sweepTimer: ReturnType<typeof setTimeout> | undefined;
    watcher.subscribe(() => {
      clearTimeout(sweepTimer);
      sweepTimer = setTimeout(() => void sweepAll(), 2000);
      sweepTimer.unref?.();
    });
    setTimeout(() => void sweepAll(), 1500).unref?.();
    // Safety net: fs.watch can miss events entirely (network mounts,
    // some copy tools, OS-coalesced events). A slow periodic backstop
    // guarantees a dropped-in file is eventually analysed even when no
    // fs event ever fires for it.
    setInterval(() => void sweepAll(), 5 * 60_000).unref?.();
  }

  return buildServer(useCasesFor, config, watcher, sessions, auth);
}

export function start(): void {
  loadEnv();
  const config = loadConfig();
  const server = createApp(config, { backgroundWatch: true });

  server.listen(config.port, config.host, () => {
    console.log(`Pass the Aux listening on ${config.host}:${config.port}`);
    console.log(`  local:   http://localhost:${config.port}`);
    if (config.host !== "127.0.0.1") {
      for (const ip of lanAddresses()) {
        console.log(
          `  network: http://${ip}:${config.port}   (share this on the VLAN)`,
        );
      }
      console.log(
        "  note: anyone on this network can reach it (it streams files from",
      );
      console.log(
        "        the music folder). Use a trusted LAN, or set HOST=127.0.0.1.",
      );
    }
    console.log(`Music folder: ${config.musicDir}`);
    console.log(`Storage: ${config.storageDriver}`);
    console.log(
      config.sessionSecret.length >= 16
        ? "Auth: enabled (login + 2FA required)"
        : "Auth: DISABLED — set SESSION_SECRET (>=16 chars) to enable",
    );
    console.log(
      "Remote library: add one in Settings → Remote record stores",
    );
    if (!fs.existsSync(config.musicDir)) {
      console.log("(folder does not exist yet — create it or set MUSIC_DIR)");
    }
  });
}
