import { spawn } from "node:child_process";

/**
 * Downscale a cover image to fit a `max`×`max` box and re-encode as
 * JPEG, using the already-sanctioned ffmpeg system binary (no new
 * dependency). Embedded ID3 art is frequently a full-resolution album
 * scan (hundreds of KB) — covers render at ~64px in the UI, so 250px
 * is plenty. Best-effort: if ffmpeg is missing or the bytes aren't a
 * decodable image, the original bytes are returned unchanged.
 *
 * The scale expression never upscales: the target box is capped at the
 * source dimensions, then `force_original_aspect_ratio=decrease` fits
 * the image inside it keeping aspect.
 */
export function resizeCover(
  bytes: Uint8Array,
  max = 250,
): Promise<Uint8Array> {
  return new Promise((resolve) => {
    const original = (): void => resolve(bytes);
    const ff = spawn(
      "ffmpeg",
      [
        "-v", "error",
        "-i", "pipe:0",
        "-vf",
        `scale='min(${max},iw)':'min(${max},ih)':force_original_aspect_ratio=decrease`,
        "-frames:v", "1",
        "-q:v", "5", // JPEG quality (2 best … 31 worst); 5 ≈ ~15-25 KB
        "-f", "mjpeg",
        "pipe:1",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const chunks: Buffer[] = [];
    ff.stdout.on("data", (c: Buffer) => chunks.push(c));
    ff.on("error", original); // ENOENT → ffmpeg not installed
    ff.on("close", (code) => {
      const out = Buffer.concat(chunks);
      if (code === 0 && out.byteLength > 0) resolve(new Uint8Array(out));
      else original(); // not an image / decode failed → keep original
    });
    ff.stdin.on("error", () => {
      /* EPIPE if ffmpeg bails before reading stdin — handled by close */
    });
    ff.stdin.end(Buffer.from(bytes));
  });
}
