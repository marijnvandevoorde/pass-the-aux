// login / registration / 2FA-enrollment page. Zero-dep:
// reuses the in-house qr.ts encoder to draw the authenticator QR.
import { qrMatrix } from "./qr.js";
import { SESSION_KEY } from "./session.js";

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};

function show(panel: "login" | "register" | "enroll"): void {
  for (const p of ["login", "register", "enroll"] as const) {
    $(`#panel-${p}`).hidden = p !== panel;
  }
}

function msg(sel: string, text: string, kind: "err" | "ok" = "err"): void {
  const el = $<HTMLDivElement>(sel);
  el.textContent = text;
  el.className = `msg ${kind}`;
}

async function postJson(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "network error" } };
  }
}

/** Enter the mixer after a successful sign-in. Each login starts a
 *  fresh booth: drop the stored automix session (both decks, the
 *  queue, the played-track history, config + session id) so a previous
 *  DJ's state never leaks into the new one. */
function enterApp(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage disabled — non-fatal */
  }
  location.href = "/";
}

function drawQr(text: string): void {
  const canvas = $<HTMLCanvasElement>("#qr");
  const g = canvas.getContext("2d");
  if (!g) return;
  try {
    const m = qrMatrix(text);
    const n = m.length;
    const scale = Math.max(2, Math.floor(180 / n));
    canvas.width = n * scale;
    canvas.height = n * scale;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = "#000";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (m[r]![c]) g.fillRect(c * scale, r * scale, scale, scale);
      }
    }
    canvas.hidden = false;
  } catch {
    canvas.hidden = true; // URI too long for v1–4 — manual key still works
  }
}

// Carried from register → enroll so we don't re-ask the password.
let pending: { username: string; password: string } | null = null;

$("#to-register").addEventListener("click", () => show("register"));
$("#to-login").addEventListener("click", () => show("login"));

// Reveal the "create account" link only when the server reports
// self-service registration is open. Fail closed: the link stays
// hidden (its default) on any error or when registration is off.
void (async () => {
  try {
    const res = await fetch("/api/auth/status");
    if (!res.ok) return;
    const { registrationOpen } = (await res.json()) as {
      registrationOpen?: boolean;
    };
    if (registrationOpen === true) $("#register-switch").hidden = false;
  } catch {
    /* keep it hidden */
  }
})();

$<HTMLButtonElement>("#li-go").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#li-go");
  btn.disabled = true;
  const r = await postJson("/api/auth/login", {
    username: $<HTMLInputElement>("#li-user").value,
    password: $<HTMLInputElement>("#li-pass").value,
    code: $<HTMLInputElement>("#li-code").value,
  });
  btn.disabled = false;
  if (r.ok) {
    enterApp();
  } else {
    msg("#li-msg", String(r.data.error ?? "sign-in failed"));
  }
});

$<HTMLButtonElement>("#rg-go").addEventListener("click", async () => {
  const btn = $<HTMLButtonElement>("#rg-go");
  const username = $<HTMLInputElement>("#rg-user").value.trim();
  const password = $<HTMLInputElement>("#rg-pass").value;
  btn.disabled = true;
  const r = await postJson("/api/auth/register", { username, password });
  btn.disabled = false;
  if (!r.ok) {
    msg("#rg-msg", String(r.data.error ?? "registration failed"));
    return;
  }
  pending = { username, password };
  drawQr(String(r.data.otpauthUri ?? ""));
  $("#enroll-secret").textContent = String(r.data.secret ?? "");
  const codes = Array.isArray(r.data.recoveryCodes)
    ? (r.data.recoveryCodes as string[])
    : [];
  $("#enroll-codes").textContent = codes.join("  ");
  show("enroll");
});

$<HTMLButtonElement>("#en-go").addEventListener("click", async () => {
  if (!pending) {
    show("register");
    return;
  }
  const btn = $<HTMLButtonElement>("#en-go");
  btn.disabled = true;
  const r = await postJson("/api/auth/confirm", {
    username: pending.username,
    password: pending.password,
    code: $<HTMLInputElement>("#en-code").value,
  });
  btn.disabled = false;
  if (r.ok) {
    enterApp();
  } else {
    msg("#en-msg", String(r.data.error ?? "verification failed"));
  }
});
