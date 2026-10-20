/** Turn a failed `fetch` into something a DJ can act on. Node's undici
 *  throws a bare "fetch failed" and hides the reason in `cause`. */
const REASONS: Record<string, string> = {
  ECONNREFUSED: "connection refused — is the server running?",
  ENOTFOUND: "host not found — check the URL",
  EAI_AGAIN: "DNS lookup failed — try again",
  ETIMEDOUT: "timed out",
  UND_ERR_CONNECT_TIMEOUT: "timed out",
  UND_ERR_HEADERS_TIMEOUT: "timed out waiting for an answer",
  ECONNRESET: "connection dropped",
  EHOSTUNREACH: "host unreachable",
  CERT_HAS_EXPIRED: "its TLS certificate has expired",
  DEPTH_ZERO_SELF_SIGNED_CERT: "self-signed TLS certificate",
  SELF_SIGNED_CERT_IN_CHAIN: "self-signed TLS certificate",
  ERR_TLS_CERT_ALTNAME_INVALID: "TLS certificate doesn't match the host",
};

export function describeFetchError(e: unknown, url?: URL | string): string {
  const host = url ? safeHost(url) : null;
  const where = host ? `can't reach ${host}` : "request failed";
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 4; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && REASONS[code]) return `${where} (${REASONS[code]})`;
    cur = (cur as { cause?: unknown }).cause;
  }
  if (e instanceof Error && e.name === "AbortError") return `${where} (timed out)`;
  const m = e instanceof Error ? e.message : String(e);
  return `${where}: ${m}`;
}

function safeHost(url: URL | string): string | null {
  try {
    return new URL(String(url)).host;
  } catch {
    return null;
  }
}
