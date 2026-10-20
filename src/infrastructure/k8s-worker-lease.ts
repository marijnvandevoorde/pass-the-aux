import fs from "node:fs";
import https from "node:https";
import { AnalyzerUnavailableError } from "../domain/errors.ts";
import type { WorkerLease } from "./worker-lease.ts";

/** Sets a Deployment's replica count. */
export type Scale = (replicas: number) => Promise<void>;

const SA_DIR = "/var/run/secrets/kubernetes.io/serviceaccount";

/**
 * `Scale` against the in-cluster API with the pod's service-account token
 * (needs `patch` on `deployments/scale` for that Deployment). Plain
 * `node:https`, because global fetch can't take the cluster CA.
 */
export function inClusterScale(deployment: string, namespace?: string): Scale {
  const host = process.env["KUBERNETES_SERVICE_HOST"];
  const port = process.env["KUBERNETES_SERVICE_PORT"] ?? "443";
  if (!host) throw new Error("not running inside Kubernetes");
  const ns = namespace || fs.readFileSync(`${SA_DIR}/namespace`, "utf8").trim();
  const ca = fs.readFileSync(`${SA_DIR}/ca.crt`);
  const path =
    `/apis/apps/v1/namespaces/${encodeURIComponent(ns)}` +
    `/deployments/${encodeURIComponent(deployment)}/scale`;
  return (replicas) =>
    new Promise((resolve, reject) => {
      // Re-read every time: the projected token is rotated by the kubelet.
      const token = fs.readFileSync(`${SA_DIR}/token`, "utf8").trim();
      const body = JSON.stringify({ spec: { replicas } });
      const req = https.request(
        {
          host: host.includes(":") ? `[${host}]` : host,
          port,
          path,
          method: "PATCH",
          ca,
          timeout: 15_000,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/merge-patch+json",
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (c: string) => (text += c));
          res.on("end", () => {
            const code = res.statusCode ?? 0;
            if (code >= 200 && code < 300) resolve();
            else reject(new Error(`scale ${deployment}: HTTP ${code} ${text.slice(0, 200)}`));
          });
        },
      );
      req.on("timeout", () => req.destroy(new Error("scale request timed out")));
      req.on("error", reject);
      req.end(body);
    });
}

export interface ScaledWorkerOptions {
  /** The Deployment's name, for logs and errors. */
  name: string;
  scale: Scale;
  /** The worker's health URL; ready when it answers 2xx with
   *  `model_loaded` not false. */
  healthUrl: string;
  /** Scale back to zero after this long without use. */
  idleMs: number;
  /** Give up on a start after this long (no room on the cluster, image
   *  pull stuck…). */
  readyTimeoutMs: number;
  /** After a failed start, don't try again for this long. */
  backoffMs: number;
  pollMs?: number;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** The error `acquire` throws when the worker can't be started.
   *  Default: `AnalyzerUnavailableError`. */
  unavailable?: (message: string) => Error;
  /** Clock for the idle check (tests). Default `Date.now`. */
  now?: () => number;
}

/**
 * Runs a worker Deployment only while there is work: the first `acquire`
 * scales it to one replica and waits for its health check, later ones
 * reuse it, and once nothing has held it for `idleMs` it goes back to
 * zero. A periodic check also scales it down if something else (a
 * manifest apply, a restart of this process) left it running.
 */
export class ScaledWorker implements WorkerLease {
  readonly #o: Required<ScaledWorkerOptions>;
  #ready = false;
  #starting: Promise<void> | null = null;
  #holders = 0;
  #lastUsed = 0;
  #blockedUntil = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(opts: ScaledWorkerOptions) {
    this.#o = {
      pollMs: 3000,
      fetchImpl: globalThis.fetch,
      log: (m) => console.log(m),
      unavailable: (m) => new AnalyzerUnavailableError(m),
      now: Date.now,
      ...opts,
    };
    this.#lastUsed = this.#o.now();
    this.#armIdle();
    this.#sweep = setInterval(
      () => void this.#scaleDownIfIdle(),
      Math.max(this.#o.idleMs, 10 * 60_000),
    );
    this.#sweep.unref?.();
  }

  async acquire(): Promise<void> {
    this.#holders++;
    clearTimeout(this.#idleTimer);
    try {
      if (this.#ready) return;
      if (Date.now() < this.#blockedUntil) {
        throw this.#o.unavailable(`${this.#o.name}: last start failed, backing off`);
      }
      this.#starting ??= this.#start().finally(() => {
        this.#starting = null;
      });
      await this.#starting;
    } catch (e) {
      this.release();
      throw e;
    }
  }

  release(): void {
    this.#holders = Math.max(0, this.#holders - 1);
    this.#lastUsed = this.#o.now();
    if (this.#holders === 0) this.#armIdle();
  }

  lost(): void {
    this.#ready = false;
  }

  /** Starts the worker in the background without holding it, so it is
   *  likely up by the time it is needed. Counts as use for the idle
   *  timer; a failed start only lands in the log. */
  warm(): void {
    this.acquire().then(
      () => this.release(),
      () => {},
    );
  }

  /** Stops the periodic check (tests, shutdown). */
  close(): void {
    clearInterval(this.#sweep);
    clearTimeout(this.#idleTimer);
  }

  async #start(): Promise<void> {
    const started = Date.now();
    try {
      if (!(await this.#healthy())) {
        this.#o.log(`${this.#o.name}: scaling up`);
        await this.#o.scale(1);
        while (!(await this.#healthy())) {
          if (Date.now() - started > this.#o.readyTimeoutMs) {
            throw new Error(`not ready after ${Math.round(this.#o.readyTimeoutMs / 1000)} s`);
          }
          await new Promise((r) => setTimeout(r, this.#o.pollMs));
        }
        this.#o.log(`${this.#o.name}: ready after ${Math.round((Date.now() - started) / 1000)} s`);
      }
      this.#ready = true;
    } catch (e) {
      this.#blockedUntil = Date.now() + this.#o.backoffMs;
      this.#o.log(`${this.#o.name}: start failed (${(e as Error).message}), scaling back down`);
      await this.#o.scale(0).catch(() => {});
      throw this.#o.unavailable(`${this.#o.name} did not start: ${(e as Error).message}`);
    }
  }

  async #healthy(): Promise<boolean> {
    try {
      const res = await this.#o.fetchImpl(this.#o.healthUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return false;
      }
      const j = (await res.json()) as { model_loaded?: unknown };
      return j.model_loaded !== false;
    } catch {
      return false;
    }
  }

  #armIdle(delayMs = this.#o.idleMs): void {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = setTimeout(() => void this.#scaleDownIfIdle(), delayMs);
    this.#idleTimer.unref?.();
  }

  async #scaleDownIfIdle(): Promise<void> {
    if (this.#holders > 0 || this.#starting) return;
    // A timer can fire a millisecond before the wall clock agrees that
    // `idleMs` has passed. Check again for the rest instead of giving up
    // (which left a stray worker running until the 10-minute sweep).
    const left = this.#o.idleMs - (this.#o.now() - this.#lastUsed);
    if (left > 0) {
      this.#armIdle(left);
      return;
    }
    const wasReady = this.#ready;
    this.#ready = false;
    try {
      await this.#o.scale(0); // idempotent; also catches strays
      if (wasReady) this.#o.log(`${this.#o.name}: idle, scaled to zero`);
    } catch (e) {
      this.#o.log(`${this.#o.name}: scale-down failed: ${(e as Error).message}`);
    }
  }
}
