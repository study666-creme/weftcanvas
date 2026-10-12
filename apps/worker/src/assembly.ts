import { lstat, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

import {
  DefaultMediaInspector,
  GenerationJobProcessor,
  GenerationResultMaterializer,
  GenerationWorkerRuntime,
  JsonGenerationResultStagingStore,
  WeftcanvasGenerationProvider,
  MediaMultipartWorkerRuntime,
  MediaService,
  PostgresGenerationJobStore,
  PostgresGenerationWorkQueue,
  PostgresMediaMetadataStore,
  PostgresMediaMultipartUploadStore,
  SignedMediaAccess,
  StaticCloudProjectEntitlementResolver,
  StoredGenerationReferenceResolver,
  ValidatedGenerationArtifactStore,
  createMediaObjectStore,
  maintainMediaObjectStore,
} from "@weftcanvas/canvas-api/worker";
import type { MediaObjectStore } from "@weftcanvas/canvas-api/worker";
import type { Pool } from "pg";

import type { WorkerMode } from "./mode.js";

export type WorkerRun =
  | {
      kind: "media-multipart";
      runtime: MediaMultipartWorkerRuntime;
      run: (signal: AbortSignal) => Promise<void>;
    }
  | {
      kind: "generation";
      runtime: GenerationWorkerRuntime;
      run: (signal: AbortSignal) => Promise<void>;
    };

export type AssemblyDependencies = {
  pool: Pool;
  workerId: string;
  env: NodeJS.ProcessEnv;
  maintainMediaObjects?: (objects: MediaObjectStore) => Promise<unknown>;
  cleanupGenerationDownloads?: (directory: string, olderThanMs: number) => Promise<number>;
};

export function buildWorkerRuntime(
  dependencies: AssemblyDependencies,
  mode: WorkerMode,
): WorkerRun {
  if (mode === "media-multipart") return buildMediaMultipartRuntime(dependencies);
  return buildGenerationRuntime(dependencies);
}

export function buildMediaMultipartRuntime(dependencies: AssemblyDependencies): WorkerRun {
  const { pool, workerId, env } = dependencies;
  const inspector = new DefaultMediaInspector();
  const objects = createMediaObjectStore(env);
  const media = new MediaService(new PostgresMediaMetadataStore(pool), objects, inspector);
  const queue = new PostgresMediaMultipartUploadStore(pool);
  const runtime = new MediaMultipartWorkerRuntime(queue, media, {
    owner: workerId,
    leaseDurationMs: readInteger(
      env,
      "MEDIA_MULTIPART_WORKER_LEASE_MS",
      60_000,
      10_000,
      10 * 60_000,
    ),
    heartbeatMs: readInteger(env, "MEDIA_MULTIPART_WORKER_HEARTBEAT_MS", 20_000, 1_000, 5 * 60_000),
    idleDelayMs: readInteger(env, "MEDIA_MULTIPART_WORKER_IDLE_DELAY_MS", 1_000, 100, 60_000),
  });
  const maintain = dependencies.maintainMediaObjects ?? defaultMaintainMediaObjects;
  return {
    kind: "media-multipart",
    runtime,
    run: async (signal) => {
      await maintain(objects);
      await runtime.run(signal);
    },
  };
}

export function buildGenerationRuntime(dependencies: AssemblyDependencies): WorkerRun {
  const { pool, workerId, env } = dependencies;
  const apiKey = required(env, "WEFTCANVAS_API_KEY");
  const resultHosts = list(env, "GENERATION_MEDIA_HOSTS");
  if (!resultHosts.length)
    throw new Error("GENERATION_MEDIA_HOSTS must list trusted result hostnames");
  const inspector = new DefaultMediaInspector();
  const objects = createMediaObjectStore(env);
  const maintain = dependencies.maintainMediaObjects ?? defaultMaintainMediaObjects;
  const media = new MediaService(new PostgresMediaMetadataStore(pool), objects, inspector);
  const signedAccess = signedMediaAccess(env);
  const references = new StoredGenerationReferenceResolver(media, {
    ...(signedAccess ? { signedAccess } : {}),
  });
  const staging = new JsonGenerationResultStagingStore(
    resolve(env.GENERATION_STAGING_PATH || ".data/generation-results"),
  );
  const provider = new WeftcanvasGenerationProvider({
    baseUrl: required(env, "WEFTCANVAS_API_BASE_URL"),
    apiKey,
    staging,
    references,
  });
  const materializer = new GenerationResultMaterializer({
    directory: resolve(env.GENERATION_DOWNLOAD_PATH || ".data/generation-downloads"),
    inspector,
    allowedHosts: resultHosts,
  });
  const jobs = new PostgresGenerationJobStore(pool);
  const artifacts = new ValidatedGenerationArtifactStore(
    staging,
    materializer,
    media,
    new StaticCloudProjectEntitlementResolver(),
  );
  const processor = new GenerationJobProcessor(jobs, provider, artifacts, {
    // Image tasks converge to a retryable timeout once they outlive the
    // budget; video keeps its unbounded (long-render) polling.
    imageLifetimeMs: readInteger(
      env,
      "GENERATION_IMAGE_MAX_LIFETIME_MS",
      10 * 60_000,
      60_000,
      60 * 60_000,
    ),
  });
  const queue = new PostgresGenerationWorkQueue(pool);
  const runtime = new GenerationWorkerRuntime(queue, processor, {
    owner: workerId,
    leaseDurationMs: readInteger(env, "WORKER_LEASE_MS", 60_000, 10_000, 10 * 60_000),
    heartbeatMs: readInteger(env, "WORKER_HEARTBEAT_MS", 20_000, 1_000, 5 * 60_000),
    idleDelayMs: readInteger(env, "WORKER_IDLE_DELAY_MS", 1_000, 100, 60_000),
  });
  const cleanup = dependencies.cleanupGenerationDownloads ?? cleanupGeneratedDownloads;
  const downloadsPath = resolve(env.GENERATION_DOWNLOAD_PATH || ".data/generation-downloads");
  const retentionMs = readInteger(
    env,
    "WORKER_TEMP_RETENTION_MS",
    24 * 60 * 60_000,
    60_000,
    30 * 24 * 60 * 60_000,
  );
  return {
    kind: "generation",
    runtime,
    run: async (signal) => {
      await maintain(objects);
      await cleanup(downloadsPath, retentionMs).catch((error) =>
        console.error("Generation download cleanup failed", error),
      );
      await runtime.run(signal);
    },
  };
}

const defaultMaintainMediaObjects = (objects: MediaObjectStore) =>
  maintainMediaObjectStore(objects).catch((error) =>
    console.error("Media temporary cleanup failed", error),
  );

function signedMediaAccess(env: NodeJS.ProcessEnv) {
  const secret = env.MEDIA_SIGNING_SECRET?.trim();
  const baseUrl = env.MEDIA_PUBLIC_BASE_URL?.trim();
  if (!secret && !baseUrl) return undefined;
  if (!secret || !baseUrl)
    throw new Error("MEDIA_SIGNING_SECRET and MEDIA_PUBLIC_BASE_URL must be configured together");
  return new SignedMediaAccess({
    secret,
    baseUrl,
    allowInsecureLocalhost: env.NODE_ENV !== "production",
  });
}

function required(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(env: NodeJS.ProcessEnv, name: string) {
  return (env[name] || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export async function cleanupGeneratedDownloads(directory: string, olderThanMs: number) {
  const cutoff = Date.now() - olderThanMs;
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/^[A-Za-z0-9_-]{8,128}\.media$/.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    const metadata = await lstat(path).catch(() => null);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile() || metadata.mtimeMs > cutoff)
      continue;
    await rm(path, { force: true });
    removed += 1;
  }
  return removed;
}
