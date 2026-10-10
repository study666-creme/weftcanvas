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
    expect(setCookie).toContain("kachang_canvas_session=");
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Path=\//i);
    const cookie = setCookie.split(";", 1)[0]!;

    const session = await app.request("http://localhost/api/v1/auth/session", { headers: { Cookie: cookie } });
    expect(await session.json()).toMatchObject({ ok: true, data: { user: { displayName: "创作者" } } });

    const logout = await app.request("http://localhost/api/v1/auth/logout", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "http://localhost" },
    });
    expect(await logout.json()).toEqual({ ok: true });
    await expect((await app.request("http://localhost/api/v1/auth/session", { headers: { Cookie: cookie } })).json())
      .resolves.toEqual({
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
      error: { code: "INVALID_REQUEST", message: "邮箱地址格式不正确，请填写完整邮箱（例如 name@example.com）" },
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
      body: JSON.stringify({ email: "creator@example.com", password: "private-password", role: "admin" }),
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

function createApp(identity?: IdentityService) {
  return createApiApp({
    catalog: { getCatalog: async () => { throw new Error("catalog should not be called"); } },
    quotes: { createQuote: async () => { throw new Error("quotes should not be called"); } },
    identity,
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

  async createAccount(user: IdentityUserRecord, session: IdentitySessionRecord): Promise<CreateIdentityAccountResult> {
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
