import { describe, expect, it, vi } from "vitest";

import { createApiApp } from "../app.js";
import {
  IdentityService,
  type ActiveIdentitySession,
  type IdentityPasswordHasher,
  type IdentityStore,
  type IdentityUserRecord,
  type IdentitySessionRecord,
  type CreateIdentityAccountResult,
} from "../identity/service.js";

/**
 * 路由层：鉴权、契约校验、错误码，以及素材代拉的门槛（域名白名单、按跳校验、
 * 内容类型与大小上限）。这些是最不该只靠"看着对"的部分。
 */
const NOW = "2026-10-16T12:00:00.000Z";
const TOKEN = "E".repeat(43);
const TAPNOW_SHARE = "https://app.tapnow.media/tapflow/view/Share-1";

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function createHarness(options: { libtvToken?: string; fetch?: typeof globalThis.fetch } = {}) {
  const identity = new IdentityService(new MemoryIdentityStore(), {
    now: () => Date.parse(NOW),
    createId: () => "44444444-4444-4444-8444-444444444444",
    createToken: () => TOKEN,
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
  });
  const app = createApiApp({
    catalog: {
      getCatalog: async () => {
        throw new Error("catalog should not be called");
      },
    },
    quotes: {
      createQuote: async () => {
        throw new Error("quotes should not be called");
      },
    },
    identity,
    canvasImport: {
      ...(options.libtvToken ? { libtvToken: options.libtvToken } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
  });
  return app;
}

async function signIn(app: ReturnType<typeof createHarness>) {
  const response = await app.request("http://localhost/api/v1/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost" },
    body: JSON.stringify({ email: "creator@example.com", password: "private-password" }),
  });
  expect(response.status).toBe(201);
  return response.headers.get("Set-Cookie")!.split(";", 1)[0]!;
}

describe("第三方画布导入路由", () => {
  it("未登录时不暴露任何一段", async () => {
    const app = createHarness();
    expect((await app.request("/api/v1/canvas-import/providers")).status).toBe(401);
    expect(
      (
        await app.request("/api/v1/canvas-import/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "tapnow", reference: TAPNOW_SHARE }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await app.request("/api/v1/canvas-import/asset?p=tapnow&u=https://files.tapnow.media/a.png"))
        .status,
    ).toBe(401);
  });

  it("登录后按来源报可用性，缺令牌时 LibTV 说明差什么", async () => {
    const app = createHarness();
    const cookie = await signIn(app);
    const response = await app.request("/api/v1/canvas-import/providers", {
      headers: { Cookie: cookie },
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      data: { providers: Array<{ provider: string; available: boolean; reason: string }> };
    };
    expect(payload.data.providers).toHaveLength(3);
    expect(payload.data.providers.find((item) => item.provider === "libtv")).toMatchObject({
      available: false,
      reason: expect.stringContaining("LIBTV_CANVAS_TOKEN"),
    });
  });

  it("请求体不合契约报 422，LibTV 缺令牌报 503", async () => {
    const app = createHarness();
    const cookie = await signIn(app);
    const headers = { Cookie: cookie, "Content-Type": "application/json" };

    expect(
      (
        await app.request("/api/v1/canvas-import/preview", {
          method: "POST",
          headers,
          body: JSON.stringify({ provider: "not-a-provider", reference: "x" }),
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await app.request("/api/v1/canvas-import/preview", {
          method: "POST",
          headers,
          body: JSON.stringify({
            provider: "libtv",
            reference: "0123456789abcdef0123456789abcdef",
          }),
        })
      ).status,
    ).toBe(503);
  });

  it("预览返回可落地的节点、连线与同源素材路径", async () => {
    const fetchMock = async () =>
      jsonResponse({
        code: 0,
        data: {
          name: "短剧画布",
          nodes: [
            {
              id: "n1",
              type: "image",
              data: { title: "场景", src: "https://files.tapnow.media/a.png" },
              position: { x: 0, y: 0 },
              measured: { width: 360, height: 360 },
            },
          ],
          connections: [],
        },
      });
    const app = createHarness({ fetch: fetchMock as unknown as typeof globalThis.fetch });
    const cookie = await signIn(app);
    const response = await app.request("/api/v1/canvas-import/preview", {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "tapnow", reference: TAPNOW_SHARE }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as {
      ok: boolean;
      data: { nodes: Array<{ asset: { path: string } | null }>; projectName: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.data.projectName).toBe("短剧画布");
    expect(payload.data.nodes[0]?.asset?.path).toContain("/api/v1/canvas-import/asset?");
  });
});

describe("第三方画布素材代拉", () => {
  async function signedIn(fetchMock?: typeof globalThis.fetch) {
    const app = createHarness({ fetch: fetchMock });
    const cookie = await signIn(app);
    return { app, cookie };
  }

  it("白名单外的域名直接拒绝，且不发请求", async () => {
    const fetchMock = vi.fn();
    const { app, cookie } = await signedIn(fetchMock as unknown as typeof globalThis.fetch);
    const cases = [
      "https://evil.example.com/a.png",
      "https://files.tapnow.media.evil.com/a.png",
      "http://files.tapnow.media/a.png",
      "https://user:pass@files.tapnow.media/a.png",
    ];
    for (const target of cases) {
      const response = await app.request(
        `/api/v1/canvas-import/asset?p=tapnow&u=${encodeURIComponent(target)}`,
        { headers: { Cookie: cookie } },
      );
      expect(response.status, target).toBe(400);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "IMPORT_ASSET_BLOCKED",
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("重定向到别家主机时拦下来，不继续代拉", async () => {
    const fetchMock = vi.fn(
      async (input: string | URL) =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example.com/a.png" },
        }),
    );
    const { app, cookie } = await signedIn(fetchMock as unknown as typeof globalThis.fetch);
    const response = await app.request(
      `/api/v1/canvas-import/asset?p=tapnow&u=${encodeURIComponent("https://files.tapnow.media/a.png")}`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("放行的素材原样回字节，非图片/视频/音频拒绝", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const ok = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "image/png", "Content-Length": String(bytes.length) },
        }),
    );
    const { app, cookie } = await signedIn(ok as unknown as typeof globalThis.fetch);
    const response = await app.request(
      `/api/v1/canvas-import/asset?p=tapnow&u=${encodeURIComponent("https://files.tapnow.media/a.png")}`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    const html = vi.fn(
      async () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    );
    const blocked = await signedIn(html as unknown as typeof globalThis.fetch);
    const rejected = await blocked.app.request(
      `/api/v1/canvas-import/asset?p=tapnow&u=${encodeURIComponent("https://files.tapnow.media/page")}`,
      { headers: { Cookie: blocked.cookie } },
    );
    expect(rejected.status).toBe(415);
  });

  it("声明长度超过上限的素材直接拒绝", async () => {
    const tooLarge = vi.fn(
      async () =>
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(64 * 1024 * 1024),
          },
        }),
    );
    const { app, cookie } = await signedIn(tooLarge as unknown as typeof globalThis.fetch);
    const response = await app.request(
      `/api/v1/canvas-import/asset?p=tapnow&u=${encodeURIComponent("https://files.tapnow.media/a.png")}`,
      { headers: { Cookie: cookie } },
    );
    expect(response.status).toBe(413);
  });
});

class MemoryIdentityStore implements IdentityStore {
  private user: IdentityUserRecord | null = null;
  private sessions: IdentitySessionRecord[] = [];

  async createAccount(
    user: IdentityUserRecord,
    session: IdentitySessionRecord,
  ): Promise<CreateIdentityAccountResult> {
    if (this.user) return { kind: "email_taken" };
    this.user = structuredClone(user);
    this.sessions.push(structuredClone(session));
    return { kind: "created" };
  }

  async findUserByNormalizedEmail(email: string) {
    return this.user?.normalizedEmail === email ? structuredClone(this.user) : null;
  }

  async createSession(session: IdentitySessionRecord) {
    this.sessions.push(structuredClone(session));
    return true;
  }

  async findActiveSession(tokenHash: string, now: string): Promise<ActiveIdentitySession | null> {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now || !this.user) return null;
    return { user: structuredClone(this.user), session: structuredClone(session) };
  }

  async revokeSession(tokenHash: string, revokedAt: string) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (session) session.revokedAt = revokedAt;
  }
}

class TestPasswordHasher implements IdentityPasswordHasher {
  async hash(password: string) {
    return `test:${password}`;
  }

  async verify(password: string, encodedHash: string) {
    return encodedHash === `test:${password}`;
  }
}
