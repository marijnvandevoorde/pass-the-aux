// The party session the DJ runs and the crowd joins over a QR link:
// requests, Up Next, now playing and crowd votes. Plain data types; the
// live store is `SessionStore` (infrastructure/session-store.ts).

export interface NowPlaying {
  name: string;
  artist: string | null;
  bpm: number | null;
  path: string | null;
  /** the guest who requested this track, if any. */
  by: string | null;
  /** Playhead (s) when the DJ reported it, at `nowPlayingAt`. The crowd
   *  screen extrapolates from it while `playing`. Null from old clients. */
  positionSec?: number | null;
  durationSec?: number | null;
  playing?: boolean;
}

export interface SessionConfigDTO {
  automix: boolean;
  autoFill: boolean;
  beatSync: boolean;
  fadeSeconds: number;
  showUpNext: boolean;
}

export interface SessionQueueItem {
  name: string;
  path: string;
  bpm: number | null;
  /** the guest who requested this track, if any. */
  by: string | null;
}
