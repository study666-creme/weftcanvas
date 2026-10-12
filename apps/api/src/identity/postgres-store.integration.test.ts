import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../database/migrate.js";
import { PostgresIdentityStore } from "./postgres-store.js";
import { IdentityService } from "./service.js";
import type { IdentityPasswordHasher } from "./types.js";

const databaseUrl = process.env.CANVAS_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("CANVAS_TEST_DATABASE_URL must name a dedicated database containing 'test'");
}

const NOW = Date.parse("2026-07-15T13:00:00.000Z");
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN_A = "C".repeat(43);
const TOKEN_B = "D".repeat(43);

describe.skipIf(!databaseUrl)("PostgreSQL identity store", () => {
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE canvas_wallet_ledger, canvas_sessions, canvas_users CASCADE");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates the account, wallet, ledger credit, and session atomically", async () => {
    const service = createService(pool, [TOKEN_A], 2_500_000);
    const result = await service.register({
      email: "creator@example.com",
      password: "private-password",
      displayName: "创作者",
    });

    expect(result.user.id).toBe(USER_ID);
    expect(await count(pool, "canvas_users")).toBe(1);
    expect(await count(pool, "canvas_sessions")).toBe(1);
    expect(
      await pool.query("SELECT available_credit_micros FROM canvas_wallets WHERE owner_id = $1", [
        USER_ID,
      ]),
    ).toMatchObject({ rows: [{ available_credit_micros: "2500000" }] });
    expect(await count(pool, "canvas_wallet_ledger")).toBe(1);
  });

  it("keeps concurrent duplicate registration to one complete account", async () => {
    const first = createService(pool, [TOKEN_A], 0, USER_ID);
    const second = createService(pool, [TOKEN_B], 0, "33333333-3333-4333-8333-333333333333");
    const results = await Promise.allSettled([
      first.register({ email: "creator@example.com", password: "private-password" }),
      second.register({ email: "CREATOR@example.com", password: "private-password" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await count(pool, "canvas_users")).toBe(1);
    expect(await count(pool, "canvas_wallets")).toBe(1);
    expect(await count(pool, "canvas_sessions")).toBe(1);
  });

  it("resolves and revokes login sessions without storing the raw token", async () => {
    const service = createService(pool, [TOKEN_A, TOKEN_B]);
    await service.register({ email: "creator@example.com", password: "private-password" });
    const login = await service.login({
      email: "creator@example.com",
      password: "private-password",
    });

    expect(login.token).toBe(TOKEN_B);
    expect(await service.authenticate(TOKEN_B)).toMatchObject({ user: { id: USER_ID } });
    expect(JSON.stringify((await pool.query("SELECT * FROM canvas_sessions")).rows)).not.toContain(
      TOKEN_B,
    );
    await service.logout(TOKEN_B);
    expect(await service.authenticate(TOKEN_B)).toBeNull();
  });
});

function createService(pool: Pool, tokens: string[], initialCreditMicros = 0, userId = USER_ID) {
  let tokenIndex = 0;
  return new IdentityService(new PostgresIdentityStore(pool), {
    now: () => NOW,
    createId: () => userId,
    createToken: () => tokens[tokenIndex++] ?? "E".repeat(43),
    passwordHasher: new TestPasswordHasher(),
    sessionTtlMs: 60_000,
    initialCreditMicros,
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

async function count(
  pool: Pool,
  table: "canvas_users" | "canvas_sessions" | "canvas_wallets" | "canvas_wallet_ledger",
) {
  const result = await pool.query<{ count: string }>(`SELECT COUNT(*) AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}
