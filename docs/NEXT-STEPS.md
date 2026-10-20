# Next steps

Open work for Pass the Aux, one line each. Delete a line when it's done.
Sprint detail lives on the Notion scrum board (see CLAUDE.md).

## Merge and deploy (2026-10-20 review round)

- Merge in order: #47 (automix queue + beat-aligned transitions + mix-in cue), then retarget and merge #48 (UX polish) and #51 (mobile auto-crossfade); #49 (sidecar bar phase, retries) and #50 (remote store errors) are independent. Then `npm run deploy`.
- After pass-the-beat#34 is deployed: bump `BEATTHIS_ANALYZER_VERSION` to 5 (`src/domain/beat-grid.ts`) in its own PR, so every track is re-gridded with the cleaned grid, bar phase and kick-based mix-in point.
- After deploy, check a real set on prod: automix through 3+ transitions in a background tab, Fade to next on gridded tracks, mix-in cue on the lined-up track.

## Open

- Bars: the browser models bars as `i % 4` over the whole grid; one extra/missing beat shifts every later bar (snap-to-bar lands on beat 2–4). pass-the-beat#34 cleans the grid; the real fix is storing per-beat downbeats (schema change).
- Grids are only fetched for loaded decks; a track queued before the background sweep reaches it waits (re-fetched every 20 s). Put queued / set tracks first in `BuildBeatGrids`, or build on demand.
- Remote record stores: "test connection" when saving a store (needs pass-the-remote's `GET /api/status`).
- Mix-out point: automix fades a fixed time before the end of the track, often into a long outro; use an outro/last-solid-bar point from pass-the-beat.
- Long-run tempo: each track is matched to the previous one's tempo and keeps it, so a night can drift ±8 % from the original tempos; glide back to 0 % after a fade.
- Mobile DJ: queue and now-playing aren't persisted, a refresh loses them.
- Mobile + crowd: the waveforms are decorative (generated from the track name), not the audio.
- Desktop: the crossfader position isn't restored after a refresh (centre).
- test/visual (mobile.mjs) is stale: it waits for a `#start-btn` overlay the mobile UI no longer shows.
