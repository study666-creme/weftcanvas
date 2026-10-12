import type { ModelParameter } from "@weftcanvas/contracts";

/**
 * 目录参数的站内解释与文案。
 *
 * 目录（prompt-hub）只发布 name/label/options，不解释每个参数的语义；而
 * Midjourney 的参数（风格参考图、权重、后续动作……）对不熟悉的创作者完全不
 * 自明。这里按参数名维护一句话解释，渲染成字段旁的 ⓘ 提示；目录未来若在
 * parameter.description 里自带解释，则优先用目录的。
 */
export type GenerationParameterMeta = {
  /** 参数的一句话解释。 */
  hint: string;
  /** 枚举选项的站内文案；未命中的选项沿用原值展示。 */
  options?: Record<string, string>;
};

const PARAMETER_META: Record<string, GenerationParameterMeta> = {
  prompt: { hint: "描述想生成的内容，越具体越好" },
  aspect_ratio: { hint: "生成画面的宽高比" },
  resolution: { hint: "输出分辨率档位，越高越清晰、耗时越长" },
  size: { hint: "画面尺寸或比例" },
  quality: { hint: "画质/算力档位：档位越高细节越多、耗时与消耗越高" },
  hd: { hint: "开启后以 2K 高清出图" },
  background: { hint: "透明背景仅在 PNG/WebP 输出格式下生效" },
  output_format: { hint: "返回图片的文件格式" },
  response_format: { hint: "返回链接（url）还是直接返回图片数据" },
  negative_prompt: { hint: "不希望出现的元素，多个用逗号分隔" },
  seed: { hint: "固定随机种子可复现相同构图；留空则每次随机" },
  raw: { hint: "Raw 模式更贴合提示词、自带风格化更弱，适合摄影/写实" },
  stylize: { hint: "风格化强度：越高越有艺术感、越不贴合描述（0–1000）" },
  chaos: { hint: "混乱度：越高一次四张图之间差异越大（0–100）" },
  weird: { hint: "怪异度：越高构图越出格（0–3000）" },
  tile: { hint: "生成可无缝平铺的图案纹理" },
  iw: { hint: "图片参考权重（0–3）：越高越接近参考图" },
  cref: { hint: "角色参考图 URL：让同一人物跨图保持长相一致" },
  sref: { hint: "风格参考图 URL：模仿参考图的画风（配合风格权重使用）" },
  dref: { hint: "深度参考图 URL：沿用参考图的空间构图，不照抄画风" },
  cw: { hint: "角色权重（0–100）：100 保留脸部与服装，越低越只保留脸部" },
  sw: { hint: "风格权重（0–1000）：风格参考的作用强度" },
  dw: { hint: "深度权重（0–100）：深度结构的约束强度" },
  n: { hint: "Midjourney 每次固定返回一张四宫格，张数由上游决定" },
  duration_seconds: { hint: "生成视频的时长（秒）" },
  seconds: { hint: "生成视频的时长（秒）" },
  duration: { hint: "生成视频/音频的时长" },
  task_id: { hint: "上一次生成任务的 ID（在任务记录里复制），后续操作的对象" },
  index: { hint: "对四宫格中的第几张执行（1–4）" },
  custom_id: { hint: "高级：上游任务返回的按钮 ID（如 U1、V2）。填写后优先于「动作 + 序号」组合" },
  zoom_ratio: { hint: "扩图倍数：大于 1 时主体缩小、四周补全内容" },
};

/** Midjourney 后续动作参数名：它是对已完成任务的二次操作，与直接生成分属两种流程。 */
export const MJ_ACTION_PARAMETER_NAME = "action";
/** 后续动作的配套参数；选择动作后按需出现，取消动作时一并清空。 */
export const MJ_ACTION_DEPENDENT_NAMES = [
  "task_id",
  "index",
  "custom_id",
  "direction",
  "zoom_ratio",
  "dimensions",
] as const;

export type MjActionMeta = {
  label: string;
  /** 选中该动作后展示的说明（含所需条件与计费口径）。 */
  hint: string;
  /** 该动作需要呈现的配套参数（按渲染顺序）。 */
  fields: readonly string[];
  /** 是否必须填写父任务 ID。 */
  needsTaskId: boolean;
  /** 需要已连接的参考图片数量（0 = 不需要）。 */
  needsImages: number;
};

export const MJ_ACTION_OPTIONS: Record<string, MjActionMeta> = {
  upscale: {
    label: "放大（U）",
    hint: "把四宫格中的指定一张放大成单张大图。单独计费。",
    fields: ["task_id", "index", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  variation: {
    label: "变体（V）",
    hint: "基于四宫格中的指定一张，再生成一组新四宫格。单独计费。",
    fields: ["task_id", "index", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  high_variation: {
    label: "强变体",
    hint: "变化幅度更大的变体，构图可能明显偏离原图。单独计费。",
    fields: ["task_id", "index", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  low_variation: {
    label: "弱变体",
    hint: "变化幅度较小的变体，整体贴近原图。单独计费。",
    fields: ["task_id", "index", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  reroll: {
    label: "重掷（重画）",
    hint: "用同一提示词重新掷一组全新四宫格。单独计费。",
    fields: ["task_id", "index", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  zoom: {
    label: "扩图（Zoom out）",
    hint: "主体缩小、补全四周内容；可填扩图倍数。单独计费。",
    fields: ["task_id", "index", "zoom_ratio", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  pan: {
    label: "平移扩展（Pan）",
    hint: "向选定方向延伸画面。单独计费。",
    fields: ["task_id", "index", "direction", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  blend: {
    label: "融图（Blend）",
    hint: "把 2–4 张参考图片融合成一张图，可指定画幅；忽略提示词。单独计费。",
    fields: ["dimensions", "custom_id"],
    needsTaskId: false,
    needsImages: 2,
  },
  edits: {
    label: "局部重绘",
    hint: "对四宫格中的指定一张做局部修改。单独计费。",
    fields: ["task_id", "index", "custom_id"],
    needsTaskId: true,
    needsImages: 0,
  },
  describe: {
    label: "图生文（Describe）",
    hint: "按参考图片反推提示词，需要先连接 1 张参考图片。单独计费。",
    fields: [],
    needsTaskId: false,
    needsImages: 1,
  },
};

/** Midjourney 画质档的数字档位按业界口径给出可读文案。 */
const MJ_QUALITY_OPTION_LABELS: Record<string, string> = {
  "0.25": "0.25 草稿",
  "0.5": "0.5 快速",
  "1": "1 标准",
  "2": "2 高清",
};

const PARAMETER_OPTION_LABELS: Record<string, Record<string, string>> = {
  action: Object.fromEntries(
    Object.entries(MJ_ACTION_OPTIONS).map(([value, meta]) => [value, meta.label]),
  ),
  direction: { left: "向左", right: "向右", up: "向上", down: "向下" },
  dimensions: { SQUARE: "方形 1:1", PORTRAIT: "竖幅 2:3", LANDSCAPE: "横幅 3:2" },
  quality: MJ_QUALITY_OPTION_LABELS,
};

/** 参数的一句话解释：目录自带 description 时优先目录，否则查站内文案。 */
export function generationParameterHint(parameter: ModelParameter): string | null {
  if (typeof parameter.description === "string" && parameter.description.trim())
    return parameter.description.trim();
  return PARAMETER_META[parameter.name.trim().toLowerCase()]?.hint ?? null;
}

/** 枚举选项的站内文案；未命中返回 null（沿用原值）。 */
export function generationParameterOptionMetaLabel(
  parameter: ModelParameter,
  option: string,
): string | null {
  return PARAMETER_OPTION_LABELS[parameter.name.trim().toLowerCase()]?.[option] ?? null;
}

/** 判断模型是否带「后续动作」参数（Midjourney 官转系目录）。 */
export function findMjActionParameter(model: {
  parameters: ModelParameter[];
}): ModelParameter | null {
  return model.parameters.find((parameter) => parameter.name === MJ_ACTION_PARAMETER_NAME) ?? null;
}

/**
 * 后续动作的配套参数对象（按目录里实际存在的字段返回，保持目录顺序）。
 */
export function mjActionDependentParameters(model: {
  parameters: ModelParameter[];
}): ModelParameter[] {
  const byName = new Map(model.parameters.map((parameter) => [parameter.name, parameter]));
  return MJ_ACTION_DEPENDENT_NAMES.map((name) => byName.get(name)).filter(
    (parameter): parameter is ModelParameter => parameter !== undefined,
  );
}
