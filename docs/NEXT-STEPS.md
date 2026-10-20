# Next steps

Open work for Pass the Aux, one line each. Delete a line when it's done.
Sprint detail lives on the Notion scrum board (see CLAUDE.md).

## Merge and deploy (2026-10-20 review round)

- Deploy order for the mix-out / bars / tempo PR: merge and deploy pass-the-beat#35 (analyzer v3) first, then merge this repo's PR (bumps `BEATTHIS_ANALYZER_VERSION` to 5, re-grids every track) and `npm run deploy`.
- After deploy, check a real set on prod: automix through 3+ transitions in a background tab (starts at the orange mix-out marker, tempo glides back after each), Fade to next on gridded tracks, mix-in cue on the lined-up track.

## Open

- Mobile DJ: queue and now-playing aren't persisted, a refresh loses them.
- Mobile + crowd: the waveforms are decorative (generated from the track name), not the audio.
- Desktop: the crossfader position isn't restored after a refresh (centre).
- test/visual (mobile.mjs) is stale: it waits for a `#start-btn` overlay the mobile UI no longer shows.
