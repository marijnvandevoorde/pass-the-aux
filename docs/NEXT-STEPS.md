# Next steps

Open work for Pass the Aux, one line each. Delete a line when it's done.
Sprint detail lives on the Notion scrum board (see CLAUDE.md).

## Merge and deploy (2026-10-20 review round)

- Deploy order for the mix-out / bars / tempo PR: merge and deploy pass-the-beat#35 (analyzer v3) first, then merge this repo's PR (bumps `BEATTHIS_ANALYZER_VERSION` to 5, re-grids every track) and `npm run deploy`.
- After deploy, check a real set on prod: automix through 3+ transitions in a background tab (starts at the orange mix-out marker, tempo glides back after each), Fade to next on gridded tracks, mix-in cue on the lined-up track.

## Open

- Desktop: the crossfader position isn't restored after a refresh (centre).
- Crowd votes stay on the guest's phone: the VOTE pill toggles but nothing reaches the DJ. Make votes real (count per track on the server, shown in the DJ's queue) or drop the pill.
- Waveforms (`/api/waveform`) are cached in server memory, so each restart recomputes them (one ffmpeg decode per track, plus a bucket download on prod). Store them next to the cover if that ever shows up in the load.
- Visual test: `npm run visual-test` (mobile, crowd, party screen, desktop queue) before and after UI work; local only, the baselines are made on macOS.
