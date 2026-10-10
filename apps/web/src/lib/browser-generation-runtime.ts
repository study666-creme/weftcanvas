const activeGenerationIds = new Set<string>();
const activeSubmissions = new Set<string>();

export function beginBrowserGeneration(jobId: string) {
  activeGenerationIds.add(jobId);
}

export function endBrowserGeneration(jobId: string) {
  activeGenerationIds.delete(jobId);
}

export function isBrowserGenerationActive(jobId: string) {
  return activeGenerationIds.has(jobId);
}

/**
 * Tracks a node whose optimistic hosted submission is still in flight in this
 * browser session. Project recovery must not treat such a node as stale: the
 * submission may still be accepted by the server, and the accepted job will
 * resume observation once it appears in the recovery list.
 */
export function beginBrowserSubmission(nodeId: string) {
  activeSubmissions.add(nodeId);
}

export function endBrowserSubmission(nodeId: string) {
  activeSubmissions.delete(nodeId);
}

export function isBrowserSubmissionInFlight(nodeId: string) {
  return activeSubmissions.has(nodeId);
}

/**
 * Durable pending hosted-submission identity for a canvas node.
 *
 * Only the public client request identity is recorded: a random opaque
 * idempotency key and its local creation time. Credentials, signed URLs,
 * private media, raw uploads, and provider secrets never enter this store.
 * The identity is preserved across a reload and released only when the
 * original request is authoritatively resolved (a genuinely new submission
 * on a settled node, a definitive server failure is received, or the user
 * explicitly abandons it).
 */
const PENDING_SUBMISSION_STORAGE_KEY = "kachang-canvas:pending-generation-requests:v1";

/**
 * Defensive bound on the durable identity map. Identities are released when
 * their request is authoritatively resolved or the user abandons, but a
 * node/project deleted while a submission is pending would otherwise leave a
 * tiny record behind forever. The cap keeps localStorage bounded without ever
 * touching the most recent identities, so the core "no fresh submit until
 * resolution or abandon" invariant is preserved.
 */
const PENDING_SUBMISSION_MAX_ENTRIES = 2_000;
const PENDING_SUBMISSION_MAX_KEY_LENGTH = 256;
const PENDING_SUBMISSION_MAX_SCOPED_KEY_LENGTH = 512;
// Allow a day of clock skew so a legitimate write made just before a local
// clock step is never mistaken for a garbage future timestamp.
const PENDING_SUBMISSION_MAX_CREATED_AT_SKEW_MS = 24 * 60 * 60 * 1000;
const PENDING_SUBMISSION_CONTROL_CHARACTER = /[\u0000-\u001F\u007F-\u009F]/;

export type PendingBrowserSubmissionIdentity = {
  key: string;
  createdAt: number;
};

let pendingSubmissionCache: Map<string, PendingBrowserSubmissionIdentity> | null = null;

function isSafePendingKey(key: string) {
  return key.length > 0 && key.length <= PENDING_SUBMISSION_MAX_KEY_LENGTH;
}

function isSafePendingScopedKey(scopedKey: string) {
  return scopedKey.length > 0
    && scopedKey.length <= PENDING_SUBMISSION_MAX_SCOPED_KEY_LENGTH
    && !PENDING_SUBMISSION_CONTROL_CHARACTER.test(scopedKey);
}

function pendingSubmissionMap() {
  if (pendingSubmissionCache) return pendingSubmissionCache;
  const entries = new Map<string, PendingBrowserSubmissionIdentity>();
  try {
    if (typeof localStorage === "undefined") {
      pendingSubmissionCache = entries;
      return entries;
    }
    const stored = localStorage.getItem(PENDING_SUBMISSION_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        pendingSubmissionCache = entries;
        return entries;
      }
      const now = Date.now();
      for (const [scopedKey, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (entries.size >= PENDING_SUBMISSION_MAX_ENTRIES) break;
        if (!isSafePendingScopedKey(scopedKey)) continue;
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        if (typeof record.key !== "string" || !isSafePendingKey(record.key)) continue;
        const createdAt = record.createdAt;
        if (typeof createdAt !== "number"
          || !Number.isFinite(createdAt)
          || createdAt < 0
          || createdAt > now + PENDING_SUBMISSION_MAX_CREATED_AT_SKEW_MS) continue;
        entries.set(scopedKey, { key: record.key, createdAt });
      }
    }
  } catch {
    // Private browsing or malformed storage must never block generation.
  }
  pendingSubmissionCache = entries;
  return entries;
}

function writePendingSubmissionMap(entries: Map<string, PendingBrowserSubmissionIdentity>) {
  try {
    if (typeof localStorage === "undefined") return;
    if (entries.size > PENDING_SUBMISSION_MAX_ENTRIES) {
      const ordered = [...entries.entries()].sort((left, right) => left[1].createdAt - right[1].createdAt);
      const excess = ordered.length - PENDING_SUBMISSION_MAX_ENTRIES;
      for (let index = 0; index < excess; index += 1) entries.delete(ordered[index]![0]);
    }
    localStorage.setItem(PENDING_SUBMISSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // The in-memory map still carries the identity for this session.
  }
}

function pendingSubmissionScopedKey(projectId: string, nodeId: string) {
  return `${projectId}:${nodeId}`;
}

export function persistBrowserSubmissionIdentity(projectId: string, nodeId: string, key: string) {
  const entries = pendingSubmissionMap();
  entries.set(pendingSubmissionScopedKey(projectId, nodeId), { key, createdAt: Date.now() });
  writePendingSubmissionMap(entries);
}

export function releaseBrowserSubmissionIdentity(projectId: string, nodeId: string) {
  const entries = pendingSubmissionMap();
  if (!entries.delete(pendingSubmissionScopedKey(projectId, nodeId))) return;
  writePendingSubmissionMap(entries);
}

export function browserSubmissionIdentity(projectId: string, nodeId: string): PendingBrowserSubmissionIdentity | null {
  return pendingSubmissionMap().get(pendingSubmissionScopedKey(projectId, nodeId)) ?? null;
}

/**
 * Decides whether an existing durable pending identity belongs to the same
 * ambiguous logical request and must be reused. Only a node already inside the
 * ambiguous window (submitting or submission_unknown) BEFORE a new action
 * reuses its key; an otherwise settled node always mints a fresh key.
 */
export function isAmbiguousSubmissionStatus(nodeJobStatus: string | null): boolean {
  return nodeJobStatus === "submitting" || nodeJobStatus === "submission_unknown";
}

/**
 * Picks the idempotency identity for a new hosted submission. While the node
 * is still inside the ambiguous window (submitting or submission_unknown), a
 * durable pending identity is reused so the exact same logical request is
 * retried and the server cannot create a second paid task. Once that window is
 * over a stale identity is released and a fresh key is minted for a genuinely
 * new submission.
 *
 * The caller must pass the node's PRE-submit status (captured before any
 * optimistic "submitting" update) so the reuse decision reflects the state the
 * action started from, never the state the submit flow forces.
 */
export function resolvePendingSubmissionIdentity(
  projectId: string,
  nodeId: string,
  nodeJobStatus: string | null,
  createKey: () => string,
): { key: string; reused: boolean } {
  const pending = browserSubmissionIdentity(projectId, nodeId);
  if (pending && isAmbiguousSubmissionStatus(nodeJobStatus)) {
    return { key: pending.key, reused: true };
  }
  if (pending) releaseBrowserSubmissionIdentity(projectId, nodeId);
  const key = createKey();
  persistBrowserSubmissionIdentity(projectId, nodeId, key);
  return { key, reused: false };
}
