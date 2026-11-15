import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createAdaptorServer } from "@hono/node-server";
import type { Server } from "node:http";

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

const NOW = Date.parse("2026-11-06T08:00:00.000Z");
const USER_ID = "99999999-9999-4999-8999-999999999999";
const TOKEN = "H".repeat(43);
const HOSTED_MEDIA_ID = "phm_canvas-video-delivery_0";
const VIDEO = Buffer.from("hosted-video-bytes-for-the-real-listener");

/**
 * 托管成片经真实 node 监听器交付的回归。
 *
 * 生产上媒体交付路径反复抛
 * `TypeError: Response body object should not be disturbed or locked`
 * （`extractBody` ← `@hono/node-server` 的 `Response$1` 缓存重建 ←
 * `hostedMediaResponse` 读 `upstream.body` 再包一层）。这条链路只有在真实
 * 监听器下才成立：Hono 的全局中间件在 `await next()` 之后还要写 4 个头，每写
 * 一个就把响应重新包一层，重建次数被放大。所以这里不用 `app.request()`，直接
 * 起真正的 http server，并让 `openMedia` 复现生产的形状——字节先被归类归档流程
 * `clone()` 读走一遍，交付的仍是同一条响应对象。
 */
describe.each([
  ["原生 Response（当前生产配置）", false],
  ["@hono/node-server 的 Response 替身", true],
] as const)("hosted media delivery through the real listener (%s)", (_label, override) => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  });

  async function start(archiveDrainsClone: boolean) {
    const identity = new IdentityService(new MemoryIdentityStore(), {
      now: () => NOW,
      createId: () => USER_ID,
      createToken: () => TOKEN,
      passwordHasher: new TestPasswordHasher(),
      sessionTtlMs: 60 * 60_000,
    });
    const app = createApiApp({
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
      generation: {
        // 与 `openMedia` 的产出形状一致：本地构造的流式响应。
        openMedia: async (_ownerId, _mediaId, _token, range) => {
          const match = range ? /^bytes=(\d+)-(\d+)?$/u.exec(range.trim()) : null;
          const start = match ? Number(match[1]) : 0;
          const end =
            match && match[2] ? Math.min(Number(match[2]), VIDEO.length - 1) : VIDEO.length - 1;
          const body = VIDEO.subarray(start, end + 1);
          const response = new Response(Readable.toWeb(Readable.from(body)) as ReadableStream, {
            status: range ? 206 : 200,
            headers: {
              "Accept-Ranges": "bytes",
              "Cache-Control": "private, no-store, no-transform",
              "Content-Length": String(body.length),
              "Content-Type": "video/mp4",
              "X-Content-Type-Options": "nosniff",
              ...(range ? { "Content-Range": `bytes ${start}-${end}/${VIDEO.length}` } : {}),
            },
          });
          if (archiveDrainsClone) {
            // 归档走的是 clone 分支；这里把它读干净，交付对象保持不变。
            const clone = response.clone();
            await clone.arrayBuffer();
          }
          return { data: response };
        },
      },
    });

    const registration = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ email: "delivery@example.com", password: "private-password" }),
    });
    const cookie = registration.headers.get("Set-Cookie")!.split(";", 1)[0]!;

    const created = createAdaptorServer({
      fetch: app.fetch,
      overrideGlobalObjects: override,
    }) as Server;
    server = created;
    const port = await new Promise<number>((resolve) => {
      created.listen(0, "127.0.0.1", () => resolve((created.address() as AddressInfo).port));
    });
    return { cookie, base: `http://127.0.0.1:${port}` };
  }

  it("serves the full artifact with the delivery headers", async () => {
    const { cookie, base } = await start(true);
    const response = await fetch(`${base}/api/v1/media/${HOSTED_MEDIA_ID}/content`, {
      headers: { Cookie: cookie },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("cache-control")).toBe("private, no-store, no-transform");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO);
  });

  it("serves a byte range without dropping the partial status", async () => {
    const { cookie, base } = await start(true);
    const response = await fetch(`${base}/api/v1/media/${HOSTED_MEDIA_ID}/content`, {
      headers: { Cookie: cookie, Range: "bytes=7-13" },
    });

    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 7-13/${VIDEO.length}`);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(VIDEO.subarray(7, 14));
  });
});

class TestPasswordHasher implements IdentityPasswordHasher {
  async hash(password: string) {
    return `test:${password}`;
  }

  async verify(password: string, hash: string) {
    return hash === `test:${password}`;
  }
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
