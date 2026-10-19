# Beat-sync research — external services vs. local DSP

**Question:** Are there AI tools / online services that would meaningfully
improve beat-sync ("kick on kick") quality, BPM, key, or mood analysis
compared to our in-house DSP pipeline? Should we offload analysis to an
external service?

**Date:** 2026-05-21

## Verdict

**External APIs won't fix this. The problem is local detection *recall* —
fix the local model.**

Our beat grid is already sub-frame accurate (~1–2 ms) *when it fires*.
The weakness is recall: quiet intros, ballads, and sparse drum patterns
often produce no grid at all. No public metadata API solves that — most
don't even return the thing phase alignment needs (a per-beat grid).

## 1. What commercial APIs actually return

| Service | Time-stamped beat grid? | Reality |
|---|---|---|
| **Spotify Audio Analysis** | Yes (bars/beats/segments) — but | **Deprecated 2024-11-27** for new apps. Not an option. |
| **Spotify Audio Features** | No — scalars only | Also deprecated for new apps. |
| **Cyanite.ai** | No | BPM/key/mood/genre scalars + similarity (AI tagging). |
| **Music.ai (Moises)** | **Partial yes** — "beat map" workflow emits per-beat + downbeat positions | The one real exception. SaaS, async job pipeline, paid, uploads your audio. |
| **Musixmatch** | No | Lyrics/sync, not rhythm analysis. |
| **AcousticBrainz** | No — and **dead** (stopped collecting 2022). Don't build on it. |
| **Tunebat / GetSongBPM / Songbpm / Songdata.io / Musicstax** | No | Single global BPM + key + energy scalars. Catalog lookups. |
| **AIMI / Sonoteller.ai** | No | Mood/genre/theme tagging. |
| **Essentia / Essentia.js** | **Yes — but a library, not an API.** Self-hosted (see §4). |

## 2. The key technical distinction

A **global BPM scalar is useless for kick-on-kick alignment.** Phase
alignment needs **per-beat timestamps + downbeat positions accurate to
<~20 ms.** Essentially every public *catalog* API (Tunebat, GetSongBPM,
Cyanite, Songdata, Musicstax) returns only scalars. The only services that
ever returned a real grid were Spotify (now deprecated) and Music.ai's
beat-map workflow. Switching to a metadata API would give us a *worse*
BPM number than our own DSP already computes, and **no grid at all.**

## 3. Latency / offline reality

A network round-trip per track is **not viable** as the primary path.
Music.ai is an async upload-and-poll pipeline — seconds to tens of
seconds, and you must upload the audio file. "Fade to next" needs the
grid *before* the transition fires. Analysis must be **local and cached**
regardless (we already cache). An external API could only ever be a
background pre-warm step — and it still wouldn't beat local quality.

## 4. The actual upgrade path: self-host a modern beat tracker

This is where the real win is. A modern learned beat tracker meaningfully
beats a hand-rolled Ellis DP tracker **specifically on our weak spot**:
recall on quiet intros, ballads, and sparse percussion. Ellis DP relies
on a clean onset envelope and starves exactly where we described. Learned
models infer beat phase from harmony/melody, not just onsets.

- **beat-this** (CPJKU, ISMIR 2024) — current SOTA F-measure, joint
  beats + downbeats, no DBN needed, ~78 MB model, runs on CPU.
  **Best target.**
- **All-In-One** (mir-aidj) — beats + downbeats + structural segmentation
  (intro/verse/chorus). Bonus: segment labels would improve transition
  *point* selection, not just phase.
- **madmom** — solid, mature, but older RNN+DBN; beat-this supersedes it.
- **BeatNet** — only relevant for real-time *online* tracking; we do
  offline file analysis, so not needed.
- **Essentia TempoCNN** — good BPM, weaker as a full-grid solution.

**Architecture fit:** these are PyTorch/Python — friction against our
near-zero-dependency, type-stripped TS codebase. But `CLAUDE.md` already
sanctions `ffmpeg` as a *system tool* for `ffmpeg-audio-analyzer.ts`. The
clean fit is the same: add self-hosted **beat-this** as a spawned analysis
sidecar behind the existing analyzer port. Python stays a system/analysis
tool, never an npm runtime dep. Runs offline, on-device,
privacy-preserving.

## 5. Ranking

1. **Self-host beat-this** as a spawned analyzer — directly fixes recall,
   keeps everything local/private. *Do this.*
2. **All-In-One** if we also want structural, segment-aware transition
   points.
3. **Keep the Ellis DP tracker** as the zero-dependency fallback when the
   sidecar is absent (mirror the graceful-skip ffmpeg pattern).
4. **Music.ai** — only if we refuse to ship Python; SaaS, paid, uploads
   audio, async. Last resort.
5. **Catalog metadata APIs** (Tunebat / Cyanite / Spotify / etc.) —
   **don't.** Scalars, no grid, deprecated, or all three.

## Interim local fix (no new model)

While deciding on a sidecar, recall can be improved in
`src/web/beat-grid.ts` directly:

- Lower the "solid beat" energy threshold (`0.35` → `~0.25`).
- Make that threshold rolling-local (e.g. a 16-beat window) instead of
  anchored on the loudest section of the track.
- Raise the DP variance gate (`1e-6` → `~1e-5`) to admit tracks with a
  consistent low-level pulse.

## Sources

- Spotify — Introducing changes to the Web API:
  <https://developer.spotify.com/blog/2024-11-27-changes-to-the-web-api>
- TechCrunch — Spotify cuts developer access to recommendation features:
  <https://techcrunch.com/2024/11/27/spotify-cuts-developer-access-to-several-of-its-recommendation-features/>
- Cyanite.ai API docs: <https://api-docs.cyanite.ai/>
- Music AI — Extract beat map and BPM workflow:
  <https://music.ai/workflows/transcription-and-alignment/extract-beat-map-and-bpm/>
- AcousticBrainz — ending the project:
  <https://community.metabrainz.org/t/acousticbrainz-making-a-hard-decision-to-end-the-project/572828>
- beat-this (CPJKU): <https://github.com/CPJKU/beat_this>
- "Beat this!" paper (ISMIR 2024): <https://arxiv.org/pdf/2407.21658>
- All-In-One Music Structure Analyzer: <https://github.com/mir-aidj/all-in-one>
- BeatNet: <https://github.com/mjhydri/BeatNet>
