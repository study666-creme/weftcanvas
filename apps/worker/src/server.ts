import { hostname } from "node:os";

import { Pool } from "pg";

import { buildWorkerRuntime } from "./assembly.js";
import { parseWorkerMode } from "./mode.js";

const mode = parseWorkerMode(process.env);
const workerId = workerIdentity(process.env.WORKER_ID);
const pool = new Pool({ connectionString: required("DATABASE_URL") });
const runtime = buildWorkerRuntime({ pool, workerId, env: process.env }, mode);

const controller = new AbortController();
let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  controller.abort(new Error("Worker shutdown requested"));
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

console.log(`Canvas ${mode} worker started as ${workerId}`);
try {
  await runtime.run(controller.signal);
} finally {
  await pool.end();
}

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function workerIdentity(configured: string | undefined) {
  const machine = hostname().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "host";
  const value = configured?.trim() || `worker:${machine}:${process.pid}`;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new Error("WORKER_ID may only contain letters, numbers, dots, underscores, colons, and hyphens");
  }
  return value;
}
