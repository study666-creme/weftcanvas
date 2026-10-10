import { resolve } from "node:path";

import { FilesystemMediaObjectStore } from "./filesystem-object-store.js";
import { S3MediaObjectStore } from "./s3-object-store.js";
import type { MediaObjectStore } from "./types.js";
import { supportsMediaStoreMaintenance } from "./types.js";

export function createMediaObjectStore(environment: NodeJS.ProcessEnv = process.env): MediaObjectStore {
  const driver = environment.MEDIA_STORAGE_DRIVER?.trim().toLowerCase() || "filesystem";
  if (driver === "filesystem") {
    return new FilesystemMediaObjectStore(resolve(environment.MEDIA_STORAGE_PATH || ".data/media-objects"));
  }
  if (driver !== "s3") throw new Error("MEDIA_STORAGE_DRIVER must be filesystem or s3");
  return new S3MediaObjectStore({
    bucket: required(environment, "S3_BUCKET"),
    region: required(environment, "S3_REGION"),
    endpoint: optional(environment, "S3_ENDPOINT"),
    accessKeyId: optional(environment, "S3_ACCESS_KEY_ID"),
    secretAccessKey: optional(environment, "S3_SECRET_ACCESS_KEY"),
    forcePathStyle: optionalBoolean(environment, "S3_FORCE_PATH_STYLE"),
    keyPrefix: optional(environment, "S3_KEY_PREFIX"),
    keyDerivationSecret: required(environment, "S3_KEY_DERIVATION_SECRET"),
    temporaryDirectory: optional(environment, "S3_TEMP_PATH"),
    uploadTtlSeconds: optionalInteger(environment, "S3_UPLOAD_TTL_SECONDS", 60, 60 * 60),
    downloadTtlSeconds: optionalInteger(environment, "S3_DOWNLOAD_TTL_SECONDS", 30, 60 * 60),
    maxMaterializedBytes: optionalInteger(environment, "S3_MAX_MATERIALIZED_BYTES", 1, Number.MAX_SAFE_INTEGER),
    // 存储成片不可达时快速失败：故障期间避免每个请求各等满一次连接超时。
    // 阈值设得足够高即等于关闭该行为。
    transportFailureThreshold: optionalInteger(environment, "S3_TRANSPORT_FAILURE_THRESHOLD", 1, 100),
    transportFailureCooldownMs: optionalSeconds(
      environment,
      "S3_TRANSPORT_FAILURE_COOLDOWN_SECONDS",
      1,
      10 * 60,
    ),
  });
}

export async function maintainMediaObjectStore(store: MediaObjectStore, olderThanMs = 24 * 60 * 60_000) {
  if (!supportsMediaStoreMaintenance(store)) return 0;
  return store.cleanupTemporaryFiles(olderThanMs);
}

function required(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when MEDIA_STORAGE_DRIVER=s3`);
  return value;
}

function optional(environment: NodeJS.ProcessEnv, name: string) {
  const value = environment[name]?.trim();
  return value || undefined;
}

function optionalBoolean(environment: NodeJS.ProcessEnv, name: string) {
  const value = optional(environment, name);
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function optionalInteger(environment: NodeJS.ProcessEnv, name: string, min: number, max: number) {
  const value = optional(environment, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

/** 运维习惯用秒表述等待时间，这里显式换算成毫秒后交给存储层。 */
function optionalSeconds(environment: NodeJS.ProcessEnv, name: string, min: number, max: number) {
  const seconds = optionalInteger(environment, name, min, max);
  return seconds === undefined ? undefined : seconds * 1_000;
}
