import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Pool, PoolClient } from "pg";

export interface ApiReadinessProbe {
  check(): Promise<boolean>;
}

export class PostgresApiReadinessProbe implements ApiReadinessProbe {
  constructor(
    private readonly pool: Pool,
    private readonly expectedMigrations: readonly string[],
  ) {}

  async check() {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN READ ONLY");
      await client.query("SET LOCAL statement_timeout = '10s'");
      return await migrationsReady(client, this.expectedMigrations)
        && await browserAccessLockedDown(client);
    } catch {
      return false;
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      client.release();
    }
  }
}

export async function createPostgresApiReadinessProbe(
  pool: Pool,
  migrationDirectory = defaultMigrationDirectory(),
) {
  const expectedMigrations = (await readdir(migrationDirectory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return new PostgresApiReadinessProbe(pool, expectedMigrations);
}

async function migrationsReady(client: PoolClient, expected: readonly string[]) {
  if (!expected.length) return false;
  const result = await client.query<{ name: string }>(
    "SELECT name FROM public.canvas_schema_migrations ORDER BY name",
  );
  const applied = new Set(result.rows.map((row) => row.name));
  return expected.every((name) => applied.has(name));
}

async function browserAccessLockedDown(client: PoolClient) {
  const roles = await client.query<{ role_count: string | number }>(
    `SELECT COUNT(*)::INTEGER AS role_count
     FROM pg_roles
     WHERE rolname IN ('anon', 'authenticated')`,
  );
  if (Number(roles.rows[0]?.role_count ?? 0) !== 2) return false;

  const tables = await client.query<{
    table_count: string | number;
    insecure_count: string | number;
  }>(
    `SELECT
       COUNT(*)::INTEGER AS table_count,
       COUNT(*) FILTER (
         WHERE NOT c.relrowsecurity
           OR COALESCE(has_table_privilege(
             to_regrole('anon'), c.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           ), FALSE)
           OR COALESCE(has_table_privilege(
             to_regrole('authenticated'), c.oid,
             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           ), FALSE)
       )::INTEGER AS insecure_count
     FROM pg_class AS c
     INNER JOIN pg_namespace AS n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE 'canvas\_%' ESCAPE '\\'`,
  );
  return Number(tables.rows[0]?.table_count ?? 0) > 0
    && Number(tables.rows[0]?.insecure_count ?? 0) === 0;
}

function defaultMigrationDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
}
