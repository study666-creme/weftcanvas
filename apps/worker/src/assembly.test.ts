import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GenerationWorkerRuntime,
  MediaMultipartWorkerRuntime,
} from "@kachang/canvas-api/worker";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  buildGenerationRuntime,
  buildMediaMultipartRuntime,
  buildWorkerRuntime,
  cleanupGeneratedDownloads,
  type AssemblyDependencies,
} from "./assembly.js";

const noopMaintain = async () => undefined;
const noopCleanup = async () => 0;

const fakePool = {
  query: async () => {
    throw new Error("no database expected in assembly tests");
  },
} as unknown as Pool;

const mediaEnvironment: Record<string, string> = {
  NODE_ENV: "production",
  MEDIA_STORAGE_DRIVER: "filesystem",
  MEDIA_STORAGE_PATH: join(tmpdir(), "canvas-worker-test-media-objects"),
  MEDIA_MULTIPART_WORKER_LEASE_MS: "60000",
  MEDIA_MULTIPART_WORKER_HEARTBEAT_MS: "20000",
  MEDIA_MULTIPART_WORKER_IDLE_DELAY_MS: "1000",
};

const generationEnvironment: Record<string, string> = {
  ...mediaEnvironment,
  KACHANG_API_KEY: "test-generation-key",
  GENERATION_MEDIA_HOSTS: "host.invalid",
  GENERATION_STAGING_PATH: join(tmpdir(), "canvas-worker-test-generation-results"),
  GENERATION_DOWNLOAD_PATH: join(tmpdir(), "canvas-worker-test-generation-downloads"),
};

function mediaDeps(env: Record<string, string> = mediaEnvironment): AssemblyDependencies {
  return { pool: fakePool, workerId: "test-media-worker", env, maintainMediaObjects: noopMaintain };
}

function generationDeps(env: Record<string, string> = generationEnvironment): AssemblyDependencies {
  return {
    ...mediaDeps(env),
    workerId: "test-generation-worker",
    cleanupGenerationDownloads: noopCleanup,
  };
}

describe("buildMediaMultipartRuntime", () => {
  it("needs no generation credentials or hosts", () => {
    const run = buildMediaMultipartRuntime(mediaDeps());
    expect(run.kind).toBe("media-multipart");
    expect(run.runtime).toBeInstanceOf(MediaMultipartWorkerRuntime);
  });

  it("selects MediaMultipartWorkerRuntime and no generation runtime", () => {
    const run = buildMediaMultipartRuntime(mediaDeps());
    expect(run.runtime).toBeInstanceOf(MediaMultipartWorkerRuntime);
    expect(run.runtime).not.toBeInstanceOf(GenerationWorkerRuntime);
  });

  it("ignores an otherwise-invalid generation configuration", () => {
    const env = {
      ...mediaEnvironment,
      KACHANG_API_KEY: "",
      GENERATION_MEDIA_HOSTS: "",
    };
    const run = buildMediaMultipartRuntime(mediaDeps(env));
    expect(run.kind).toBe("media-multipart");
    expect(run.runtime).toBeInstanceOf(MediaMultipartWorkerRuntime);
  });
});

describe("buildGenerationRuntime", () => {
  it("still requires generation configuration", () => {
    expect(() => buildGenerationRuntime(mediaDeps({}))).toThrow(/KACHANG_API_KEY is required/);
    expect(() => buildGenerationRuntime(mediaDeps({ KACHANG_API_KEY: "key" }))).toThrow(/GENERATION_MEDIA_HOSTS/);
    expect(() => buildGenerationRuntime(mediaDeps({
      KACHANG_API_KEY: "key",
      GENERATION_MEDIA_HOSTS: "",
    }))).toThrow(/GENERATION_MEDIA_HOSTS must list trusted result hostnames/);
  });

  it("constructs the generation runtime when configuration is present", () => {
    const run = buildGenerationRuntime(generationDeps());
    expect(run.kind).toBe("generation");
    expect(run.runtime).toBeInstanceOf(GenerationWorkerRuntime);
    expect(run.runtime).not.toBeInstanceOf(MediaMultipartWorkerRuntime);
  });
});

describe("buildWorkerRuntime", () => {
  it("routes media-only mode without ever building the generation runtime", () => {
    const run = buildWorkerRuntime(mediaDeps(), "media-multipart");
    expect(run.kind).toBe("media-multipart");
    expect(run.runtime).toBeInstanceOf(MediaMultipartWorkerRuntime);
    expect(run.runtime).not.toBeInstanceOf(GenerationWorkerRuntime);
  });

  it("routes generation mode to the generation runtime", () => {
    const run = buildWorkerRuntime(generationDeps(), "generation");
    expect(run.kind).toBe("generation");
    expect(run.runtime).toBeInstanceOf(GenerationWorkerRuntime);
  });
});

describe("cleanupGeneratedDownloads", () => {
  it("tolerates a missing directory", async () => {
    await expect(cleanupGeneratedDownloads(join(tmpdir(), "canvas-worker-test-missing-downloads"), 60_000))
      .resolves.toBe(0);
  });
});
