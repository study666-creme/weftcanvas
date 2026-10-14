import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { PostgresApiReadinessProbe } from "./readiness.js";

function probe(options: { applied?: boolean; tables?: number; insecure?: number } = {}) {
  const client = {
    query: async (sql: string) => {
      if (sql.includes("SELECT name"))
        return { rows: options.applied === false ? [] : [{ name: "0001.sql" }] };
      // Vanilla PostgreSQL deliberately has neither Supabase browser role.
      if (sql.includes("pg_roles")) return { rows: [{ role_count: 0 }] };
      if (sql.includes("pg_class"))
        return {
          rows: [{ table_count: options.tables ?? 3, insecure_count: options.insecure ?? 0 }],
        };
      return { rows: [] };
    },
    release: () => undefined,
  };
  return new PostgresApiReadinessProbe({ connect: async () => client } as unknown as Pool, [
    "0001.sql",
  ]);
}

describe("native PostgreSQL readiness", () => {
  it("accepts migrated, protected tables without browser roles", async () => {
    expect(await probe().check()).toBe(true);
  });

  it("still rejects missing migrations", async () => {
    expect(await probe({ applied: false }).check()).toBe(false);
  });

  it("still rejects a database with no Canvas tables", async () => {
    expect(await probe({ tables: 0 }).check()).toBe(false);
  });

  it("still rejects insecure tables or grants to an existing browser role", async () => {
    expect(await probe({ insecure: 1 }).check()).toBe(false);
  });
});
