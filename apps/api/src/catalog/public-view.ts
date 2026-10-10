import type { PublicModelCatalog } from "@kachang/contracts";

const SUPERSEDED_MODEL_SETS = [
  {
    legacyId: "seedance-2.0",
    replacementIds: [
      "firefly-seedance2-480p",
      "firefly-seedance2-720p",
      "firefly-seedance2-1080p",
      "firefly-seedance2-fast-480p",
      "firefly-seedance2-fast-720p",
    ],
  },
  {
    legacyId: "seedance-2.0-431",
    replacementIds: [
      "sd2-431-720p-pro",
      "sd2-431-720p-fast",
    ],
  },
] as const;

/**
 * Hide legacy aggregate entries only after every fixed-route replacement is
 * available. The adapter keeps the full catalog so old projects can still
 * quote and execute the legacy model id during the compatibility window.
 */
export function toPublicCatalogView(catalog: PublicModelCatalog): PublicModelCatalog {
  const modelIds = new Set(catalog.models.map((model) => model.id));
  const hiddenIds = new Set<string>(
    SUPERSEDED_MODEL_SETS
      .filter(({ legacyId, replacementIds }) => (
        modelIds.has(legacyId) && replacementIds.every((id) => modelIds.has(id))
      ))
      .map(({ legacyId }) => legacyId),
  );
  if (!hiddenIds.size) return catalog;
  return {
    ...catalog,
    models: catalog.models.filter((model) => !hiddenIds.has(model.id)),
  };
}
