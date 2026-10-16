import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { S3Bucket, parseListPage } from "../../src/infrastructure/s3-bucket.ts";
import {
  S3AudioSource,
  S3CoverStore,
  S3LibraryWriter,
  S3TrackRepository,
  s3LocalFiles,
  s3PrefixReader,
} from "../../src/infrastructure/s3-library.ts";
import {
  ForbiddenPathError,
  NotAudioError,
  TrackNotFoundError,
} from "../../src/domain/errors.ts";

/** In-memory S3 behind a fetch: path-style, the five calls we use. */
function fakeS3(pageSize = 1000): {
  fetchImpl: typeof fetch;
  objects: Map<string, Buffer>;
  requests: Request[];
} {
  const objects = new Map<string, Buffer>();
  const requests: Request[] = [];
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const fetchImpl = (async (input: Request) => {
    requests.push(input);
    assert.match(input.headers.get("authorization") ?? "", /^AWS4-HMAC-SHA256 /);
    const url = new URL(input.url);
    const [, bucket, ...rest] = url.pathname.split("/");
    assert.equal(bucket, "music");
    const key = rest.map(decodeURIComponent).join("/");
    if (key === "") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const after = url.searchParams.get("continuation-token");
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = after ? keys.indexOf(after) : 0;
      const page = keys.slice(from, from + pageSize);
      const next = keys[from + pageSize];
      const xml =
        `<ListBucketResult><IsTruncated>${next ? "true" : "false"}</IsTruncated>` +
        page
          .map(
            (k) =>
              `<Contents><Key>${esc(k)}</Key><LastModified>2026-10-16T08:00:00.000Z</LastModified>` +
              `<Size>${objects.get(k)!.length}</Size></Contents>`,
          )
          .join("") +
        (next ? `<NextContinuationToken>${esc(next)}</NextContinuationToken>` : "") +
        `</ListBucketResult>`;
      return new Response(xml);
    }
    const obj = objects.get(key);
    switch (input.method) {
      case "HEAD":
        return obj
          ? new Response(null, {
              headers: {
                "content-length": String(obj.length),
                "last-modified": "Fri, 16 Oct 2026 08:00:00 GMT",
              },
            })
          : new Response(null, { status: 404 });
      case "GET": {
        if (!obj) return new Response("NoSuchKey", { status: 404 });
        const m = /bytes=(\d+)-(\d+)/.exec(input.headers.get("range") ?? "");
        if (!m) return new Response(obj);
        const end = Math.min(Number(m[2]), obj.length - 1);
        return new Response(obj.subarray(Number(m[1]), end + 1), { status: 206 });
      }
      case "PUT":
        objects.set(key, Buffer.from(await input.arrayBuffer()));
        return new Response(null, { status: 200 });
      case "DELETE":
        objects.delete(key);
        return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;
  return { fetchImpl, objects, requests };
}

function bucket(s3: ReturnType<typeof fakeS3>): S3Bucket {
  return new S3Bucket(
    {
      endpoint: "https://s3.example.test/",
      bucket: "music",
      region: "eu-amsterdam-1",
      accessKeyId: "AK",
      secretAccessKey: "SK",
      forcePathStyle: true,
    },
    s3.fetchImpl,
  );
}

test("parseListPage unescapes keys and reads the continuation token", () => {
  const page = parseListPage(
    "<ListBucketResult><IsTruncated>true</IsTruncated>" +
      "<Contents><Key>u/A &amp; B.mp3</Key><Size>5</Size>" +
      "<LastModified>2026-10-16T08:00:00.000Z</LastModified></Contents>" +
      "<NextContinuationToken>tok&amp;1</NextContinuationToken></ListBucketResult>",
  );
  assert.deepEqual(page.objects, [
    { key: "u/A & B.mp3", size: 5, lastModified: Date.parse("2026-10-16T08:00:00Z") },
  ]);
  assert.equal(page.next, "tok&1");
});

test("keys are RFC 3986-encoded, including ()!*'", async () => {
  const s3 = fakeS3();
  await bucket(s3).head("u/Jack Ü - Where (Now)!.mp3");
  assert.equal(
    new URL(s3.requests[0]!.url).pathname,
    "/music/u/Jack%20%C3%9C%20-%20Where%20%28Now%29%21.mp3",
  );
});

test("track repository lists one user's audio, across pages, skipping the rest", async () => {
  const s3 = fakeS3(2);
  for (const k of ["u1/a.mp3", "u1/a.jpg", "u1/.hidden.mp3", "u1/b.m4a", "u1/sub/c.flac", "u2/x.mp3"]) {
    s3.objects.set(k, Buffer.from("12345"));
  }
  const repo = new S3TrackRepository(bucket(s3), "u1/");
  const ids = (await repo.list()).map((t) => t.id).sort();
  assert.deepEqual(ids, ["a.mp3", "b.m4a", "sub/c.flac"]);
  const t = await repo.findById("sub/c.flac");
  assert.equal(t?.name, "c.flac");
  assert.equal(t?.dir, "sub");
  assert.equal(t?.size, 5);
  assert.equal(await repo.findById("missing.mp3"), null);
  assert.equal(await repo.findById("../u2/x.mp3"), null);
});

test("audio source: stat, full stream and ranged stream", async () => {
  const s3 = fakeS3();
  s3.objects.set("u1/song.mp3", Buffer.from("0123456789"));
  const src = new S3AudioSource(bucket(s3), "u1/");
  assert.deepEqual(await src.stat("song.mp3"), {
    id: "song.mp3",
    size: 10,
    contentType: "audio/mpeg",
  });
  assert.equal(await text(src.createStream("song.mp3")), "0123456789");
  assert.equal(await text(src.createStream("song.mp3", { start: 2, end: 5 })), "2345");
  await assert.rejects(src.stat("nope.mp3"), TrackNotFoundError);
  await assert.rejects(src.stat("cover.jpg"), NotAudioError);
  await assert.rejects(src.stat("../u2/x.mp3"), ForbiddenPathError);
  await assert.rejects(text(src.createStream("nope.mp3")), TrackNotFoundError);
});

test("cover store keeps <base>.jpg next to the audio", async () => {
  const s3 = fakeS3();
  const covers = new S3CoverStore(bucket(s3), "u1/");
  assert.equal(await covers.has("song.mp3"), false);
  // not a decodable image → resizeCover hands the bytes back unchanged
  await covers.write("song.mp3", new Uint8Array([1, 2, 3]));
  assert.equal(await covers.has("song.mp3"), true);
  assert.deepEqual(s3.objects.get("u1/song.jpg"), Buffer.from([1, 2, 3]));
  assert.deepEqual(await covers.read("song.mp3"), new Uint8Array([1, 2, 3]));
  assert.equal(await covers.read("other.mp3"), null);
});

test("library writer uploads under a free, sanitised name and announces it", async () => {
  const s3 = fakeS3();
  s3.objects.set("u1/Artist - Song.mp3", Buffer.from("old"));
  let announced = 0;
  const w = new S3LibraryWriter(bucket(s3), "u1/", () => announced++);
  assert.equal(await w.existing("Artist - Song"), "Artist - Song.mp3");
  assert.equal(await w.existing("Other"), null);
  const id = await w.write(Readable.from([Buffer.from("new bytes")]), "Artist - Song", "mp3");
  assert.equal(id, "Artist - Song (1).mp3");
  assert.equal(s3.objects.get("u1/Artist - Song (1).mp3")?.toString(), "new bytes");
  assert.equal(await w.write(Readable.from([Buffer.from("x")]), "a/b:c", "flac"), "a_b_c.flac");
  assert.equal(announced, 2);
});

test("a failed download leaves nothing in the bucket", async () => {
  const s3 = fakeS3();
  let announced = 0;
  const w = new S3LibraryWriter(bucket(s3), "u1/", () => announced++);
  const broken = new Readable({
    read() {
      this.destroy(new Error("connection reset"));
    },
  });
  await assert.rejects(w.write(broken, "Song", "mp3"), /connection reset/);
  assert.equal(s3.objects.size, 0);
  assert.equal(announced, 0);
});

test("prefix reader returns the first bytes; local files are temp copies", async () => {
  const s3 = fakeS3();
  s3.objects.set("u1/song.mp3", Buffer.from("ID3 tag data and audio"));
  const read = s3PrefixReader(bucket(s3), "u1/");
  assert.equal(Buffer.from((await read("song.mp3", 3))!).toString(), "ID3");
  assert.equal(await read("missing.mp3", 3), null);

  const fs = await import("node:fs/promises");
  let seen = "";
  const out = await s3LocalFiles(bucket(s3), "u1/").withFile("song.mp3", async (abs) => {
    seen = abs;
    return (await fs.readFile(abs, "utf8")).length;
  });
  assert.equal(out, 22);
  assert.match(seen, /\.mp3$/);
  await assert.rejects(fs.access(seen)); // cleaned up
  assert.equal(
    await s3LocalFiles(bucket(s3), "u1/").withFile("missing.mp3", async () => 1),
    null,
  );
});
