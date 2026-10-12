import type { ModelModality } from "@weftcanvas/contracts";

/** The two parameter names used by compatible image APIs for output count. */
export const OUTPUT_COUNT_PARAMETER_NAMES = ["n", "count"] as const;

export class OutputCountError extends Error {
  constructor(
    readonly code: "INVALID_OUTPUT_COUNT" | "CONFLICTING_OUTPUT_COUNT" | "OUTPUT_COUNT_OVERFLOW",
    message: string,
  ) {
    super(message);
    this.name = "OutputCountError";
  }
}

/**
 * Reads the optional per-request output count. Catalog normalization normally
 * guarantees an integer, but providers also call this function on their own
 * boundary, so malformed values are rejected instead of being silently
 * coerced to one image.
 */
export function outputCountParameter(parameters: Record<string, unknown>): number {
  let selected: number | undefined;
  for (const name of OUTPUT_COUNT_PARAMETER_NAMES) {
    const value = parameters[name];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < 1) {
      throw new OutputCountError("INVALID_OUTPUT_COUNT", "Output count must be a positive integer");
    }
    if (selected !== undefined && selected !== value) {
      throw new OutputCountError(
        "CONFLICTING_OUTPUT_COUNT",
        "The n and count parameters must match",
      );
    }
    selected = value as number;
  }
  return selected ?? 1;
}

/**
 * Returns the number of outputs represented by one generation job. `quantity`
 * is retained as the repeat multiplier for backwards-compatible submissions;
 * image `n`/`count` is the per-request image count.
 */
export function totalOutputCount(
  modality: ModelModality,
  quantity: number,
  parameters: Record<string, unknown>,
): number {
  if (!Number.isSafeInteger(quantity) || quantity < 1) {
    throw new OutputCountError("INVALID_OUTPUT_COUNT", "Quantity must be a positive integer");
  }
  const multiplier = outputCountParameter(parameters);
  const total = quantity * multiplier;
  if (!Number.isSafeInteger(total) || total < 1) {
    throw new OutputCountError("OUTPUT_COUNT_OVERFLOW", "Output count is too large");
  }
  // Video APIs expose one task and one media result. A batch video request
  // cannot be represented by the current job/result contract.
  if (modality === "video" && total !== 1) {
    throw new OutputCountError(
      "INVALID_OUTPUT_COUNT",
      "Video generation supports exactly one output",
    );
  }
  return total;
}
