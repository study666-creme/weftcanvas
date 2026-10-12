import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  modelPricingSchema,
  modelZoneSchema,
  type ModelPricing,
  type PublicModelCatalog,
} from "@weftcanvas/contracts";
import { z } from "zod";

/**
 * Operator overrides for the published model catalog.
 *
 * The upstream Weftcanvas catalog is the pricing authority, but its per-model
 * price can lag the billing group a model actually runs on (for example a
 * 香蕉 2/Pro line whose group standard price differs from the published
 * top-level price). This store lets an operator hide a model from new
 * generations and set an explicit retail price without redeploying or waiting
 * for an upstream catalog change.
 *
 * Overrides are applied when the catalog is read, never persisted into the
 * cached upstream snapshot, so clearing an override immediately restores the
 * source price. Only the override store can write here; nothing in the normal
 * generation path does.
 */
const modelPriceOverrideSchema = z
  .object({
    /** Flat retail price in CNY, applied to every resolution. */
    yuan: z.number().nonnegative().optional(),
    /** Per-resolution retail price in CNY; each key is a `resolution` value. */
    byResolution: z.record(z.string().min(1), z.number().nonnegative()).optional(),
    /** Token 模型零售价（元 / 百万 token）：分别覆盖输入与输出费率。 */
    inputYuanPerMillion: z.number().nonnegative().optional(),
    outputYuanPerMillion: z.number().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.yuan !== undefined ||
      (value.byResolution !== undefined && Object.keys(value.byResolution).length > 0) ||
      value.inputYuanPerMillion !== undefined ||
      value.outputYuanPerMillion !== undefined,
    { message: "price override requires yuan, byResolution, or token rates" },
  );

export const modelOverrideSchema = z
  .object({
    hidden: z.boolean().optional(),
    sortOrder: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
    price: modelPriceOverrideSchema.optional(),
    /**
     * 站内展示名（改名）：覆盖上游 label。用于合规运营（对外不出现未备案的
     * 境外模型名）；只改展示与文案，路由/计费仍用真实模型 id。
     */
    displayName: z.string().min(1).max(60).optional(),
    /** 站内展示简介：覆盖上游 description，同样只影响文案。 */
    description: z.string().max(400).optional(),
    /** 运营分区：stable（默认，主推稳定区）/ promo（特惠引流区，不承诺可用性）。 */
    zone: modelZoneSchema.optional(),
  })
  .strict();

export const modelOverridesSchema = z
  .object({
    models: z.record(z.string().min(1), modelOverrideSchema).default({}),
  })
  .strict();

export type ModelPriceOverride = z.infer<typeof modelPriceOverrideSchema>;
export type ModelOverride = z.infer<typeof modelOverrideSchema>;
export type ModelOverrides = z.infer<typeof modelOverridesSchema>;

export const EMPTY_MODEL_OVERRIDES: ModelOverrides = { models: {} };

export interface ModelOverrideStore {
  load(): Promise<ModelOverrides>;
  save(overrides: ModelOverrides): Promise<void>;
}

/** File-backed store with an in-process cache; the admin route is the only writer. */
export class JsonModelOverrideStore implements ModelOverrideStore {
  private cache: ModelOverrides | null = null;

  constructor(private readonly filePath: string) {}

  async load() {
    if (this.cache) return this.cache;
    try {
      this.cache = modelOverridesSchema.parse(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      this.cache = { models: {} };
    }
    return this.cache;
  }

  async save(overrides: ModelOverrides) {
    const parsed = modelOverridesSchema.parse(overrides);
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(parsed, null, 2), "utf8");
    await rename(temporary, this.filePath);
    this.cache = parsed;
  }
}

export class MemoryModelOverrideStore implements ModelOverrideStore {
  private value: ModelOverrides;

  constructor(initial: ModelOverrides = { models: {} }) {
    this.value = structuredClone(modelOverridesSchema.parse(initial));
  }

  async load() {
    return structuredClone(this.value);
  }

  async save(overrides: ModelOverrides) {
    this.value = structuredClone(modelOverridesSchema.parse(overrides));
  }
}

export function applyModelOverrides(
  catalog: PublicModelCatalog,
  overrides: ModelOverrides,
): PublicModelCatalog {
  const entries = overrides.models;
  if (!Object.keys(entries).length) return catalog;

  let pricingChanged = false;
  const models = catalog.models
    .filter((model) => entries[model.id]?.hidden !== true)
    .map((model) => {
      const override = entries[model.id];
      if (!override) return model;
      let next = model;
      if (override.sortOrder !== undefined) next = { ...next, order: override.sortOrder };
      if (override.displayName !== undefined || override.description !== undefined) {
        next = {
          ...next,
          ...(override.displayName !== undefined ? { label: override.displayName } : {}),
          ...(override.description !== undefined ? { description: override.description } : {}),
        };
      }
      if (override.zone !== undefined) next = { ...next, zone: override.zone };
      if (override.price) {
        const hasTokenRates =
          override.price.inputYuanPerMillion !== undefined ||
          override.price.outputYuanPerMillion !== undefined;
        const hasRequestPrice =
          override.price.yuan !== undefined ||
          (override.price.byResolution !== undefined &&
            Object.keys(override.price.byResolution).length > 0);
        if (next.pricing.mode === "token") {
          if (hasTokenRates) {
            next = { ...next, pricing: applyTokenPriceOverride(next.pricing, override.price) };
            pricingChanged = true;
          }
        } else if (hasRequestPrice) {
          next = { ...next, pricing: applyPriceOverride(next.pricing, override.price) };
          pricingChanged = true;
        }
      }
      return next;
    });
  models.sort(
    (left, right) => left.order - right.order || left.label.localeCompare(right.label, "zh-CN"),
  );

  return {
    ...catalog,
    models,
    ...(pricingChanged ? { pricingVersion: overriddenPricingVersion(overrides) } : {}),
  };
}

function applyTokenPriceOverride(
  pricing: ModelPricing,
  override: ModelPriceOverride,
): ModelPricing {
  const creditsPerYuan = pricing.creditsPerYuan;
  const toYuanMicros = (yuan: number) => Math.round(yuan * 1_000_000);
  const toCreditMicros = (yuan: number) => Math.round(yuan * creditsPerYuan * 1_000_000);
  const input = override.inputYuanPerMillion;
  const output = override.outputYuanPerMillion;
  return modelPricingSchema.parse({
    ...pricing,
    mode: "token",
    unit: "token",
    currency: "CNY",
    ...(input !== undefined
      ? {
          inputYuanMicrosPerMillion: toYuanMicros(input),
          inputCreditMicrosPerMillion: toCreditMicros(input),
        }
      : {}),
    ...(output !== undefined
      ? {
          outputYuanMicrosPerMillion: toYuanMicros(output),
          outputCreditMicrosPerMillion: toCreditMicros(output),
        }
      : {}),
  });
}

function applyPriceOverride(pricing: ModelPricing, override: ModelPriceOverride): ModelPricing {
  const creditsPerYuan = pricing.creditsPerYuan;
  const toYuanMicros = (yuan: number) => Math.round(yuan * 1_000_000);
  const toCreditMicros = (yuan: number) => Math.round(yuan * creditsPerYuan * 1_000_000);
  // Token models price by rate, not by request; keep their per-million fields
  // intact so a request-price override never breaks token quoting.
  const tokenFields = {
    ...(pricing.inputCreditMicrosPerMillion !== undefined
      ? { inputCreditMicrosPerMillion: pricing.inputCreditMicrosPerMillion }
      : {}),
    ...(pricing.outputCreditMicrosPerMillion !== undefined
      ? { outputCreditMicrosPerMillion: pricing.outputCreditMicrosPerMillion }
      : {}),
    ...(pricing.inputYuanMicrosPerMillion !== undefined
      ? { inputYuanMicrosPerMillion: pricing.inputYuanMicrosPerMillion }
      : {}),
    ...(pricing.outputYuanMicrosPerMillion !== undefined
      ? { outputYuanMicrosPerMillion: pricing.outputYuanMicrosPerMillion }
      : {}),
  };

  if (override.byResolution && Object.keys(override.byResolution).length) {
    const tiers = Object.entries(override.byResolution).map(([resolution, yuan]) => ({
      when: { resolution },
      yuanMicros: toYuanMicros(yuan),
      creditMicros: toCreditMicros(yuan),
    }));
    const base = tiers[0]!;
    return modelPricingSchema.parse({
      mode: "tiered",
      unit: pricing.unit,
      currency: "CNY",
      creditsPerYuan,
      baseYuanMicros: base.yuanMicros,
      baseCreditMicros: base.creditMicros,
      tiers,
      ...tokenFields,
    });
  }

  const yuan = override.yuan ?? 0;
  return modelPricingSchema.parse({
    mode: "fixed",
    unit: pricing.unit,
    currency: "CNY",
    creditsPerYuan,
    baseYuanMicros: toYuanMicros(yuan),
    baseCreditMicros: toCreditMicros(yuan),
    tiers: [],
    ...tokenFields,
  });
}

/**
 * A price override changes what a quote must reserve, so the catalog's
 * pricing version has to rotate with it. Visibility and sort edits do not
 * touch price and therefore keep the upstream version so unrelated quotes
 * stay valid.
 */
function overriddenPricingVersion(overrides: ModelOverrides) {
  const priceContent = Object.entries(overrides.models)
    .filter(([, value]) => value.price !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const digest = createHash("sha256")
    .update(JSON.stringify(priceContent))
    .digest("hex")
    .slice(0, 16);
  return `overrides:${digest}`;
}
