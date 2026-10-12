export type WorkerMode = "generation" | "media-multipart";

export function parseWorkerMode(environment: NodeJS.ProcessEnv): WorkerMode {
  const generationEnabled = booleanFlag(environment, "GENERATION_WORKER_ENABLED");
  const mediaMultipartEnabled = booleanFlag(environment, "MEDIA_MULTIPART_WORKER_ENABLED");
  if (generationEnabled && mediaMultipartEnabled) {
    throw new Error(
      "GENERATION_WORKER_ENABLED and MEDIA_MULTIPART_WORKER_ENABLED cannot both be enabled",
    );
  }
  if (!generationEnabled && !mediaMultipartEnabled) {
    throw new Error("GENERATION_WORKER_ENABLED or MEDIA_MULTIPART_WORKER_ENABLED must be enabled");
  }
  return mediaMultipartEnabled ? "media-multipart" : "generation";
}

function booleanFlag(environment: NodeJS.ProcessEnv, name: string) {
  const raw = environment[name]?.trim();
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}
