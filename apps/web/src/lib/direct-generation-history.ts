import { publicGenerationJobSchema, type PublicGenerationJob } from "@weftcanvas/contracts";

export type DirectGenerationModality = "image" | "video";

export type DirectGenerationHistory = Record<DirectGenerationModality, PublicGenerationJob[]>;

export const DIRECT_GENERATION_PROJECT_ID = "home-direct-generation";
export const DIRECT_GENERATION_NODE_IDS: Record<DirectGenerationModality, string> = {
  image: "home-direct-image",
  video: "home-direct-video",
};

const STORAGE_PREFIX = "weftcanvas:direct-generation:v1:";
const HIDDEN_ARTIFACTS_STORAGE_PREFIX = "weftcanvas:direct-generation:hidden-artifacts:v1:";
const STORAGE_SCHEMA_VERSION = 1;
const MAX_JOBS_PER_MODALITY = 40;
const MAX_HIDDEN_ARTIFACTS = 200;

export function emptyDirectGenerationHistory(): DirectGenerationHistory {
  return { image: [], video: [] };
}

export function readDirectGenerationHistory(userId: string): DirectGenerationHistory {
  if (typeof localStorage === "undefined") return emptyDirectGenerationHistory();
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(userId)) || "null") as {
      schemaVersion?: unknown;
      image?: unknown;
      video?: unknown;
    } | null;
    if (value?.schemaVersion !== STORAGE_SCHEMA_VERSION) return emptyDirectGenerationHistory();
    return {
      image: normalizeJobs(value.image, "image"),
      video: normalizeJobs(value.video, "video"),
    };
  } catch {
    return emptyDirectGenerationHistory();
  }
}

export function writeDirectGenerationHistory(userId: string, history: DirectGenerationHistory) {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(
      storageKey(userId),
      JSON.stringify({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        image: normalizeJobs(history.image, "image"),
        video: normalizeJobs(history.video, "video"),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function directGenerationArtifactKey(jobId: string, artifactId: string) {
  return `${jobId}:${artifactId}`;
}

export function readDirectGenerationHiddenArtifacts(userId: string) {
  if (typeof localStorage === "undefined") return new Set<string>();
  try {
    const value = JSON.parse(localStorage.getItem(hiddenArtifactsStorageKey(userId)) || "null") as {
      schemaVersion?: unknown;
      keys?: unknown;
    } | null;
    if (value?.schemaVersion !== STORAGE_SCHEMA_VERSION || !Array.isArray(value.keys))
      return new Set<string>();
    return new Set(
      value.keys
        .filter(
          (key): key is string => typeof key === "string" && key.length > 0 && key.length <= 512,
        )
        .slice(-MAX_HIDDEN_ARTIFACTS),
    );
  } catch {
    return new Set<string>();
  }
}

export function writeDirectGenerationHiddenArtifacts(userId: string, keys: ReadonlySet<string>) {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(
      hiddenArtifactsStorageKey(userId),
      JSON.stringify({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        keys: [...keys].slice(-MAX_HIDDEN_ARTIFACTS),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function mergeDirectGenerationJobs(
  local: DirectGenerationHistory,
  remote: readonly PublicGenerationJob[],
): DirectGenerationHistory {
  return {
    image: normalizeJobs(
      [...remote.filter((job) => job.modality === "image"), ...local.image],
      "image",
    ),
    video: normalizeJobs(
      [...remote.filter((job) => job.modality === "video"), ...local.video],
      "video",
    ),
  };
}

function normalizeJobs(value: unknown, modality: DirectGenerationModality) {
  if (!Array.isArray(value)) return [];
  const jobs = new Map<string, PublicGenerationJob>();
  for (const candidate of value) {
    const parsed = publicGenerationJobSchema.safeParse(candidate);
    if (!parsed.success) continue;
    const job = parsed.data;
    if (
      job.projectId !== DIRECT_GENERATION_PROJECT_ID ||
      job.nodeId !== DIRECT_GENERATION_NODE_IDS[modality] ||
      job.modality !== modality
    )
      continue;
    const current = jobs.get(job.id);
    if (!current || current.version < job.version) jobs.set(job.id, job);
  }
  return [...jobs.values()]
    .sort(
      (left, right) =>
        Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id),
    )
    .slice(0, MAX_JOBS_PER_MODALITY);
}

function storageKey(userId: string) {
  return `${STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}

function hiddenArtifactsStorageKey(userId: string) {
  return `${HIDDEN_ARTIFACTS_STORAGE_PREFIX}${encodeURIComponent(userId)}`;
}
