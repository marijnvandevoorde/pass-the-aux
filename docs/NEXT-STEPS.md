# Next steps

Open work for Pass the Aux, one line each. Delete a line when it's done.
Sprint detail lives on the Notion scrum board (see CLAUDE.md).

## After the 2026-10-20 deploy

- Check a real set on prod: automix through 3+ transitions in a background tab (starts at the orange mix-out marker, tempo glides back after each), Fade to next on gridded tracks, mix-in cue on the lined-up track.

## Open

- Party sessions stored (#60, live as `:6c0070b` since 2026-10-20; votes are stored and served on prod): on the next deploy, vote as a guest first, then check the DJ still sees `▲ n` and the guest VOTED.
- Visual test: `npm run visual-test` (mobile, crowd, party screen, desktop queue) before and after UI work; local only, the baselines are made on macOS.
- Soundboard: after the next deploy, listen to the CC0 airhorn, siren and Inception pads (levels were matched to the old files by measurement only).
- Siren FX and XY `alarm` are silent: `app.ts` asks for the pad "Air-Raid Siren", which doesn't exist, so `emergency-siren.mp3` is never loaded. Wire it as the alarm bed or delete the file.
