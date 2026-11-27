# Next steps

Open work for Pass the Aux, one line each. Delete a line when it's done.
Sprint detail lives on the Notion scrum board (see CLAUDE.md).

Prod runs `:6f5bc4f` since 2026-11-25 (rollback `:64fa8a0`).

- Play a real set on prod: automix through 3+ transitions in a background tab (starts at the orange mix-out marker, tempo glides back after each), Fade to next on gridded tracks, mix-in cue on the lined-up track.
- Soundboard: listen on prod to the CC0 airhorn, siren and Inception pads and the Siren FX (wired in #65; levels were matched by measurement only).
- Party sessions (#60): on the next deploy, vote as a guest first, then check the DJ still sees `▲ n` and the guest VOTED after the restart.
- DB-outage fix (#73, live since 2026-11-12): no HeatWave maintenance since (the last, 2026-11-03, caused the crash). The next is Tue 2026-12-08 from 04:29 Brussels (MySQL down about 04:45 to 05:00). After it, check the pod has 0 restarts and its logs show `library sweep: could not list users` and then carry on. Check before the next deploy: `kubectl logs` keeps only the current container.
- Desktop crowd sync (#80, live since 2026-11-20): share a party on prod with automix off, play by hand and request a track from the crowd page with a name (lands in the queue with the name, crowd shows Now Playing).
