# Next steps

Open work for Pass the Aux, one line each. Delete a line when it's done.
Sprint detail lives on the Notion scrum board (see CLAUDE.md).

## Deploy (2026-10-20 review round)

- Everything is merged and pass-the-beat v3 is live. Deploy here with `npm run deploy` (rollback image `pass-the-aux:1e4f31e`); #53 bumped `BEATTHIS_ANALYZER_VERSION` to 5, so every track is re-gridded.
- After deploy, check a real set on prod: automix through 3+ transitions in a background tab (starts at the orange mix-out marker, tempo glides back after each), Fade to next on gridded tracks, mix-in cue on the lined-up track.

## Open

- Crowd votes live in the in-memory session like requests and Up Next: a server restart (deploy) clears them. Persist sessions if that matters at a party.
- Visual test: `npm run visual-test` (mobile, crowd, party screen, desktop queue) before and after UI work; local only, the baselines are made on macOS.
