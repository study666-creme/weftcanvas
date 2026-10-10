import type { SourceCatalog, SourceCatalogModel } from "./source-schema.js";

/**
 * The upstream catalog currently exposes Seedance as one tiered model.  The
 * execution API, however, has stable model IDs for each mode/resolution and
 * the public picker needs one price per card.  Keep this compatibility layer
 * at the source boundary so every downstream consumer (quotes, routes, and
 * workers) sees the same fixed model contract.
 */
export const SEEDANCE_SPLIT_SPECS = [
  { id: "firefly-seedance2-480p", label: "Seedance 2.0 Pro 480P", mode: "pro", resolution: "480p" },
  { id: "firefly-seedance2-720p", label: "Seedance 2.0 Pro 720P", mode: "pro", resolution: "720p" },
  { id: "firefly-seedance2-1080p", label: "Seedance 2.0 Pro 1080P", mode: "pro", resolution: "1080p" },
  { id: "firefly-seedance2-fast-480p", label: "Seedance 2.0 Fast 480P", mode: "fast", resolution: "480p" },
  { id: "firefly-seedance2-fast-720p", label: "Seedance 2.0 Fast 720P", mode: "fast", resolution: "720p" },
] as const;

const SEEDANCE_AGGREGATE_ID = "seedance-2.0";
const SEEDANCE_SPLIT_IDS: ReadonlySet<string> = new Set(SEEDANCE_SPLIT_SPECS.map((spec) => spec.id));

type SeedanceSpec = (typeof SEEDANCE_SPLIT_SPECS)[number];
type SourcePricing = SourceCatalogModel["pricing"];
type SourcePricingTier = NonNullable<SourcePricing["tiers"]>[number];

/**
 * Add fixed Seedance cards when the aggregate capability entry is present.
 * The function is deliberately all-or-nothing: a missing tier leaves the
 * upstream catalog untouched so we never publish a card that cannot be priced.
 */
export function applySeedanceSplitOverlay(source: SourceCatalog): SourceCatalog {
  const aggregate = source.models.find((model) => (
    model.id.trim().toLowerCase() === SEEDANCE_AGGREGATE_ID
    || model.public?.id.trim().toLowerCase() === SEEDANCE_AGGREGATE_ID
  ));
  if (!aggregate || aggregate.modality !== "video" || !aggregate.endpoint) return source;

  const existingById = new Map(
    source.models
      .filter((model) => SEEDANCE_SPLIT_IDS.has(model.id) || SEEDANCE_SPLIT_IDS.has(model.public?.id ?? ""))
      .flatMap((model) => [
        [model.id, model] as const,
        ...(model.public?.id ? [[model.public.id, model] as const] : []),
      ]),
  );
  const replacements = SEEDANCE_SPLIT_SPECS.map((spec, index) => buildSplitModel(
    existingById.get(spec.id),
    aggregate,
    spec,
    index,
  ));
  if (replacements.some((model, index): model is null => model === null || !isValidSplitSourceModel(model, SEEDANCE_SPLIT_SPECS[index]!))) return source;

  const replacementModels = replacements as SourceCatalogModel[];
  const models = [
    ...source.models.filter((model) => (
      !SEEDANCE_SPLIT_IDS.has(model.id)
      && !SEEDANCE_SPLIT_IDS.has(model.public?.id ?? "")
    )),
    ...replacementModels,
  ];
  return { ...source, models };
}

function isValidSplitSourceModel(model: SourceCatalogModel, spec: SeedanceSpec) {
  const modelParameter = model.parameters.find((parameter) => parameter.name.trim().toLowerCase() === "model");
  const resolutionParameter = model.parameters.find((parameter) => parameter.name.trim().toLowerCase() === "resolution");
  return model.id === spec.id
    && model.public?.id === spec.id
    && model.modality === "video"
    && model.endpoint?.method === "POST"
    && model.endpoint.path === "/v1/videos"
    && model.pricing.mode === "fixed"
    && model.pricing.unit === "second"
    && isFiniteNonNegative(model.pricing.yuan)
    && modelParameter?.fixed === spec.id
    && resolutionParameter?.fixed === spec.resolution
    && !model.parameters.some((parameter) => parameter.name.trim().toLowerCase() === "mode");
}

/**
 * 上游偶尔把裸 id 当展示名发布（"doubao-seedance-2.0"、"gemini-3.8-flash"），
 * 挑选器里就是一串技术名。只有在上游 label 仍然是裸 ASCII id 时才按 id 派生
 * 一个友好名（厂商前缀去掉、连字符转空格、单词首字母大写）；上游给了人类可读
 * 的 label 时一律以上游为准，含中文的技术名（S-2.0-933-线路六之类）不动。
 */
export function applyRawIdLabels(source: SourceCatalog): SourceCatalog {
  let touched = false;
  const models = source.models.map((model) => {
    const publicId = model.public?.id?.trim() ?? "";
    if (!model.public || !publicId || !isBareSlug(publicId)) return model;
    const label = model.public.label?.trim() ?? "";
    // label 与 id 不同且不是裸 slug时，认为上游是有意给的展示名。
    if (label && label !== publicId && !isBareSlug(label)) return model;
    const friendly = friendlyLabelFromId(publicId);
    if (!friendly || friendly === label) return model;
    touched = true;
    return { ...model, public: { ...model.public, label: friendly } };
  });
  return touched ? { ...source, models } : source;
}

function isBareSlug(value: string) {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(value);
}

function friendlyLabelFromId(id: string): string | null {
  const stripped = id.trim().replace(/^doubao-/i, "").replace(/^firefox-/i, "").replace(/[-_]+/g, " ");
  if (!stripped) return null;
  return stripped
    .split(" ")
    .filter(Boolean)
    .map((word) => (word === word.toUpperCase() && word.length <= 4 ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

function buildSplitModel(
  existing: SourceCatalogModel | undefined,
  aggregate: SourceCatalogModel,
  spec: SeedanceSpec,
  index: number,
): SourceCatalogModel | null {
  const template = existing ?? aggregate;
  const pricing = fixedPricingFromExisting(existing?.pricing)
    ?? fixedPricingFromTier(existing?.pricing, spec)
    ?? fixedPricingFromTier(aggregate.pricing, spec);
  if (!pricing) return null;

  // Direct upstream cards are authoritative for their public presentation.
  // Only synthesized fallback cards receive the compatibility text below.
  const label = nonEmptyText(existing?.public?.label) ?? spec.label;
  const description = nonEmptyText(existing?.public?.description)
    ?? `${spec.label}. Fixed model ID for ${spec.mode} mode and ${spec.resolution}; no mode selector is required.`;
  return {
    ...template,
    id: spec.id,
    order: typeof aggregate.order === "number" && Number.isFinite(aggregate.order)
      ? aggregate.order + ((index + 1) / 1000)
      : 45 + index,
    selectable: true,
    parameters: fixedParameters(template.parameters, spec),
    pricing,
    tags: fixedTags(template.tags, spec),
    public: {
      ...(template.public ?? {}),
      id: spec.id,
      label,
      description,
    },
  };
}

function nonEmptyText(value: unknown) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text || null;
}

function fixedParameters(parameters: SourceCatalogModel["parameters"], spec: SeedanceSpec) {
  const result: SourceCatalogModel["parameters"] = [];
  let hasModel = false;
  let hasResolution = false;

  for (const parameter of parameters) {
    const name = parameter.name.trim().toLowerCase();
    if (name === "mode") continue;
    const fixed = { ...parameter };
    if (name === "model") {
      fixed.name = "model";
      fixed.path = fixed.path ?? "model";
      fixed.fixed = spec.id;
      delete fixed.default;
      delete fixed.options;
      hasModel = true;
    } else if (name === "resolution") {
      fixed.name = "resolution";
      fixed.path = fixed.path ?? "resolution";
      fixed.fixed = spec.resolution;
      delete fixed.default;
      delete fixed.options;
      fixed.mutually_exclusive_with = fixed.mutually_exclusive_with?.filter((name) => name.trim().toLowerCase() !== "mode");
      hasResolution = true;
    }
    result.push(fixed);
  }

  if (!hasModel) {
    result.unshift({
      name: "model",
      path: "model",
      label: "Model",
      type: "string",
      required: true,
      fixed: spec.id,
    });
  }
  if (!hasResolution) {
    result.push({
      name: "resolution",
      path: "resolution",
      label: "Resolution",
      type: "string",
      required: false,
      fixed: spec.resolution,
    });
  }
  return result;
}

function fixedPricingFromExisting(pricing: SourcePricing | undefined): SourcePricing | null {
  if (!pricing || pricing.mode !== "fixed" || pricing.unit !== "second" || !isFiniteNonNegative(pricing.yuan)) return null;
  const { tiers: _tiers, groups: _groups, ...base } = pricing;
  return {
    ...base,
    mode: "fixed",
    unit: "second",
    yuan: pricing.yuan,
    credits: isFiniteNonNegative(pricing.credits)
      ? pricing.credits
      : pricing.yuan * (pricing.credits_per_yuan ?? 100),
    quantity_parameter: "duration",
  };
}

function fixedPricingFromTier(pricing: SourcePricing | undefined, spec: SeedanceSpec): SourcePricing | null {
  if (!pricing) return null;
  const tier = matchingTier(pricing.tiers, spec)
    ?? matchingGroupTier(pricing.groups, spec);
  if (!tier) return null;

  const { tiers: _tiers, groups: _groups, ...base } = pricing;
  return {
    ...base,
    mode: "fixed",
    unit: "second",
    yuan: Number(tier.yuan),
    credits: Number(tier.credits),
    quantity_parameter: "duration",
  };
}

function matchingTier(tiers: SourcePricing["tiers"], spec: SeedanceSpec): SourcePricingTier | null {
  const matches = (tiers ?? []).filter((tier) => tierMatches(tier, spec));
  return matches.length === 1 && isConditionalTier(matches[0]) ? matches[0] : null;
}

function matchingGroupTier(groups: SourcePricing["groups"], spec: SeedanceSpec): SourcePricingTier | null {
  const matches = (groups ?? []).flatMap((group) => (group.tiers ?? []).filter((tier) => tierMatches(tier, spec)));
  return matches.length === 1 && isConditionalTier(matches[0]) ? matches[0] : null;
}

function tierMatches(tier: SourcePricingTier, spec: SeedanceSpec) {
  if (!isConditionalTier(tier)) return false;
  const mode = String(tier.when.mode ?? "").trim().toLowerCase();
  const resolution = String(tier.when.resolution ?? "").trim().toLowerCase();
  if (mode || resolution) return mode === spec.mode && resolution === spec.resolution;
  const name = String((tier as { name?: unknown }).name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return name.includes(spec.mode) && name.includes(spec.resolution);
}

function isConditionalTier(tier: SourcePricingTier | undefined): tier is Extract<SourcePricingTier, { when: Record<string, string | number | boolean> }> {
  return Boolean(tier && "when" in tier && tier.when && typeof tier.when === "object");
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function fixedTags(value: unknown, spec: SeedanceSpec) {
  const tags = new Set(
    String(value ?? "")
      .split(",")
      .map((tag) => tag.trim().toLowerCase())
      .filter(Boolean)
      .filter((tag) => !["pro", "fast", "480p", "720p", "1080p"].includes(tag)),
  );
  tags.add("video");
  tags.add("sd-video");
  tags.add("text-to-video");
  tags.add("multi-reference");
  tags.add("per-second");
  tags.add(spec.mode);
  tags.add(spec.resolution);
  return [...tags].join(",");
}
