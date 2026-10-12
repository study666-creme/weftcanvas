/** Public and legacy H3 ids use a few separators and suffixes. */
export function isMinimaxH3Model(modelId: string) {
  return /^minimax[\s_-]*h3/iu.test(modelId.trim());
}

export function h3Resolution(parameters: Record<string, unknown>) {
  const value = parameters.resolution ?? parameters.size;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toUpperCase();
  return normalized === "2K" || normalized === "4K" ? normalized : undefined;
}

export function h3SuperResolutionRequiresImage(
  modelId: string,
  parameters: Record<string, unknown>,
) {
  return isMinimaxH3Model(modelId) && h3Resolution(parameters) !== undefined;
}
