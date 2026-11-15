import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { IdentityService } from "../identity/service.js";
import type {
  ActiveIdentitySession,
  CreateIdentityAccountResult,
  IdentityPasswordHasher,
  IdentitySessionRecord,
  IdentityStore,
  IdentityUserRecord,
} from "../identity/types.js";
import { MediaService } from "./service.js";
import { SignedMediaAccess } from "./signed-access.js";
import {
  hostedMediaResponse,
  MEDIA_CONTENT_CACHE_CONTROL,
  MEDIA_NO_STORE_CACHE_CONTROL,
  MEDIA_THUMB_CACHE_CONTROL,
  mediaContentResponse,
} from "./http.js";
import type {
  CreateMediaResult,
  InspectedMedia,
  MediaInspector,
  MediaMetadataStore,
  MediaObjectRead,
  MediaObjectStore,
  MediaRecord,
} from "./types.js";

const NOW = Date.parse("2026-07-15T17:00:00.000Z");
const USER_ID = "77777777-7777-4777-8777-777777777777";
const MEDIA_ID = "88888888-8888-4888-8888-888888888888";
const TOKEN = "G".repeat(43);
const BYTES = Buffer.from("http-media-content");
const SIGNING_SECRET = "test-secret-with-at-least-thirty-two-bytes";

describe("media HTTP API", () => {
  it("creates, uploads, reads metadata, and serves authenticated byte ranges", async () => {
    const app = createApp();
    const cookie = await register(app);
    const intent = await app.request("http://localhost/api/v1/media/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost" },
      body: JSON.stringify({
        kind: "image",
        name: "reference.png",
        mimeType: "image/png",
        size: BYTES.length,
        idempotencyKey: "http:upload:one",
      }),
    });

    expect(intent.status).toBe(200);
    expect(await intent.json()).toMatchObject({
      ok: true,
      data: {
        media: { id: MEDIA_ID, status: "pending" },
        upload: {
          method: "PUT",
          url: `/api/v1/media/${MEDIA_ID}/content`,
          headers: { "Content-Type": "image/png" },
          completeUrl: null,
        },
      },
    });

    const upload = await app.request(`http://localhost/api/v1/media/${MEDIA_ID}/content`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(BYTES.length),
        Cookie: cookie,
        Origin: "http://localhost",
      },
      body: BYTES,
    });
    expect(upload.status).toBe(200);
    expect(await upload.json()).toMatchObject({
      data: { status: "ready", width: 80, height: 45, size: BYTES.length },
    });

    const metadata = await app.request(`http://localhost/api/v1/media/${MEDIA_ID}`, {
      headers: { Cookie: cookie },
    });
    expect(await metadata.json()).toMatchObject({
      data: { status: "ready", mimeType: "image/png" },
    });

    const content = await app.request(`http://localhost/api/v1/media/${MEDIA_ID}/content`, {
      headers: { Cookie: cookie, Range: "bytes=2-6" },
    });
    expect(content.status).toBe(206);
    expect(content.headers.get("Content-Range")).toBe(`bytes 2-6/${BYTES.length}`);
    // 画布内展示的字节允许落在浏览器私有缓存里：重开项目、重挂节点时不必再
    // 跨洋回源一次。`private` 只给请求者自己的浏览器。
    expect(content.headers.get("Cache-Control")).toBe("private, max-age=3600, no-transform");
    expect(Buffer.from(await content.arrayBuffer())).toEqual(BYTES.subarray(2, 7));

    const explicitFullRange = await app.request(
      `http://localhost/api/v1/media/${MEDIA_ID}/content`,
      {
        headers: { Cookie: cookie, Range: `bytes=0-${BYTES.length - 1}` },
      },
    );
    expect(explicitFullRange.status).toBe(206);
    expect(explicitFullRange.headers.get("Content-Range")).toBe(
      `bytes 0-${BYTES.length - 1}/${BYTES.length}`,
    );

    const signedUrl = new SignedMediaAccess({
      secret: SIGNING_SECRET,
      baseUrl: "http://localhost",
      allowInsecureLocalhost: true,
      now: () => NOW,
    }).createUrl(MEDIA_ID, "image");
    const providerRead = await app.request(signedUrl);
    expect(providerRead.status).toBe(200);
    expect(Buffer.from(await providerRead.arrayBuffer())).toEqual(BYTES);
    const tampered = new URL(signedUrl);
    tampered.searchParams.set("kind", "video");
    expect((await app.request(tampered)).status).toBe(404);

    const invalidRange = await app.request(`http://localhost/api/v1/media/${MEDIA_ID}/content`, {
      headers: { Cookie: cookie, Range: "bytes=999-1000" },
    });
    expect(invalidRange.status).toBe(416);
    expect(invalidRange.headers.get("Content-Range")).toBe(`bytes */${BYTES.length}`);
  });

  it("requires a session and rejects cross-site writes before reading bytes", async () => {
    const app = createApp();
    expect((await app.request("/api/v1/media/missing")).status).toBe(401);
    const cookie = await register(app);
    const response = await app.request(`http://localhost/api/v1/media/${MEDIA_ID}/content`, {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        Cookie: cookie,
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: BYTES,
    });
    expect(response.status).toBe(403);
  });

  it("completes direct uploads and redirects authenticated reads to private capabilities", async () => {
    const objects = new MemoryDirectObjectStore();
    const app = createApp(objects);
    const cookie = await register(app);
    const intent = await app.request("http://localhost/api/v1/media/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie, Origin: "http://localhost" },
      body: JSON.stringify({
        kind: "image",
        name: "reference.png",
        mimeType: "image/png",
        size: BYTES.length,
        idempotencyKey: "http:direct:one",
      }),
    });
    expect(await intent.json()).toMatchObject({
      data: {
        upload: {
          method: "PUT",
          url: "https://objects.example.test/upload",
          completeUrl: `/api/v1/media/${MEDIA_ID}/complete`,
        },
      },
    });
    objects.seed(BYTES);

    const complete = await app.request(`http://localhost/api/v1/media/${MEDIA_ID}/complete`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost" },
    });
    expect(complete.status).toBe(200);
    expect(await complete.json()).toMatchObject({ data: { status: "ready" } });

    const content = await app.request(`http://localhost/api/v1/media/${MEDIA_ID}/content`, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    expect(content.status).toBe(307);
    expect(content.headers.get("Location")).toBe("https://objects.example.test/download");

    const download = await app.request(
      `http://localhost/api/v1/media/${MEDIA_ID}/content?download=1`,
      {
        headers: { Cookie: cookie },
      },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Disposition")).toBe(
      'attachment; filename="reference.png"',
    );
    // 显式下载要的是当下这一份：不落缓存。
    expect(download.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
    expect(Buffer.from(await download.arrayBuffer())).toEqual(BYTES);

    const signedUrl = new SignedMediaAccess({
      secret: SIGNING_SECRET,
      baseUrl: "http://localhost",
      allowInsecureLocalhost: true,
      now: () => NOW,
    }).createUrl(MEDIA_ID, "image");
    const delivery = await app.request(signedUrl, { redirect: "manual" });
    expect(delivery.status).toBe(200);
    expect(Buffer.from(await delivery.arrayBuffer())).toEqual(BYTES);
  });

  it("serves node thumbnails under a browser-cacheable private policy", () => {
    // 缩略图是画布上每一张预览图的来源：它以前跟着原图一起 `no-store`，于是
    // 每次重开项目、每次重挂节点都要重新跨洋下载一遍。
    const content = {
      media: { id: MEDIA_ID, name: "reference.png", mimeType: "image/png", kind: "image" },
      object: {
        stream: Readable.from([BYTES]),
        start: 0,
        end: BYTES.length - 1,
        totalSize: BYTES.length,
      },
    } as unknown as Parameters<typeof mediaContentResponse>[0];

    const thumb = mediaContentResponse(content, false, false, MEDIA_THUMB_CACHE_CONTROL);
    expect(thumb.headers.get("Cache-Control")).toBe("private, max-age=86400, no-transform");

    const contentBytes = mediaContentResponse(content, true, false, MEDIA_CONTENT_CACHE_CONTROL);
    expect(contentBytes.headers.get("Cache-Control")).toBe("private, max-age=3600, no-transform");

    // 未指定策略时保持原来的「不进任何缓存」。
    const defaulted = mediaContentResponse(content, false);
    expect(defaulted.headers.get("Cache-Control")).toBe(MEDIA_NO_STORE_CACHE_CONTROL);
    expect(defaulted.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
  });
});

describe("hostedMediaResponse", () => {
  // 回归：生产上 21 次 `TypeError: Response body object should not be disturbed
  // or locked`，栈全部落在 `http.ts` 的
  // `new Response(upstream.body, …)`（extractBody ← @hono/node-server 的
  // Response 替身重建）。归档流程会读走响应体的另一条分支，交付路径再读一次
  // `.body` 并重新绑定，就把"还能不能读"赌在了流的状态上。这里锁住三条不变量：
  // 能就地改头就不重建；不确定安全就原样返回；任何情况下都不抛。
  it("copies the delivery headers onto a mutable response without rebinding the body", async () => {
    const upstream = new Response("hosted-bytes", {
      status: 206,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": "12",
        "Content-Range": "bytes 0-11/12",
        "Accept-Ranges": "bytes",
        "X-Provider-Trace": "trace-1",
      },
    });

    const result = hostedMediaResponse(upstream);

    expect(result).toBe(upstream);
    expect(result.status).toBe(206);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.headers.get("Content-Range")).toBe("bytes 0-11/12");
    expect(result.headers.get("Accept-Ranges")).toBe("bytes");
    expect(await result.text()).toBe("hosted-bytes");
  });

  it("returns a response whose body is already consumed untouched instead of throwing", async () => {
    const upstream = new Response("consumed-bytes", {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    });
    await upstream.text();
    expect(upstream.bodyUsed).toBe(true);

    const result = hostedMediaResponse(upstream);

    expect(result).toBe(upstream);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("returns a response whose body stream is locked untouched instead of throwing", async () => {
    const upstream = new Response("locked-bytes", {
      status: 200,
      headers: { "Content-Type": "video/mp4" },
    });
    const reader = upstream.body!.getReader();
    expect(upstream.body!.locked).toBe(true);

    let result: Response | undefined;
    expect(() => {
      result = hostedMediaResponse(upstream);
    }).not.toThrow();
    expect(result).toBe(upstream);

    // 锁没被抢走，原持有者仍能把内容读完。
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    expect(Buffer.concat(chunks).toString()).toBe("locked-bytes");
  });

  it("rebuilds only when the headers are immutable and the body is provably readable", async () => {
    // undici 的 fetch 响应头部是 guard=immutable，`headers.set` 会抛
    // `TypeError: immutable`：这条路只能重建，用最小的替身复现即可。
    const bytes = Buffer.from("immutable-bytes");
    const stored = new Map<string, string>([
      ["Content-Type", "audio/mpeg"],
      ["Content-Length", String(bytes.length)],
    ]);
    const upstream = {
      status: 200,
      statusText: "",
      bodyUsed: false,
      body: Readable.toWeb(Readable.from(bytes)) as ReadableStream<Uint8Array>,
      headers: {
        get: (name: string) => stored.get(name) ?? null,
        set: () => {
          throw new TypeError("immutable");
        },
      },
    } as unknown as Response;

    const result = hostedMediaResponse(upstream);

    expect(result).not.toBe(upstream);
    expect(result.status).toBe(200);
    expect(result.headers.get("Cache-Control")).toBe("private, no-store, no-transform");
    expect(result.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(result.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(await result.text()).toBe("immutable-bytes");
  });
});

function createApp(objects: MediaObjectStore = new MemoryObjectStore()) {
  const identity = new IdentityService(new MemoryIdentityStore(), {
    now: () => NOW,
    createId: () => USER_ID,
    createToken: () => TOKEN,
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
  });
  const media = new MediaService(new MemoryMetadataStore(), objects, new FixedInspector(), {
    now: () => NOW,
    createId: () => MEDIA_ID,
    uploadTtlMs: 60_000,
  });
  return createApiApp({
    catalog: {
      getCatalog: async () => {
        throw new Error("unused");
      },
    },
    quotes: {
      createQuote: async () => {
        throw new Error("unused");
      },
    },
    identity,
    media,
    signedMedia: new SignedMediaAccess({ secret: SIGNING_SECRET, now: () => NOW }),
  });
}

async function register(app: ReturnType<typeof createApiApp>) {
  const response = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ email: "creator@example.com", password: "private-password" }),
  });
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

class MemoryIdentityStore implements IdentityStore {
  private user: IdentityUserRecord | null = null;
  private session: IdentitySessionRecord | null = null;

  async createAccount(
    user: IdentityUserRecord,
    session: IdentitySessionRecord,
  ): Promise<CreateIdentityAccountResult> {
    this.user = structuredClone(user);
    this.session = structuredClone(session);
    return { kind: "created" };
  }

  async findUserByNormalizedEmail() {
    return this.user ? structuredClone(this.user) : null;
  }

  async createSession(session: IdentitySessionRecord) {
    this.session = structuredClone(session);
    return true;
  }

  async findActiveSession(tokenHash: string, now: string): Promise<ActiveIdentitySession | null> {
    if (
      !this.user ||
      !this.session ||
      this.session.tokenHash !== tokenHash ||
      this.session.expiresAt <= now
    )
      return null;
    return { user: structuredClone(this.user), session: structuredClone(this.session) };
  }

  async revokeSession() {
    if (this.session) this.session.revokedAt = new Date(NOW).toISOString();
  }
}

class MemoryMetadataStore implements MediaMetadataStore {
  private media: MediaRecord | null = null;

  async findByIdempotency(ownerId: string, key: string) {
    return this.media?.ownerId === ownerId && this.media.idempotencyKey === key
      ? structuredClone(this.media)
      : null;
  }

  async getById(id: string) {
    return this.media?.id === id ? structuredClone(this.media) : null;
  }

  async create(media: MediaRecord): Promise<CreateMediaResult> {
    this.media = structuredClone(media);
    return { kind: "created", media: structuredClone(media) };
  }

  async deleteOwned(id: string, ownerId: string) {
    if (!this.media || this.media.id !== id || this.media.ownerId !== ownerId)
      return { kind: "missing" } as const;
    const [media] = [this.media];
    this.media = null;
    return { kind: "deleted", media: structuredClone(media) } as const;
  }

  async claimUpload(id: string, ownerId: string, revision: number, updatedAt: string) {
    return this.transition(id, ownerId, revision, "pending", { status: "uploading", updatedAt });
  }

  async resetUpload(id: string, ownerId: string, revision: number, updatedAt: string) {
    return this.transition(id, ownerId, revision, "uploading", { status: "pending", updatedAt });
  }

  async markReady(media: MediaRecord, revision: number) {
    if (!this.media || this.media.revision !== revision) return null;
    this.media = structuredClone(media);
    return structuredClone(media);
  }

  async markFailed(media: MediaRecord, revision: number) {
    return this.markReady(media, revision);
  }

  private transition(
    id: string,
    ownerId: string,
    revision: number,
    status: MediaRecord["status"],
    change: Pick<MediaRecord, "status" | "updatedAt">,
  ) {
    if (
      !this.media ||
      this.media.id !== id ||
      this.media.ownerId !== ownerId ||
      this.media.revision !== revision ||
      this.media.status !== status
    )
      return null;
    this.media = { ...this.media, ...change, revision: revision + 1 };
    return structuredClone(this.media);
  }
}

class MemoryObjectStore implements MediaObjectStore {
  protected bytes: Buffer | null = null;

  async write(_key: string, source: AsyncIterable<Uint8Array>) {
    const values: Buffer[] = [];
    for await (const value of source) values.push(Buffer.from(value));
    this.bytes = Buffer.concat(values);
    return {
      size: this.bytes.length,
      sha256: createHash("sha256").update(this.bytes).digest("hex"),
    };
  }

  async withLocalFile<T>(_key: string, action: (path: string) => Promise<T>) {
    if (!this.bytes) throw new Error("missing media");
    const directory = await mkdtemp(join(tmpdir(), "weftcanvas-http-media-"));
    const path = join(directory, "object.media");
    await writeFile(path, this.bytes);
    try {
      return await action(path);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async open(_key: string, range?: { start: number; end: number }): Promise<MediaObjectRead> {
    if (!this.bytes) throw new Error("missing media");
    const start = range?.start ?? 0;
    const end = range?.end ?? this.bytes.length - 1;
    return {
      stream: Readable.from(this.bytes.subarray(start, end + 1)),
      totalSize: this.bytes.length,
      start,
      end,
    };
  }

  async remove() {
    this.bytes = null;
  }

  seed(bytes: Buffer) {
    this.bytes = Buffer.from(bytes);
  }
}

class MemoryDirectObjectStore extends MemoryObjectStore {
  async createUploadInstruction(
    _key: string,
    options: {
      contentType: string;
      contentLength: number;
      sha256: string | null;
      expiresAt: string;
    },
  ) {
    return {
      method: "PUT" as const,
      url: "https://objects.example.test/upload",
      headers: { "Content-Type": options.contentType },
      expiresAt: options.expiresAt,
    };
  }

  async createDownloadInstruction() {
    return {
      url: "https://objects.example.test/download",
      expiresAt: new Date(NOW + 30_000).toISOString(),
    };
  }

  async withPendingUploadFile<T>(
    _key: string,
    action: (file: { path: string; versionToken: string }) => Promise<T>,
  ) {
    return this.withLocalFile(_key, (path) => action({ path, versionToken: "test-version" }));
  }

  async promotePendingUpload() {}

  async removePendingUpload() {}
}

class FixedInspector implements MediaInspector {
  async inspect(): Promise<InspectedMedia> {
    return {
      kind: "image",
      mimeType: "image/png",
      size: BYTES.length,
      width: 80,
      height: 45,
      durationMs: null,
    };
  }
}

class TestPasswordHasher implements IdentityPasswordHasher {
  async hash(password: string) {
    return `test:${password}`;
  }

  async verify(password: string, hash: string) {
    return hash === `test:${password}`;
  }
}
