// Small DOM/string helpers shared by the mobile DJ and crowd entry
// points (they compile independently, so the shared code must be a real
// importable module).

/** Lookup an element by id; throws if missing (fail-fast on a bad selector). */
export function byId<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as unknown as T;
}

/** HTML-escape a string for safe interpolation into innerHTML. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Seconds → `m:ss`. */
export function fmtTime(sec: number): string {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

/** Bottom-center toast that auto-dismisses. `msg` may contain markup. */
export function toast(container: HTMLElement, msg: string): void {
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<span class="t-dot"></span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

/**
 * Fade the track's `/api/cover` art into the chip disc and the fullscreen
 * disc together. No-ops (and clears) when `path` is null. Skips reloading
 * when the path is unchanged so periodic re-renders don't re-flash the art.
 */
export function makeCoverLoader(
  discEl: HTMLImageElement,
  npEl: HTMLImageElement,
): (path: string | null) => void {
  let loaded: string | null = null;
  return (path) => {
    if (path === loaded) return;
    loaded = path;
    for (const img of [discEl, npEl]) {
      img.classList.remove("loaded");
      img.src = "";
      if (!path) continue;
      img.onload = () => img.classList.add("loaded");
      img.onerror = () => { img.src = ""; };
      img.src = "/api/cover?path=" + encodeURIComponent(path);
    }
  };
}

/** Key·BPM meta fragment (`11B · 128 BPM`) shared by queue/library/crate rows. */
export function keyBpmMeta(camelot: string | null, bpm: number | null): string {
  const key = camelot ? `<span class="q-key">${esc(camelot)}</span>` : "";
  const dot = camelot && bpm ? `<span class="q-dot">·</span>` : "";
  const tempo = bpm ? `<span class="q-bpm">${Math.round(bpm)} BPM</span>` : "";
  return key + dot + tempo;
}

// ── Requester avatars/pills (who suggested a track) ──
const AVATAR_PALETTE = ["#3f72b0", "#8466b0", "#e8862e", "#43c9bd", "#d8567f", "#5aa469", "#c9913a"];

/** Stable color for a name (so the same guest always gets the same hue). */
export function avatarColor(name: string): string {
  let h = 0;
  for (const c of name) h = ((h * 31 + c.charCodeAt(0)) >>> 0);
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]!;
}

/** 1–2 uppercase initials for an avatar. */
export function avatarInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0] ?? "";
  if (parts.length === 1) return first.slice(0, 2).toUpperCase();
  const last = parts[parts.length - 1] ?? "";
  return ((first[0] ?? "") + (last[0] ?? "")).toUpperCase();
}

/**
 * A "requested by" chip: colored initials avatar + the name (CSS-truncated).
 * Returns "" when there's no requester to credit (empty, or the DJ's own
 * adds, which use the sentinel "you"). `prefix` e.g. "requested by".
 */
export function requesterChip(
  name: string | null | undefined,
  opts: { prefix?: string; showName?: boolean } = {},
): string {
  const n = (name ?? "").trim();
  if (!n || n.toLowerCase() === "you") return "";
  const { prefix, showName = true } = opts;
  const pre = prefix ? `<span class="req-pre">${esc(prefix)}</span>` : "";
  const av = `<span class="who" style="background:${avatarColor(n)}">${esc(avatarInitials(n))}</span>`;
  const label = showName ? `<span class="req-name">${esc(n)}</span>` : "";
  return `<span class="req-chip">${pre}${av}${label}</span>`;
}
