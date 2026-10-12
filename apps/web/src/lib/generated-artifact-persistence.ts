import type { CanvasMedia, GenerationArtifact, PublicGenerationJob } from "@weftcanvas/contracts";

import { ensureMediaAsset } from "./asset-library-store";
import { cacheServerMedia, readMedia } from "./media-store";

type GenerationMediaArtifact = Exclude<GenerationArtifact, { kind: "text" }>;

const artifactPersistenceRequests = new Map<string, Promise<void>>();
const artifactPersistenceQueue: Array<() => void> = [];
const MAX_CONCURRENT_ARTIFACT_WRITES = 2;
let activeArtifactPersistenceWrites = 0;

/**
 * Mirrors completed generated media into the browser cache and asset library.
 * Browser storage failures must not change the state of successful paid work.
 */
export function persistCompletedGenerationArtifacts(job: PublicGenerationJob) {
  if (job.status !== "completed") return Promise.resolve();
  return Promise.all(
    job.artifacts.flatMap((artifact) =>
      artifact.kind === "text" ? [] : [persistGenerationArtifact(job, artifact)],
    ),
  ).then(() => undefined);
}

export function mediaFromGenerationArtifact(artifact: GenerationMediaArtifact): CanvasMedia {
  return {
    id: artifact.mediaId,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    source: "server",
    serverId: artifact.mediaId,
    width: artifact.width ?? null,
    height: artifact.height ?? null,
    durationMs: artifact.duration ? Math.max(1, Math.round(artifact.duration * 1_000)) : null,
  };
}

function persistGenerationArtifact(job: PublicGenerationJob, artifact: GenerationMediaArtifact) {
  const existing = artifactPersistenceRequests.get(artifact.mediaId);
  if (existing) return existing;

  const media = mediaFromGenerationArtifact(artifact);
  const request = scheduleArtifactPersistence(async () => {
    const cachedForProject = await cacheServerMedia(media, job.projectId);
    const cached = cachedForProject || (await cacheServerMedia(media));
    if (!cached) throw new Error("Generated media could not be cached in the browser");
    const stored = await readMedia(media.id);
    if (!stored) throw new Error("Generated media could not be read from the browser cache");
    const cachedMedia: CanvasMedia = {
      id: stored.id,
      name: stored.name,
      mimeType: stored.mimeType,
      size: stored.blob.size,
      source: stored.source,
      serverId: stored.serverId,
      width: stored.width,
      height: stored.height,
      durationMs: stored.durationMs,
    };
    await ensureMediaAsset(cachedMedia, artifact.kind, "canvas");
  }).finally(() => {
    if (artifactPersistenceRequests.get(artifact.mediaId) === request) {
      artifactPersistenceRequests.delete(artifact.mediaId);
    }
  });
  artifactPersistenceRequests.set(artifact.mediaId, request);
  return request;
}

function scheduleArtifactPersistence(work: () => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    artifactPersistenceQueue.push(() => {
      activeArtifactPersistenceWrites += 1;
      void work()
        .then(resolve, reject)
        .finally(() => {
          activeArtifactPersistenceWrites -= 1;
          drainArtifactPersistenceQueue();
        });
    });
    drainArtifactPersistenceQueue();
  });
}

function drainArtifactPersistenceQueue() {
  while (activeArtifactPersistenceWrites < MAX_CONCURRENT_ARTIFACT_WRITES) {
    const run = artifactPersistenceQueue.shift();
    if (!run) return;
    run();
  }
}
