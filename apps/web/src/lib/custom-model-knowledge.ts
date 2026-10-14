import {
  isAllowedAudioEndpoint,
  type ModelModality,
  type ModelParameter,
} from "@weftcanvas/contracts";

/**
 * BYOK 兼容档的模型知识库。
 *
 * 中转站的模型列表可能只有 ID。按官方 ID 识别常见模型，提供默认模态与兼容端点。
 * 模型识别不证明中转站协议可用；协议差异由高级配置处理。
 *
 * 识别边界：
 *
 * - **一律官方命名**：只按官方 id 匹配，显示名用官方 id（厂商官方产品名除外，例如
 *   `Grok Imagine Video`）。不做我方别称或中文营销名映射，也不改写 id——中转站叫什么
 *   就显示什么；识别不了返回 `null`，由调用方按 prompt-only 兜底并在 UI 标注。
 * - **参数宁缺毋滥**：只声明有把握的参数。多写一个上游不认的字段就可能整条请求失败，
 *   缺的参数留给用户用高级协议配置补充。
 * - **纯前端能力**：不参与服务端校验、不参与计价、不进浏览器之外的任何存储。
 */

/** 与 `CustomApiRoute.parameters` 结构一致；由 custom-api.ts 的赋值点做类型校验。 */
export type KnowledgeRouteParameter = {
  name: string;
  path: string;
  type: "string" | "number" | "boolean" | "array" | "object";
  fixed?: unknown;
  default?: unknown;
  format?: string;
  itemsFormat?: string;
};

export type KnowledgePlan = {
  /** 该官方 id 族覆盖的模态。 */
  modalities: ModelModality[];
  /** 显示名。缺省 = 官方 id 原样。 */
  label?: string;
  /** 一句话说明（中性，不含品牌化措辞）。 */
  description: string;
  /** 参考图输入约束；缺省 = 不声明。 */
  imageInput?: { min: number; max: number; multiple: boolean };
  /** 提示词是否必需（目前所有已识别族都是必需）。 */
  textRequired: boolean;
  /** 提交端点。 */
  endpointPath: string;
  /** 界面参数（选择器控件）。 */
  uiParameters: ModelParameter[];
  /** wire 参数（点路径映射）。 */
  wireParameters: KnowledgeRouteParameter[];
};

const IMAGE_ENDPOINT = "/v1/images/generations";
const MIDJOURNEY_ENDPOINT = "/v1/midjourney/generations";
const VIDEO_ENDPOINT = "/v1/videos";

const GROK_IMAGINE_VIDEO_MODEL_ID = "grok-imagine-video";
const GROK_IMAGINE_VIDEO_15_MODEL_ID = "grok-imagine-video-1.5";
const GROK_VIDEO_SECONDS = Array.from({ length: 15 }, (_, index) => String(index + 1));
const GROK_VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"];
const GROK_VIDEO_RESOLUTIONS = ["480p", "720p"];

export function isGrokImagineVideoModel(modelId: string) {
  return modelId === GROK_IMAGINE_VIDEO_MODEL_ID || modelId === GROK_IMAGINE_VIDEO_15_MODEL_ID;
}

function promptParameter(label = "提示词"): ModelParameter {
  return {
    name: "prompt",
    label,
    type: "string",
    required: true,
    minLength: 1,
    mutuallyExclusiveWith: [],
  };
}

function enumParameter(
  name: string,
  label: string,
  options: readonly string[],
  defaultValue?: string,
): ModelParameter {
  return {
    name,
    label,
    type: "string",
    required: false,
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
    options: [...options],
    mutuallyExclusiveWith: [],
  };
}

function wire(name: string, path = name, type: KnowledgeRouteParameter["type"] = "string") {
  return { name, path, type } satisfies KnowledgeRouteParameter;
}

/**
 * 参数只声明提示词 + 端点模型名：跨厂商的时长/比例/分辨率字段名差异太大，猜错会直接
 * 让请求失败，交给协议档案补更诚实。
 */
function conservativePlan(input: {
  modalities: ModelModality[];
  description: string;
  endpointPath: string;
  label?: string;
  imageInput?: { min: number; max: number; multiple: boolean };
}): KnowledgePlan {
  return {
    modalities: input.modalities,
    description: input.description,
    endpointPath: input.endpointPath,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(input.imageInput === undefined ? {} : { imageInput: input.imageInput }),
    textRequired: true,
    uiParameters: [promptParameter()],
    wireParameters: [wire("prompt")],
  };
}

function grokVideoPlan(modelId: string): KnowledgePlan {
  const imageRequired = modelId === GROK_IMAGINE_VIDEO_15_MODEL_ID;
  return {
    modalities: ["video"],
    label: imageRequired ? "Grok Imagine Video 1.5" : "Grok Imagine Video",
    description: imageRequired
      ? "Grok 1.5 首帧图生视频，必须且只能提供 1 张公网可访问的参考图。"
      : "Grok 视频生成，支持文生、单首帧和最多 7 张多图参考。",
    imageInput: imageRequired
      ? { min: 1, max: 1, multiple: false }
      : { min: 0, max: 7, multiple: true },
    textRequired: true,
    endpointPath: VIDEO_ENDPOINT,
    uiParameters: [
      promptParameter(),
      enumParameter("seconds", "时长（秒）", GROK_VIDEO_SECONDS, "6"),
      enumParameter("aspect_ratio", "画面比例", GROK_VIDEO_ASPECT_RATIOS, "16:9"),
      enumParameter(
        "resolution",
        "分辨率",
        imageRequired ? [...GROK_VIDEO_RESOLUTIONS, "1080p"] : GROK_VIDEO_RESOLUTIONS,
        "720p",
      ),
    ],
    wireParameters: [
      wire("prompt"),
      wire("seconds"),
      wire("aspect_ratio"),
      wire("resolution"),
      imageRequired
        ? {
            name: "first_frame_image",
            path: "first_frame_image",
            type: "string",
            format: "public-http-url",
          }
        : { name: "image", path: "image", type: "string", format: "public-http-url" },
      ...(imageRequired
        ? []
        : [
            {
              name: "reference_images",
              path: "reference_images",
              type: "array" as const,
              itemsFormat: "public-http-url-object",
            },
          ]),
    ],
  };
}

type KnowledgeEntry = {
  /** 调试/测试用的条目名，不参与匹配。 */
  name: string;
  match: (modelId: string) => boolean;
  plan: (modelId: string) => KnowledgePlan;
};

/**
 * 顺序敏感：先精确 id，再 id 族前缀。前缀一律锚定 `^`，避免 `sora` 之类短词在别家
 * 名字中间命中。
 */
const KNOWLEDGE_ENTRIES: KnowledgeEntry[] = [
  {
    name: "grok-imagine-video",
    match: isGrokImagineVideoModel,
    plan: grokVideoPlan,
  },
  // —— 视频族 ——
  {
    name: "seedance",
    match: (id) => /^(?:doubao-)?seedance/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Seedance 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "sora",
    match: (id) => /^sora/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Sora 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "kling",
    match: (id) => /^kling/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Kling 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "veo",
    match: (id) => /^(?:google-)?veo/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Veo 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "wan",
    match: (id) => /^wan(?:\d|-|_|$)/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Wan 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "hunyuan-video",
    match: (id) => /^hunyuan[-_]video(?:[-_\d]|$)/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "混元视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "minimax-hailuo",
    match: (id) => /^(?:(?:minimax-)?hailuo(?:[-_\d]|$)|video-01(?:[-_]|$))/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "MiniMax 海螺视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "pika",
    match: (id) => /^pika/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Pika 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "luma",
    match: (id) => /^(?:luma|ray-\d)/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Luma 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  {
    name: "runway",
    match: (id) => /^(?:runway|gen-[34])/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["video"],
        description: "Runway 视频生成，默认使用中转站的 /v1/videos 兼容端点。",
        endpointPath: VIDEO_ENDPOINT,
      }),
  },
  // —— 图像族 ——
  {
    name: "hunyuan-image",
    match: (id) => /^hunyuan[-_]image(?:[-_\d]|$)/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "Hunyuan Image 图像生成，默认使用中转站的图像兼容端点。",
        endpointPath: IMAGE_ENDPOINT,
      }),
  },
  {
    name: "midjourney",
    match: (id) => /^(?:midjourney|mj[_-])/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "Midjourney 图像生成，默认使用中转站的 Midjourney 兼容端点。",
        endpointPath: MIDJOURNEY_ENDPOINT,
      }),
  },
  {
    name: "gpt-image",
    match: (id) => /^gpt-image/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "GPT Image 图像生成，默认使用中转站的图像兼容端点。",
        endpointPath: IMAGE_ENDPOINT,
      }),
  },
  {
    name: "dall-e",
    match: (id) => /^(?:dall-e|dalle)/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "DALL·E 图像生成，默认使用中转站的图像兼容端点。",
        endpointPath: IMAGE_ENDPOINT,
      }),
  },
  {
    name: "flux",
    match: (id) => /^flux/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "FLUX 图像生成，默认使用中转站的图像兼容端点。",
        endpointPath: IMAGE_ENDPOINT,
      }),
  },
  {
    name: "nano-banana",
    match: (id) => /^nano-banana/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "Nano Banana 图像生成，默认使用中转站的图像兼容端点。",
        endpointPath: IMAGE_ENDPOINT,
      }),
  },
  {
    name: "imagen",
    match: (id) => /^imagen/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "Imagen 图像生成，默认使用中转站的图像兼容端点。",
        endpointPath: IMAGE_ENDPOINT,
      }),
  },
  {
    name: "seedream",
    match: (id) => /^(?:doubao-)?seedream/i.test(id),
    plan: () =>
      conservativePlan({
        modalities: ["image"],
        description: "Seedream 图像生成，默认使用中转站的图像兼容端点。",
        endpointPath: IMAGE_ENDPOINT,
      }),
  },
];

/** 按官方 id 识别模型；识别不了返回 `null`（调用方按 prompt-only 兜底）。 */
export function inferKnowledgePlan(modelId: string): KnowledgePlan | null {
  const value = modelId.trim();
  if (!value) return null;
  for (const entry of KNOWLEDGE_ENTRIES) {
    if (entry.match(value)) return entry.plan(value);
  }
  return null;
}

/** 知识库（不含用户手动标注）认定该 id 支持的模态。 */
export function knowledgeModalities(modelId: string): ModelModality[] {
  const plan = inferKnowledgePlan(modelId);
  if (!plan) return [];
  // 音频端点白名单与契约保持一致：知识库不绕过端点校验，只在端点合法时保留该模态。
  return plan.modalities.filter(
    (modality) => modality !== "audio" || isAllowedAudioEndpoint(plan.endpointPath),
  );
}

/**
 * 该 id 在给定模态下是否可用：用户手动标注优先，其次是知识库识别。
 * 两处（选择器过滤、设置面板勾选态）必须用同一判据，避免"面板勾了但选择器没有"。
 */
export function modelSupportsModality(
  modelId: string,
  manualModalities: readonly ModelModality[] | undefined,
  modality: ModelModality,
): boolean {
  if (manualModalities?.includes(modality)) return true;
  return knowledgeModalities(modelId).includes(modality);
}

/** 该 id 是否被知识库识别（UI 用它区分"已识别/未识别"，不改变可用性）。 */
export function isRecognizedModel(modelId: string) {
  return inferKnowledgePlan(modelId) !== null;
}
