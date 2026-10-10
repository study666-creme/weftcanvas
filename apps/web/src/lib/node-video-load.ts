/**
 * Bounded video load deadlines for NodeVideoPlayer. A video whose metadata
 * never arrives (network hang) must settle to an explicit media-load failure
 * instead of a permanent spinner, while a delayed-but-arriving media still
 * displays. The metadata bound measures the wait for the first usable event
 * after the source changes; the ready bound measures the wait for playable
 * data once metadata has arrived.
 */
export const NODE_VIDEO_METADATA_TIMEOUT_MS = 12_000;
export const NODE_VIDEO_READY_TIMEOUT_MS = 45_000;

export type NodeVideoLoadStatus = "loading" | "ready" | "error";

export type NodeVideoLoadBoundInput = {
  status: Extract<NodeVideoLoadStatus, "loading">;
  /** Wall-clock time the current source started loading. */
  urlChangedAt: number;
  /** Wall-clock time `loadedmetadata` arrived, or null if it never did. */
  metadataAt: number | null;
  now: number;
  metadataTimeoutMs?: number;
  readyTimeoutMs?: number;
};

export function videoLoadDeadlineReached(input: NodeVideoLoadBoundInput): boolean {
  const metadataTimeoutMs = input.metadataTimeoutMs ?? NODE_VIDEO_METADATA_TIMEOUT_MS;
  const readyTimeoutMs = input.readyTimeoutMs ?? NODE_VIDEO_READY_TIMEOUT_MS;
  if (input.metadataAt === null) return input.now - input.urlChangedAt >= metadataTimeoutMs;
  return input.now - input.metadataAt >= readyTimeoutMs;
}

export function videoLoadRemainingMs(input: NodeVideoLoadBoundInput): number {
  const metadataTimeoutMs = input.metadataTimeoutMs ?? NODE_VIDEO_METADATA_TIMEOUT_MS;
  const readyTimeoutMs = input.readyTimeoutMs ?? NODE_VIDEO_READY_TIMEOUT_MS;
  const elapsed = input.metadataAt === null
    ? input.now - input.urlChangedAt
    : input.now - input.metadataAt;
  const deadlineMs = input.metadataAt === null ? metadataTimeoutMs : readyTimeoutMs;
  return Math.max(0, deadlineMs - elapsed);
}
