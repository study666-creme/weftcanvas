import type { PublicModel } from "@weftcanvas/contracts";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";

import { isCustomModelKey } from "../lib/custom-api";
import { modelPriceLabel, modelPickerLabel } from "./generation-model-select";

/** 运营分区：稳定主推（缺省）/ 特惠引流。 */
export function isPromoZoneModel(model: PublicModel) {
  return model.zone === "promo";
}

/** 分类内稳定区与特惠区的分界声明。 */
export const PROMO_MODEL_NOTICE = "以下为特惠模型：随时可能下架或不可用，可用时也不保证成功率";

/** 分区内排序：稳定模型在上、特惠模型贴底（每个分类 tab 内部同序）。 */
export function partitionModelsByZone(models: PublicModel[]): PublicModel[] {
  const stable = models.filter((model) => !isPromoZoneModel(model));
  const promo = models.filter((model) => isPromoZoneModel(model));
  return promo.length ? [...stable, ...promo] : models;
}

type Category = {
  id: string;
  label: string;
  match: (model: PublicModel) => boolean;
};

/**
 * Category rules copied from the operations console model square.
 * - Image models: 香蕉 / 全能模型2 / 全能模型2.5 / Midjourney / Seedream / 其他.
 *   The console splits the 全能模型 line into its 2 and 2.5 generations, so the
 *   picker does the same instead of hiding both under one "全能模型2" tab.
 * - Video models: S-family is split into 2.0 / 2.0fast / 2.0mini (no umbrella
 *   "S模型" tab); other series use their vendor names: Minimax / 可灵 / Veo /
 *   Runway / Wan / Seedance; leftovers go to 其他.
 * No "全部" tab — users pick by subcategory only.
 */
const VIDEO_CATEGORY_RULES: {
  id: string;
  label: string;
  match: (model: PublicModel) => boolean;
}[] = [
  // 2.5 必须排在 2.0 前面：hasS20Marker 同时认 2.0 和 2.5，若 2.0 先匹配，
  // S-2.5-* 会被并进 2.0 分类（运营要求两代分开）。
  { id: "2.5", label: "2.5", match: (model) => isS25(model) },
  { id: "2.0", label: "2.0", match: (model) => isS20(model) },
  { id: "2.0fast", label: "2.0fast", match: (model) => isS20Fast(model) },
  { id: "2.0mini", label: "2.0mini", match: (model) => isS20Mini(model) },
  {
    id: "minimax",
    label: "Minimax",
    match: (model) => /minimax|mini-h3/i.test(model.id) || /minimax/i.test(model.label),
  },
  {
    id: "kling",
    label: "可灵",
    match: (model) => /kling|可灵/i.test(model.id) || /可灵/i.test(model.label),
  },
  {
    id: "veo",
    label: "Veo",
    match: (model) => /veo|gemini-omni/i.test(model.id) || /veo|gemini.omni/i.test(model.label),
  },
  {
    id: "runway",
    label: "Runway",
    match: (model) => /runway/i.test(model.id) || /runway/i.test(model.label),
  },
  { id: "wan", label: "Wan", match: (model) => /wan/i.test(model.id) || /wan/i.test(model.label) },
  // xAI：grok-imagine-video（按秒）与 grok-imagine-video-1.5（按次）是两条独立
  // 上架项，缺这条规则时它们全落进「其他」。
  {
    id: "grok",
    label: "Grok",
    match: (model) => /grok/i.test(model.id) || /grok/i.test(model.label),
  },
  // 字节 Seedance：按 token 计费的 doubao-seedance-* 与按秒分档的
  // firefly-seedance2-*。缺这条规则时它们全落进「其他」。
  // 标注「官方」：这里是站点官转渠道，与 S 系「线路」Self-Host 渠道区分开。
  {
    id: "seedance",
    label: "Seedance官方",
    match: (model) => /seedance/i.test(model.id) || /seedance/i.test(model.label),
  },
];

const IMAGE_CATEGORY_RULES: {
  id: string;
  label: string;
  match: (model: PublicModel) => boolean;
}[] = [
  {
    id: "banana",
    label: "香蕉",
    match: (model) => /banana|香蕉/i.test(model.id) || /香蕉/i.test(model.label),
  },
  {
    id: "universal2",
    label: "全能模型2",
    match: (model) => isUniversalImage(model) && !isUniversal25(model),
  },
  {
    id: "universal25",
    label: "全能模型2.5",
    match: (model) => isUniversalImage(model) && isUniversal25(model),
  },
  {
    id: "midjourney",
    label: "Midjourney",
    match: (model) => /mj-|midjourney/i.test(model.id) || /midjourney/i.test(model.label),
  },
  {
    id: "seedream",
    label: "Seedream",
    match: (model) => /seedream/i.test(model.id) || /seedream/i.test(model.label),
  },
];

/**
 * The 全能模型 family shares the gpt-image/image2 ids. 2.5 entries carry a
 * "2.5" generation marker (the live catalog labels them GPT-Image-2.5-*);
 * everything else on the line (2 · 特价/高质量, image2-A/W, the -1.5k fixed
 * variants) stays in the 2 tab.
 */
function isUniversalImage(model: PublicModel) {
  return /gpt-image|image2|全能模型/i.test(model.id) || /全能模型/i.test(model.label);
}

function isUniversal25(model: PublicModel) {
  return /2\.5/.test(`${model.id} ${model.label}`);
}

/**
 * S-family grouping, per the console's own rules:
 *  - S + fast        → "2.0fast" bucket (no 2.0 marker required, so a bare
 *                      "S-fast高质量" belongs here too)
 *  - S + mini        → "2.0mini" bucket
 *  - S + 2.0 / 2.5   → "2.0" bucket, as long as it is not fast/mini
 * fast/mini beat the 2.0 marker because they name the more specific line.
 */
function isSFamily(model: PublicModel) {
  return /^S-/i.test(model.id) || /卡人脸|可人脸/.test(model.label);
}

function hasS20Marker(model: PublicModel) {
  const haystack = `${model.id} ${model.label}`;
  return /2\.0|2\.5/.test(haystack);
}

function isS25(model: PublicModel) {
  const haystack = `${model.id} ${model.label}`.toLowerCase();
  if (!isSFamily(model) || !/2\.5/.test(haystack)) return false;
  return !/fast/i.test(haystack) && !/mini/i.test(haystack);
}

function isS20Fast(model: PublicModel) {
  const haystack = `${model.id} ${model.label}`.toLowerCase();
  return isSFamily(model) && /fast/i.test(haystack);
}

function isS20Mini(model: PublicModel) {
  const haystack = `${model.id} ${model.label}`.toLowerCase();
  return isSFamily(model) && hasS20Marker(model) && /mini/i.test(haystack);
}

function isS20(model: PublicModel) {
  const haystack = `${model.id} ${model.label}`.toLowerCase();
  if (!isSFamily(model) || !hasS20Marker(model) || /2\.5/.test(haystack)) return false;
  return !/fast/i.test(haystack) && !/mini/i.test(haystack);
}

export function buildCategories(
  modality: PublicModel["modality"],
  models: PublicModel[],
): Category[] {
  if (isCustomModelKey(models[0]?.id ?? ""))
    return [{ id: "custom", label: "自有 API", match: () => true }];
  const rules =
    modality === "video" ? VIDEO_CATEGORY_RULES : modality === "image" ? IMAGE_CATEGORY_RULES : [];
  const categories: Category[] = [];
  const assigned = new Set<string>();
  for (const rule of rules) {
    const members = models.filter((model) => rule.match(model));
    if (!members.length) continue;
    for (const model of members) assigned.add(model.id);
    categories.push({ id: rule.id, label: rule.label, match: rule.match });
  }
  // Anything not covered by a named rule falls into "其他" so nothing is lost.
  const rest = models.filter((model) => !assigned.has(model.id));
  if (rest.length)
    categories.push({
      id: "other",
      label: "其他",
      match: (model) => rest.some((item) => item.id === model.id),
    });
  return categories.length ? categories : [{ id: "all", label: "全部", match: () => true }];
}

/**
 * 运营分区视图：不单独设「特惠」tab——特惠模型（zone="promo"）留在它本来
 * 命中的分类里，由列表渲染时排在稳定模型之后（partitionModelsByZone），
 * 分界处展示 PROMO_MODEL_NOTICE。分类 match 是按 id/label 的正则谓词，
 * 直接对全量模型分类即可。
 */
export function buildZonedCategories(
  modality: PublicModel["modality"],
  models: PublicModel[],
): Category[] {
  return buildCategories(modality, models);
}

/** 极端兜底分类：任何情况下都不允许 categories 为空导致 [0] 取值崩溃。 */
const FALLBACK_CATEGORY: Category = { id: "all", label: "全部", match: () => true };

export function CategorizedModelSelect({
  value,
  models,
  disabled = false,
  onChange,
  ariaLabel = "模型",
  placeholder = "选择模型",
}: {
  value: string;
  models: PublicModel[];
  disabled?: boolean;
  onChange: (modelId: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const modality = models[0]?.modality ?? "image";
  const categories = useMemo(() => buildZonedCategories(modality, models), [modality, models]);
  const selected = models.find((model) => model.id === value) ?? null;
  const selectedCategory = useMemo(() => {
    if (!selected) return categories[0] ?? FALLBACK_CATEGORY;
    return (
      categories.find((category) => category.match(selected)) ?? categories[0] ?? FALLBACK_CATEGORY
    );
  }, [categories, selected]);
  const [activeCategoryId, setActiveCategoryId] = useState(selectedCategory.id);

  useEffect(() => {
    if (open) setActiveCategoryId(selectedCategory.id);
  }, [open, selectedCategory.id]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  const activeCategory =
    categories.find((category) => category.id === activeCategoryId) ??
    categories[0] ??
    FALLBACK_CATEGORY;
  // 分类内稳定在上、特惠贴底；分界处插入免责声明。
  const activeModels = useMemo(
    () => partitionModelsByZone(models.filter((model) => activeCategory.match(model))),
    [activeCategory, models],
  );

  if (!models.length) {
    return (
      <button type="button" className="wc-cat-select-trigger" disabled aria-label={ariaLabel}>
        <span>{placeholder}</span>
      </button>
    );
  }

  return (
    <div className="wc-cat-select" ref={rootRef}>
      <button
        type="button"
        className="wc-cat-select-trigger"
        aria-label={ariaLabel}
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <Sparkles aria-hidden="true" className="wc-cat-select-icon" />
        <span className="wc-cat-select-value">
          {selected ? modelPickerLabel(selected) : placeholder}
        </span>
        {selected && isPromoZoneModel(selected) ? (
          <span className="wc-cat-select-promo-badge">特惠</span>
        ) : null}
        {selected ? <span className="wc-cat-select-meta">{modelPriceLabel(selected)}</span> : null}
        <ChevronDown aria-hidden="true" className="wc-cat-select-caret" />
      </button>

      {open ? (
        <div className="wc-cat-select-menu" role="listbox" aria-label={ariaLabel}>
          <div className="wc-cat-select-tabs" role="tablist" aria-label="模型分类">
            {categories.map((category) => (
              <button
                key={category.id}
                type="button"
                role="tab"
                aria-selected={category.id === activeCategory.id}
                className={category.id === activeCategory.id ? "is-active" : undefined}
                onClick={() => setActiveCategoryId(category.id)}
                title={category.label}
              >
                <span>{category.label}</span>
              </button>
            ))}
          </div>
          <div className="wc-cat-select-options">
            {activeModels.map((model, index) => {
              const active = model.id === value;
              const promo = isPromoZoneModel(model);
              const isPromoBlockStart =
                promo && (index === 0 || !isPromoZoneModel(activeModels[index - 1]!));
              return (
                <Fragment key={model.id}>
                  {promo && isPromoBlockStart ? (
                    <p className="wc-cat-select-promo-note" role="note">
                      {PROMO_MODEL_NOTICE}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    className={active ? "is-selected" : undefined}
                    onClick={() => {
                      onChange(model.id);
                      setOpen(false);
                    }}
                  >
                    <span className="wc-cat-select-option-copy">
                      <strong>{modelPickerLabel(model)}</strong>
                      {/* 价格紧跟模型名：原来 price 推到行尾，名字与价格隔得太远不好对照 */}
                      <span className="wc-cat-select-option-price">{modelPriceLabel(model)}</span>
                      {promo ? <span className="wc-cat-select-promo-badge">特惠</span> : null}
                    </span>
                    {active ? <Check aria-hidden="true" className="wc-cat-select-check" /> : null}
                  </button>
                </Fragment>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
