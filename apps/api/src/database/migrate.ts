import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Pool, PoolClient } from "pg";

import { createDatabasePool } from "./pool.js";

const MIGRATION_LOCK_ID = 1_187_331_291;

export async function runMigrations(pool: Pool, directory = defaultMigrationDirectory()) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  const client = await pool.connect();
  let lockAcquired = false;
  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query("SET statement_timeout = '120s'");
    await client.query("SET idle_in_transaction_session_timeout = '60s'");
    const lock = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [MIGRATION_LOCK_ID],
    );
    if (lock.rows[0]?.acquired !== true) {
      throw new Error("Another Canvas migration process already holds the migration lock");
    }
    lockAcquired = true;
    await client.query(`
      CREATE TABLE IF NOT EXISTS canvas_schema_migrations (
        name TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const applied = await client.query<{ name: string }>("SELECT name FROM canvas_schema_migrations");
    const appliedNames = new Set(applied.rows.map((row) => row.name));
    for (const name of files) {
      if (!appliedNames.has(name)) await applyMigration(client, directory, name);
    }
  } finally {
    if (lockAcquired) await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
}

async function applyMigration(client: PoolClient, directory: string, name: string) {
  const sql = await readFile(resolve(directory, name), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("INSERT INTO canvas_schema_migrations (name) VALUES ($1)", [name]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

function defaultMigrationDirectory() {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../migrations");
}

async function main() {
  const pool = createDatabasePool();
  if (!pool) throw new Error("DATABASE_URL is required");
  try {
    await runMigrations(pool);
    console.log("Canvas database migrations are up to date");
  } finally {
    await pool.end();
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error("Canvas database migration failed", error);
    process.exitCode = 1;
  });
}
