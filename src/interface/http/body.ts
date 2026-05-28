import type { IncomingMessage } from "node:http";
import { PayloadTooLargeError } from "../../domain/errors.ts";

/** Reads a request body up to `limit` bytes and parses it as JSON. */
export function readJsonBody(
  req: IncomingMessage,
  limit: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new PayloadTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err instanceof Error ? err : new SyntaxError("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
