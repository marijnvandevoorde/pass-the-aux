import { AwsClient } from "aws4fetch";
import { Readable } from "node:stream";

/** Connection settings for an S3-compatible bucket (AWS, OCI, MinIO…). */
export interface S3Settings {
  /** e.g. `https://<ns>.compat.objectstorage.<region>.oraclecloud.com` */
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** `true` → `<endpoint>/<bucket>/<key>`; `false` → `<bucket>.<host>/<key>`. */
  forcePathStyle: boolean;
}

export interface S3Object {
  key: string;
  size: number;
  /** Unix-epoch ms. */
  lastModified: number;
}

/** A non-2xx response the caller did not expect. */
export class S3Error extends Error {
  readonly status: number;
  constructor(op: string, key: string, status: number, detail = "") {
    super(`s3 ${op} ${key}: HTTP ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "S3Error";
    this.status = status;
  }
}

/** S3 keys may hold any character; RFC 3986-encode each path segment
 *  (encodeURIComponent leaves `!'()*` alone, SigV4 wants them encoded). */
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function xmlText(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m) => {
    const named = XML_ENTITIES[m.toLowerCase()];
    if (named) return named;
    const hex = m[2] === "x" || m[2] === "X";
    const n = parseInt(m.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? xmlText(m[1]!) : null;
}

/** Parses one ListObjectsV2 page. Exported for unit tests. */
export function parseListPage(xml: string): {
  objects: S3Object[];
  next: string | null;
} {
  const objects: S3Object[] = [];
  for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = m[1]!;
    const key = tag(block, "Key");
    if (key === null) continue;
    objects.push({
      key,
      size: Number(tag(block, "Size") ?? 0),
      lastModified: Date.parse(tag(block, "LastModified") ?? "") || 0,
    });
  }
  const truncated = tag(xml, "IsTruncated") === "true";
  return {
    objects,
    next: truncated ? tag(xml, "NextContinuationToken") : null,
  };
}

/**
 * Minimal S3 client: exactly the calls the music library needs, signed
 * with SigV4 by `aws4fetch` (a small, dependency-free signer). The AWS
 * SDK would also work but drags in ~100 packages for five requests.
 */
export class S3Bucket {
  readonly #aws: AwsClient;
  readonly #base: string;
  readonly #fetch: typeof fetch;
  readonly name: string;

  constructor(settings: S3Settings, fetchImpl: typeof fetch = globalThis.fetch) {
    this.#aws = new AwsClient({
      accessKeyId: settings.accessKeyId,
      secretAccessKey: settings.secretAccessKey,
      region: settings.region,
      service: "s3",
    });
    const endpoint = settings.endpoint.replace(/\/+$/, "");
    if (settings.forcePathStyle) {
      this.#base = `${endpoint}/${encodeKey(settings.bucket)}`;
    } else {
      const u = new URL(endpoint);
      this.#base = `${u.protocol}//${settings.bucket}.${u.host}`;
    }
    this.#fetch = fetchImpl;
    this.name = settings.bucket;
  }

  async #send(url: string, init: RequestInit = {}): Promise<Response> {
    const signed = await this.#aws.sign(url, init);
    return this.#fetch(signed);
  }

  #url(key: string): string {
    return `${this.#base}/${encodeKey(key)}`;
  }

  /** Size + mtime, or null when the object does not exist. */
  async head(key: string): Promise<S3Object | null> {
    const res = await this.#send(this.#url(key), { method: "HEAD" });
    if (res.status === 404) return null;
    if (!res.ok) throw new S3Error("HEAD", key, res.status);
    return {
      key,
      size: Number(res.headers.get("content-length") ?? 0),
      lastModified: Date.parse(res.headers.get("last-modified") ?? "") || 0,
    };
  }

  /** The object's body (optionally an inclusive byte range), or null
   *  when it does not exist. The caller must consume or cancel it. */
  async get(
    key: string,
    range?: { start: number; end: number } | null,
  ): Promise<Response | null> {
    const headers: Record<string, string> = {};
    if (range) headers["Range"] = `bytes=${range.start}-${range.end}`;
    const res = await this.#send(this.#url(key), { headers });
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new S3Error("GET", key, res.status);
    }
    return res;
  }

  /** Whole object as bytes, or null when missing. */
  async getBytes(key: string): Promise<Uint8Array | null> {
    const res = await this.get(key);
    return res ? new Uint8Array(await res.arrayBuffer()) : null;
  }

  /** Uploads bytes, or a stream of known length (S3 needs Content-Length;
   *  the payload is sent unsigned, which S3 and OCI accept over TLS). */
  async put(
    key: string,
    body: Uint8Array | Readable,
    opts: { contentType?: string; size?: number } = {},
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": opts.contentType ?? "application/octet-stream",
    };
    let init: RequestInit & { duplex?: "half" };
    if (body instanceof Uint8Array) {
      init = { method: "PUT", headers, body };
    } else {
      if (opts.size === undefined) {
        throw new Error("s3 put: a stream needs its size");
      }
      headers["Content-Length"] = String(opts.size);
      headers["X-Amz-Content-Sha256"] = "UNSIGNED-PAYLOAD";
      init = {
        method: "PUT",
        headers,
        body: Readable.toWeb(body) as ReadableStream,
        duplex: "half",
      };
    }
    const res = await this.#send(this.#url(key), init);
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new S3Error("PUT", key, res.status, detail);
    }
    await res.body?.cancel();
  }

  async delete(key: string): Promise<void> {
    const res = await this.#send(this.#url(key), { method: "DELETE" });
    await res.body?.cancel();
    if (!res.ok && res.status !== 404) {
      throw new S3Error("DELETE", key, res.status);
    }
  }

  /** Every object under `prefix` (all pages). */
  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | null = null;
    do {
      const q = new URLSearchParams({ "list-type": "2", prefix });
      if (token) q.set("continuation-token", token);
      const res = await this.#send(`${this.#base}?${q.toString()}`);
      if (!res.ok) {
        await res.body?.cancel();
        throw new S3Error("LIST", prefix, res.status);
      }
      const page = parseListPage(await res.text());
      out.push(...page.objects);
      token = page.next;
    } while (token);
    return out;
  }
}
