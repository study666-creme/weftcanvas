import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { IdentityService } from "./service.js";
import type {
  ActiveIdentitySession,
  CreateIdentityAccountResult,
  IdentityPasswordHasher,
  IdentitySessionRecord,
  IdentityStore,
  IdentityUserRecord,
} from "./types.js";

const NOW = Date.parse("2026-07-15T14:00:00.000Z");
const TOKEN = "F".repeat(43);

describe("identity HTTP API", () => {
  it("keeps the raw session token in an HttpOnly cookie and supports logout", async () => {
    const app = createApp(createIdentity());
    const register = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({
        email: "creator@example.com",
        password: "private-password",
        displayName: "创作者",
      }),
    });

    expect(register.status).toBe(201);
    const payload = await register.json();
    expect(payload).toMatchObject({ ok: true, data: { user: { email: "creator@example.com" } } });
    expect(JSON.stringify(payload)).not.toContain(TOKEN);
    const setCookie = register.headers.get("Set-Cookie")!;
    expect(setCookie).toContain("weftcanvas_session=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);
    const cookie = setCookie.split(";", 1)[0]!;

    const session = await app.request("http://localhost/api/v1/auth/session", {
      headers: { Cookie: cookie },
    });
    expect(await session.json()).toMatchObject({
      ok: true,
      data: { user: { displayName: "创作者" } },
    });

    const logout = await app.request("http://localhost/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost" },
    });
    expect(await logout.json()).toEqual({ ok: true });
    await expect(
      (
        await app.request("http://localhost/api/v1/auth/session", { headers: { Cookie: cookie } })
      ).json(),
    ).resolves.toEqual({
      ok: true,
      data: null,
      capabilities: {
        available: true,
        registration: "native",
        registrationUrl: null,
        passwordResetUrl: null,
      },
    });
  });

  it("rejects cross-site browser account requests and non-JSON credentials", async () => {
    const app = createApp(createIdentity());
    const crossSite = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: "{}",
    });
    expect(crossSite.status).toBe(403);

    const form = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=a%40example.com&password=test",
    });
    expect(form.status).toBe(415);
  });

  it("names the offending field instead of a generic request error", async () => {
    const app = createApp(createIdentity());
    const phoneAsEmail = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ email: "1322798576", password: "private-password" }),
    });
    expect(phoneAsEmail.status).toBe(400);
    expect(await phoneAsEmail.json()).toEqual({
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: "邮箱地址格式不正确，请填写完整邮箱（例如 name@example.com）",
      },
    });

    const shortPassword = await app.request("http://localhost/api/v1/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({ email: "creator@example.com", password: "short" }),
    });
    expect(shortPassword.status).toBe(400);
    expect(await shortPassword.json()).toEqual({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "密码需为 10-128 位" },
    });

    const unknownField = await app.request("http://localhost/api/v1/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify({
        email: "creator@example.com",
        password: "private-password",
        role: "admin",
      }),
    });
    expect(await unknownField.json()).toEqual({
      ok: false,
      error: { code: "INVALID_REQUEST", message: "请求参数不完整或格式不正确" },
    });
  });

  it("treats an unavailable identity service as an anonymous session", async () => {
    const app = createApp();
    expect((await app.request("/api/health")).status).toBe(200);
    const response = await app.request("/api/v1/auth/session");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      data: null,
      capabilities: {
        available: false,
        registration: "disabled",
        registrationUrl: null,
        passwordResetUrl: null,
      },
    });
  });
});

describe("client identity and sensitive-action rate limiting", () => {
  const env = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });
  const CREDENTIALS = { email: "creator@example.com", password: "private-password" };

  async function registerCreator(app: ReturnType<typeof createApp>, remoteAddress: string) {
    const response = await app.request(
      "http://localhost/api/v1/auth/register",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost" },
        body: JSON.stringify({ ...CREDENTIALS, displayName: "创作者" }),
      },
      env(remoteAddress),
    );
    expect(response.status).toBe(201);
  }

  const loginOnce = (
    app: ReturnType<typeof createApp>,
    headers: Record<string, string>,
    remoteAddress: string,
  ) =>
    app.request(
      "http://localhost/api/v1/auth/login",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "http://localhost",
          ...headers,
        },
        body: JSON.stringify(CREDENTIALS),
      },
      env(remoteAddress),
    );

  it("spoofed forwarded headers from an untrusted peer cannot reset the login bucket", async () => {
    const app = createApp(createIdentity());
    await registerCreator(app, "203.0.113.9");
    const statuses: number[] = [];
    for (let index = 0; index < 11; index += 1) {
      const response = await loginOnce(
        app,
        {
          // 直连对端是 203.0.113.9（公网、非可信代理）：这些头都必须被忽略。
          "cf-connecting-ip": `203.0.113.${index}`,
          "x-forwarded-for": `198.51.100.${index}`,
          "x-real-ip": `192.0.2.${index}`,
        },
        "203.0.113.9",
      );
      statuses.push(response.status);
    }
    // 前 10 次正常登录，第 11 次落在同一个桶里——伪造头没能造出新桶。
    expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 200));
    expect(statuses[10]).toBe(429);
  });

  it("honors the forwarded client address only when the peer is a trusted proxy", async () => {
    const app = createApp(createIdentity(), { trustedProxySpec: "127.0.0.1/8" });
    await registerCreator(app, "127.0.0.1");
    // 同一个可信代理转发、客户端 IP 各不相同 → 各自独立的桶。
    for (let index = 0; index < 11; index += 1) {
      const response = await loginOnce(
        app,
        { "x-forwarded-for": `198.51.100.${index}, 127.0.0.1` },
        "127.0.0.1",
      );
      expect(response.status).toBe(200);
    }
    // 换成同一个客户端 IP → 第 11 次被限流。
    let eleventh = 0;
    for (let index = 0; index < 11; index += 1) {
      const response = await loginOnce(
        app,
        { "x-forwarded-for": "198.51.100.77, 127.0.0.1" },
        "127.0.0.1",
      );
      eleventh = response.status;
    }
    expect(eleventh).toBe(429);
  });

  it("keeps direct-connection clients in distinct buckets by their own address", async () => {
    const app = createApp(createIdentity());
    await registerCreator(app, "203.0.113.9");
    for (let index = 0; index < 11; index += 1) {
      const response = await loginOnce(app, {}, `203.0.113.${index}`);
      expect(response.status).toBe(200);
    }
  });
});

function createApp(identity?: IdentityService, options: { trustedProxySpec?: string } = {}) {
  return createApiApp({
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
    trustedProxySpec: options.trustedProxySpec,
  });
}

function createIdentity() {
  return new IdentityService(new MemoryIdentityStore(), {
    now: () => NOW,
    createId: () => "44444444-4444-4444-8444-444444444444",
    createToken: () => TOKEN,
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
  });
}

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
