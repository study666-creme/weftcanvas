import { useEffect, useRef, useState } from "react";

/**
 * A running generation job whose upstream status and progress stay frozen for
 * a long time (for example gpt-image-2-ext reporting running/48) must not be
 * displayed as an ordinary "generating" state forever. These helpers give the
 * node surface an explicit, read-only stalled semantic without changing the
 * public job contract or creating any second POST, reservation, or artifact.
 */

export const GENERATION_STALL_THRESHOLD_MS = 3 * 60_000;
export const GENERATION_STALL_RECHECK_MS = 15_000;

export function isAdvancingGenerationStatus(status: string | null | undefined) {
  return (
    status === "reserved" ||
    status === "submitting" ||
    status === "queued" ||
    status === "running" ||
    status === "validating" ||
    status === "submission_unknown"
  );
}

export function isGenerationStalled(options: {
  status: string | null | undefined;
  lastProgressChangeAt: number;
  now: number;
  thresholdMs?: number;
}) {
  return (
    isAdvancingGenerationStatus(options.status) &&
    options.now - options.lastProgressChangeAt >=
      (options.thresholdMs ?? GENERATION_STALL_THRESHOLD_MS)
  );
}

export function useGenerationStall(options: {
  jobId: string | null;
  jobVersion: number | null;
  status: string | null;
  now?: () => number;
  thresholdMs?: number;
}): boolean {
  const { jobId, jobVersion, status } = options;
  const thresholdMs = options.thresholdMs ?? GENERATION_STALL_THRESHOLD_MS;
  const nowRef = useRef(options.now ?? (() => Date.now()));
  nowRef.current = options.now ?? nowRef.current;

  const signature = `${jobId ?? ""}:${jobVersion ?? ""}`;
  const signatureRef = useRef(signature);
  const lastChangeAtRef = useRef(nowRef.current());
  const [, setTick] = useState(0);

  // A new job or a new public version resets the "last change" marker.
  if (signature !== signatureRef.current) {
    signatureRef.current = signature;
    lastChangeAtRef.current = nowRef.current();
  }

  const active = isAdvancingGenerationStatus(status);

  useEffect(() => {
    // Keep recomputing even while no new job snapshot arrives, so a frozen
    // running task visibly crosses into the stalled state on its own.
    if (!active) return;
    const timer = setInterval(() => setTick((value) => value + 1), GENERATION_STALL_RECHECK_MS);
    return () => clearInterval(timer);
  }, [active]);

  return isGenerationStalled({
    status,
    lastProgressChangeAt: lastChangeAtRef.current,
    now: nowRef.current(),
    thresholdMs,
  });
}
