# Handoff: Pass the Aux — Mobile (DJ + Crowd)

## Overview
This package contains the **mobile** redesign for Pass the Aux: two phone-sized frontends that
sit alongside the existing desktop app.

1. **DJ view** (`Pass the Aux.html`) — the person running the music on their phone. Full control:
   play/pause, scrub, skip, clear queue, reset played history, and a harmonic **mix-flow** queue
   that shows how each track blends into the next (Camelot key relationship + BPM delta).
2. **Crowd view** (`Pass the Aux - Crowd.html`) — the `/crowd` guest page. Request-only. Guests
   enter a first name (stored locally), watch what's playing (tap → fullscreen), browse the crate,
   and request tracks. Optionally (a DJ session setting) they can see Up Next and **vote once per
   song**. No playback control.

> These are the **mobile** experiences only. They are new views — **the existing desktop app must
> continue to work exactly as it does today** (two decks, waveforms, crossfader, automix, the full
> DJ workstation). Nothing here replaces or modifies desktop behavior.

---

## ⚠️ Implementation decision left to the Principal Engineer

How the mobile views are wired into the app is **your call** — both approaches are valid:

- **Option A — separate mobile views:** a distinct mobile frontend with components shared between
  desktop and mobile where it makes sense, choosing which view to load based on **screen
  dimensions** (media query / `matchMedia`) or **user-agent**. The desktop "two-deck" app loads as-is
  on large screens.
- **Option B — fully responsive:** one app that reflows from the two-deck desktop layout down to
  these mobile layouts via breakpoints.

Either is fine. The hard requirement is only that **the desktop two-deck experience is preserved
unchanged**. These HTML files express the *intended mobile look & behavior* — implement them in our
stack (`src/web/`, vanilla TS compiled to `public/js`), not by shipping the HTML.

---

## About the Design Files
The files in this bundle are **design references created in HTML/CSS/vanilla-JS** — prototypes that
show the intended look and behavior. They are **not** production code to drop in. Recreate them in
our existing browser layer (`src/web/`, the real-time "Mixing" context) using our established
patterns. They were deliberately built dependency-light (no framework for the core; the optional
"Tweaks" panel is a throwaway dev tool, see below) to map cleanly onto our near-zero-dependency
codebase.

## Fidelity
**High-fidelity.** Final colors, typography, spacing, motion, and interactions. Recreate the UI
pixel-accurately, but swap our real data/state in place of the mock arrays.

---

## Views

### 1. DJ view — `Pass the Aux.html`
Phone frame, top-to-bottom:

- **Header** — logo tile (34×34, 9px radius), `PASS THE AUX` (JetBrains Mono, 13px, 700,
  letter-spacing 0.16em, uppercase), a live session line (pulsing mint dot + "N in the room"),
  and an **Invite** button (mint gradient pill) that opens a QR overlay to join the session.
- **Now Playing hero** — a card (`--surface`, 1px `--line`, 16px radius):
  - **Spinning vinyl disc** (78px) — CSS-generated grooves + mint label; spins only while playing
    (`.now-hero.playing .disc { animation-play-state: running }`).
  - Title (17px/700, marquee-scrolls if long), artist (13px `--dim`).
  - **Chips:** a Camelot **key chip** (color derived from the key — see Design Tokens) and a
    **BPM chip** (`133 BPM`, the number in mint).
  - **Waveform = scrubber.** 58 bars, generated deterministically from the track name. Played bars
    are mint; **tap or drag anywhere on it to seek** (there is no separate slider/scrollbar — this
    was an explicit requirement). Times on both ends (`0:00` / `-3:31`), mono, tabular-nums.
  - **Transport:** heart (love) button · large **PLAY/PAUSE** bar (shows `PLAYING`/`PAUSED`) ·
    **skip** button. Skip is a **single click** (not hold) that plays a ring-sweep + flash
    animation as confirmation *before* the track changes — because the real track change isn't
    instant, the animation reassures the DJ it registered. Icon is a flat skip-arrow (no label).
- **Tabs:** `Up Next` (with count badge) and `Library`.
- **Queue (Up Next) — the key idea: a readable MIX FLOW.**
  - Toolbar: `▸ MIXING INTO DECK` flag, a **reset** button (circular-arrow — clears played history
    so spent tracks can be requested again), and a **trash** button (clears the queue). Both go red
    on tap.
  - **On-deck card** — the first queued track, emphasized (mint-tinted card, mini orange disc). It
    carries the label **`ON DECK · CUED NEXT`**: this is the track *loaded on the deck, mixing in
    next, not yet playing*.
  - A **`QUEUE`** divider (+ count) separates the on-deck card from the rest.
  - **Mix-link connectors** sit *between* every pair of tracks (and between Now Playing → on-deck):
    a dashed vertical tie with a **transition badge** — `PERFECT / RELATIVE / SMOOTH / ENERGY /
    BOOST / CLASH` — colored smooth (mint) / energy (amber) / clash (red), plus the BPM delta
    (`▲ +4 BPM`, `= beat-matched`, half/double-time aware) and `11B→12B`.
  - **Queue rows:** key-colored left rail, name, key·BPM, a **who-added avatar** (initials on a
    color), a drag handle, and a remove (×) button. Removing animates out (slide + fade).
  - **FAB** "Add track" (bottom-right, mint) → jumps to Library.
- **Library** — sticky search ("Search the crate…"), rows with key-colored rail, name, key·BPM, and
  a `+ QUEUE` button that flips to `✓ ADDED`. (Note: there is intentionally **no** "compatibility vs.
  now-playing" tag here — compatibility is only meaningful track-to-track in the queue, which the
  mix-flow already shows.)
- **QR overlay** — blurred scrim + card with a (decorative) QR and `aux.party/fri-night`.
- **Toasts** — bottom-center, auto-dismiss ~2.7s.

### 2. Crowd view — `Pass the Aux - Crowd.html`
Same design system, request-only. Two steps:

- **Step 1 — Name gate** (`#nameGate`): full-screen welcome (logo, "You're on the aux", session
  line, a single **First name** input → **Join the room**). Stored in `localStorage` under
  `pta-guest-name`; returning guests skip straight in. The header chip (initials + name) reopens it
  to change the name. First name only — just enough for the DJ to see who's requesting.
- **Step 2 — The view:**
  - **Now Playing** — same hero, but **no transport controls**, and **tapping it opens a fullscreen
    moment** (`#npFull`): large spinning vinyl (232px), title, key/BPM chips, live waveform, and
    "requested by". The fullscreen background is tinted by the current track's Camelot key. Close via
    the grab-handle at top.
  - **Up Next (optional — DJ session setting):** read-only list with position number, key·BPM,
    who-requested avatar. When enabled, each row has a **vote pill** (▲ + count) — **one vote per
    song per guest**, persisted in `localStorage` (`pta-votes`); tap to vote (turns mint, +1, toast),
    tap again to remove. Votes are display-only and do **not** reorder the DJ's queue — curation
    stays with the DJ. Visibility is toggled via `window.setCrowdUpNext(bool)`; when off, the tab bar
    hides and only Now Playing + The Crate remain.
  - **Already played** — collapsible section at the bottom (read-only, dimmed).
  - **The Crate** — search + **REQUEST** button per track (flips to `SENT`, or `✓ QUEUED` if the DJ
    has queued it). Hint banner: "Send the DJ a request — they'll curate what makes the cut."

---

## Interactions & Behavior
- **Seek:** `pointerdown`/`pointermove` on the waveform maps clientX → ratio → `currentTime`. No
  scrollbar/slider.
- **Skip (DJ):** click → `doSkip()` animates the ring (`stroke-dashoffset` over ~480ms) + flash,
  then calls `advance()`. Re-entrancy guarded by a `skipping` flag.
- **Play clock:** a 500ms interval advances `currentTime`; at end-of-track it calls `advance()`
  (shifts the on-deck track into Now Playing and re-renders).
- **Queue remove:** adds `.removing` (slide+fade, 220ms) then splices and re-renders.
- **Voting (crowd):** `toggleVote(id)` mutates a `Set`, persists to `localStorage`, re-renders.
- **Name gate:** Enter or button submits; trims to 24 chars; persists; fades out (`.dismissed`).
- **Marquee / disc spin / live dot pulse / wave wobble:** all CSS, all gated on `.playing` where
  relevant.
- **Tabs & overlays:** plain class toggles (`.active`, `.open`).

## State Management
Mock state lives at the top of `pta.js` / `crowd.js` — **replace with our real domain data**:
- DJ: `nowPlaying`, `queue[]` (each `{id, name, artist, key, bpm, by}`), `isPlaying`, `currentTime`,
  `liked`, `LIBRARY[]`, `GUESTS{}`.
- Crowd: `nowPlaying` (+`by`), `upNext[]`, `PLAYED[]`, `CRATE[]`, `guest`, `requested:Set`,
  `myVotes:Set` (+ `BASE_VOTES` from the rest of the room), `isPlaying`, `currentTime`.
- Persistence used: `localStorage['pta-guest-name']`, `localStorage['pta-votes']`.
- Wire `key`/`bpm` from our analyzer output (`Track`/`Tempo`); `requested`/`votes` should POST to the
  request/vote endpoints; `window.setCrowdUpNext` maps to the per-session "show queue to crowd"
  setting chosen at automix-session creation.

> **Note on automix:** there is no live automix toggle in the toolbar by design — it's decided when
> the DJ creates the session. Same for "show Up Next to crowd."

---

## Design Tokens (from `pta.css :root`)
**Surfaces:** `--bg #07090e` · `--bg-elev #0b0e15` · `--surface #11141d` · `--surface-2 #181d29` ·
`--line #242b3b` · `--line-soft #1a2030`
**Text:** `--text #eef1f8` · `--dim #99a2b6` · `--faint #5c6378`
**Accent (mint, default):** `--accent #38e0c4` · `--accent-2 #2bd0d6` · `--accent-ink #04201b` ·
`--accent-glow rgba(56,224,196,0.35)`
**Harmonic semantics:** `--smooth #38e0c4` · `--energy #ffb24d` · `--clash #ff5d63`
**Brand (from logo, used for guest avatars):** blue `#3f72b0` · purple `#8466b0` · orange `#e8862e`
· teal `#43c9bd`
**Radius:** `--radius 16px` · `--radius-s 11px`
**Type:** UI = SF/system stack; **mono = JetBrains Mono** (Google Fonts) for all key/BPM/labels/times.
**Phone frame:** 390×844 (portrait). Landscape preview: 852×410 (cover stays a left-hand square,
everything else flows to its right).

### Camelot key → color (important, in both JS files as `keyVars()`)
A track's key drives its chip/rail color: `hue = ((num − 1) / 12) × 360`, then
`--k-fg hsl(hue 68% 64%)`, `--k-bg hsl(hue 50% 13%)`, `--k-bd hsl(hue 42% 30%)`.
Harmonic relation logic (`keyRelation`) and BPM-delta folding (`bpmDelta`) live in `pta.js`.

### Density / accent / cover variants
Driven by `:root[data-density]`, `:root[data-cover]`, and accent CSS vars. See the Tweaks note.

---

## The "Tweaks" panel — dev tool, **do not ship**
Both HTML files load an optional React/Babel **Tweaks** panel (`tweaks-panel.jsx` +
`tweaks-app.jsx` / `crowd-tweaks.jsx`) used during design to preview options (accent color,
vinyl-vs-gradient cover, list density, show-who, show-Up-Next). It's the **only** React in the
bundle and is **not** part of the deliverable — it just demonstrates the variants. The variant
hooks themselves are plain CSS (`data-*` attributes + CSS vars), so you can keep those without any
framework.

## Assets
- `passtheaux.png` — the app logo (vinyl + two hands joining an aux cable). Reuse the real asset
  from our repo. All other graphics (vinyl grooves, waveform, QR, icons) are CSS/inline-SVG —
  recreate as components.

## Files in this bundle
- `Pass the Aux.html` + `pta.css` + `pta.js` — **DJ view**
- `Pass the Aux - Crowd.html` + `crowd.css` + `crowd.js` — **Crowd view** (shares `pta.css`)
- `tweaks-panel.jsx`, `tweaks-app.jsx`, `crowd-tweaks.jsx` — dev-only Tweaks panel (do not ship)
- `passtheaux.png` — logo
