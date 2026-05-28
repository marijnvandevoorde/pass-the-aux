// Pure (DOM-free) "smart auto-fill" picker: given the
// currently playing track and the analysed library, choose a compatible
// next track — close tempo, harmonic key (Camelot wheel), similar energy
// — never one already played this session, lightly randomised so sets
// aren't identical every run. Unit-tested.

export interface FeatureTrack {
  id: string;
  bpm: number | null;
  camelot: string | null;
  energy: number | null;
}

function parseCamelot(c: string | null): { n: number; l: string } | null {
  if (!c) return null;
  const m = /^(\d{1,2})([AB])$/.exec(c.trim().toUpperCase());
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 12 ? { n, l: m[2]! } : null;
}

/** Camelot harmonic distance: 0 best … 1 worst. */
function keyScore(a: string | null, b: string | null): number {
  const x = parseCamelot(a);
  const y = parseCamelot(b);
  if (!x || !y) return 0.5; // unknown key → neutral
  if (x.n === y.n && x.l === y.l) return 1; // same key
  const dn = Math.min((x.n - y.n + 12) % 12, (y.n - x.n + 12) % 12);
  if (x.l === y.l && dn === 1) return 0.85; // adjacent, same mode
  if (x.n === y.n && x.l !== y.l) return 0.8; // relative major/minor
  if (dn === 0) return 0.6;
  return Math.max(0, 0.5 - dn * 0.08);
}

function tempoScore(a: number | null, b: number | null): number {
  if (!a || !b) return 0.5;
  // Consider half/double time too.
  const ratios = [b / a, b / (2 * a), (2 * b) / a];
  const best = Math.min(...ratios.map((r) => Math.abs(Math.log2(r))));
  // 0 semitone-ish distance → 1; ~6% (≈0.084 in log2) → ~0.
  return Math.max(0, 1 - best / 0.12);
}

function energyScore(a: number | null, b: number | null): number {
  if (a == null || b == null) return 0.5;
  const d = b - a;
  // Prefer similar; allow a gentle lift, punish big drops/jumps.
  return Math.max(0, 1 - Math.abs(d) * 1.5) + (d > 0 && d < 0.2 ? 0.05 : 0);
}

export function scoreCandidate(
  current: FeatureTrack,
  cand: FeatureTrack,
): number {
  return (
    0.45 * tempoScore(current.bpm, cand.bpm) +
    0.35 * keyScore(current.camelot, cand.camelot) +
    0.2 * energyScore(current.energy, cand.energy)
  );
}

/**
 * Pick the next track. Excludes `seen` ids and `current`. Picks among
 * the top few by score (randomised) so it isn't robotic. Falls back to
 * any unseen track so the set never dies, even with no analysis yet.
 */
export function pickNext(
  current: FeatureTrack | null,
  candidates: readonly FeatureTrack[],
  seen: (id: string) => boolean,
  rnd: () => number = Math.random,
): FeatureTrack | null {
  const pool = candidates.filter(
    (c) => !seen(c.id) && (!current || c.id !== current.id),
  );
  if (pool.length === 0) return null;
  if (!current) return pool[Math.floor(rnd() * pool.length)] ?? null;

  const ranked = pool
    .map((c) => ({ c, s: scoreCandidate(current, c) }))
    .sort((a, b) => b.s - a.s);
  const topN = Math.min(3, ranked.length);
  return ranked[Math.floor(rnd() * topN)]?.c ?? null;
}
