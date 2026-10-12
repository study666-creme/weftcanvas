import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../database/migrate.js";
import { PostgresFixedWindowRateLimiter } from "./api-rate-limit.js";

const databaseUrl = process.env.CANVAS_TEST_DATABASE_URL;
if (databaseUrl && !new URL(databaseUrl).pathname.toLowerCase().includes("test")) {
  throw new Error("CANVAS_TEST_DATABASE_URL must name a dedicated database containing 'test'");
}

describe.skipIf(!databaseUrl)("PostgreSQL generation API rate limiter", () => {
  let pool: Pool;
  let now = Date.parse("2026-07-15T21:00:00.000Z");

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await runMigrations(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE canvas_api_rate_limits");
    now = Date.parse("2026-07-15T21:00:00.000Z");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("admits no more than the shared limit under concurrency and resets by window", async () => {
    const limiter = new PostgresFixedWindowRateLimiter(pool, { now: () => now });
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () =>
        limiter.consume({
          scope: "generation:submit:minute",
          subjectId: "user-1",
          limit: 5,
          windowMs: 60_000,
        }),
      ),
    );
    expect(attempts.filter((result) => result.allowed)).toHaveLength(5);
    expect(attempts.filter((result) => !result.allowed)).toHaveLength(15);

    now += 60_000;
    await expect(
      limiter.consume({
        scope: "generation:submit:minute",
        subjectId: "user-1",
        limit: 5,
        windowMs: 60_000,
      }),
    ).resolves.toMatchObject({ allowed: true, remaining: 4 });
  });
});
