import { describe, expect, it } from "vitest";

import { ScryptPasswordHasher } from "./password.js";
import { hashSessionToken, IdentityService, IdentityServiceError } from "./service.js";
import type {
  ActiveIdentitySession,
  CreateIdentityAccountResult,
  IdentityPasswordHasher,
  IdentitySessionRecord,
  IdentityStore,
  IdentityUserRecord,
} from "./types.js";

const NOW = Date.parse("2026-07-15T12:00:00.000Z");
const USER_ID = "11111111-1111-4111-8111-111111111111";
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);

describe("identity service", () => {
  it("registers an account, wallet, and hashed session without retaining the password", async () => {
    const store = new MemoryIdentityStore();
    const service = createService(store, [TOKEN_A]);

    const issued = await service.register({
      email: " Creator@Example.com ",
      password: "private-password",
      displayName: "  创作者  ",
    });

    expect(issued).toMatchObject({
      token: TOKEN_A,
      user: { id: USER_ID, email: "creator@example.com", displayName: "创作者" },
    });
    expect(store.user?.passwordHash).toBe("test-hash:private-password");
    expect(JSON.stringify(store.user)).not.toContain('"password":"');
    expect(store.session?.tokenHash).toBe(hashSessionToken(TOKEN_A));
    expect(store.initialCreditMicros).toBe(0);
  });

  it("rejects duplicate registration without creating another session", async () => {
    const store = new MemoryIdentityStore();
    const service = createService(store, [TOKEN_A, TOKEN_B]);
    await service.register({ email: "creator@example.com", password: "private-password" });

    await expect(service.register({
      email: "CREATOR@example.com",
      password: "another-password",
    })).rejects.toMatchObject({ code: "EMAIL_TAKEN" });
    expect(store.sessions).toHaveLength(1);
  });

  it("uses a generic login error and creates a new session only for valid credentials", async () => {
    const store = new MemoryIdentityStore();
    const service = createService(store, [TOKEN_A, TOKEN_B]);
    await service.register({ email: "creator@example.com", password: "private-password" });

    await expect(service.login({
      email: "missing@example.com",
      password: "private-password",
    })).rejects.toEqual(expect.objectContaining<Partial<IdentityServiceError>>({ code: "INVALID_CREDENTIALS" }));
    await expect(service.login({
      email: "creator@example.com",
      password: "wrong-password",
    })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    const loggedIn = await service.login({ email: "creator@example.com", password: "private-password" });
    expect(loggedIn.token).toBe(TOKEN_B);
    expect(store.sessions).toHaveLength(2);
  });

  it("authenticates active sessions and makes logout idempotent", async () => {
    const store = new MemoryIdentityStore();
    const service = createService(store, [TOKEN_A]);
    await service.register({ email: "creator@example.com", password: "private-password" });

    expect(await service.authenticate(TOKEN_A)).toMatchObject({ user: { id: USER_ID } });
    expect(await service.authenticate("invalid")).toBeNull();
    await service.logout(TOKEN_A);
    await service.logout(TOKEN_A);
    expect(await service.authenticate(TOKEN_A)).toBeNull();
  });
});

describe("scrypt password hashing", () => {
  it("uses a random salt and constant-time digest comparison", async () => {
    const hasher = new ScryptPasswordHasher();
    const first = await hasher.hash("a secure password");
    const second = await hasher.hash("a secure password");

    expect(first).not.toBe(second);
    expect(first).not.toContain("a secure password");
    expect(await hasher.verify("a secure password", first)).toBe(true);
    expect(await hasher.verify("wrong password", first)).toBe(false);
    expect(await hasher.verify("a secure password", "invalid-hash")).toBe(false);
  });
});

class MemoryIdentityStore implements IdentityStore {
  user: IdentityUserRecord | null = null;
  session: IdentitySessionRecord | null = null;
  sessions: IdentitySessionRecord[] = [];
  initialCreditMicros: number | null = null;

  async createAccount(
    user: IdentityUserRecord,
    session: IdentitySessionRecord,
    initialCreditMicros: number,
  ): Promise<CreateIdentityAccountResult> {
    if (this.user?.normalizedEmail === user.normalizedEmail) return { kind: "email_taken" };
    this.user = structuredClone(user);
    this.initialCreditMicros = initialCreditMicros;
    this.saveSession(session);
    return { kind: "created" };
  }

  async findUserByNormalizedEmail(normalizedEmail: string) {
    return this.user?.normalizedEmail === normalizedEmail ? structuredClone(this.user) : null;
  }

  async createSession(session: IdentitySessionRecord) {
    if (!this.user || this.user.id !== session.userId || this.user.status !== "active") return false;
    this.saveSession(session);
    return true;
  }

  async findActiveSession(tokenHash: string, now: string): Promise<ActiveIdentitySession | null> {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (!session || session.revokedAt || session.expiresAt <= now || !this.user || this.user.status !== "active") return null;
    return { user: structuredClone(this.user), session: structuredClone(session) };
  }

  async revokeSession(tokenHash: string, revokedAt: string) {
    const session = this.sessions.find((item) => item.tokenHash === tokenHash);
    if (session && !session.revokedAt) session.revokedAt = revokedAt;
  }

  private saveSession(session: IdentitySessionRecord) {
    this.session = structuredClone(session);
    this.sessions.push(this.session);
  }
}

function createService(store: IdentityStore, tokens: string[]) {
  let tokenIndex = 0;
  return new IdentityService(store, {
    now: () => NOW,
    createId: () => USER_ID,
    createToken: () => tokens[tokenIndex++] ?? "Z".repeat(43),
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
  });
}

class TestPasswordHasher implements IdentityPasswordHasher {
  async hash(password: string) {
    return `test-hash:${password}`;
  }

  async verify(password: string, encodedHash: string) {
    return encodedHash === `test-hash:${password}`;
  }
}
