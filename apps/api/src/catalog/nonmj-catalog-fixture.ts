/**
 * Test-only source-catalog fixture for the currently selectable non-Midjourney
 * image/video models. The model ids, labels, and parameter families come from
 * evidence inside this repository (Web e2e fixtures, generation model picker
 * tests, generation-store fixtures, provider tests, and the review docs); the
 * concrete option lists and prices are synthetic but legal so the full Canvas
 * chain can be exercised without any live catalog or paid request.
 *
 * This module must never be imported by production runtime code.
 */
export const NON_MJ_NOW_ISO = "2026-08-10T08:00:00.000Z";

type SourceModel = Record<string, unknown>;

function imageModel(options: {
  id: string;
  label: string;
  order: number;
  description?: string;
  resolution?: { default?: string; options: string[] };
  quality?: { default?: string; options: string[] };
  size?: { default?: string; options: string[] };
  aspectRatio?: { default?: string; options: string[] };
  n?: { fixed?: number; default?: number; min?: number; max?: number };
  images?: { max: number };
  unit?: "request" | "image";
  credits: number;
  yuan: number;
  extraParameters?: SourceModel["parameters"];
}): SourceModel {
  const parameters: Record<string, unknown>[] = [
    {
      name: "model",
      path: "model",
      type: "string",
      required: true,
      fixed: options.id,
      label: "模型",
    },
    {
      name: "prompt",
      path: "prompt",
      type: "string",
      required: true,
      min_length: 1,
      label: "提示词",
    },
  ];
  if (options.size) {
    parameters.push({
      name: "size",
      path: "size",
      type: "string",
      label: "画面尺寸",
      ...(options.size.default !== undefined ? { default: options.size.default } : {}),
      options: options.size.options,
    });
  }
  if (options.aspectRatio) {
    parameters.push({
      name: "aspect_ratio",
      path: "aspect_ratio",
      type: "string",
      label: "画面比例",
      ...(options.aspectRatio.default !== undefined
        ? { default: options.aspectRatio.default }
        : {}),
      options: options.aspectRatio.options,
    });
  }
  if (options.quality) {
    parameters.push({
      name: "quality",
      path: "quality",
      type: "string",
      label: "质量",
      ...(options.quality.default !== undefined ? { default: options.quality.default } : {}),
      options: options.quality.options,
    });
  }
  if (options.resolution) {
    parameters.push({
      name: "resolution",
      path: "resolution",
      type: "string",
      label: "分辨率",
      ...(options.resolution.default !== undefined ? { default: options.resolution.default } : {}),
      options: options.resolution.options,
    });
  }
  const n = options.n ?? { default: 1, min: 1, max: 8 };
  parameters.push({
    name: "n",
    path: "n",
    type: "integer",
    label: "生成张数",
    ...(n.fixed !== undefined ? { fixed: n.fixed } : {}),
    ...(n.default !== undefined ? { default: n.default } : {}),
    ...(n.min !== undefined ? { min: n.min } : {}),
    ...(n.max !== undefined ? { max: n.max } : {}),
  });
  if (options.images) {
    parameters.push({
      name: "images",
      path: "images",
      type: "array",
      label: "参考图",
      max_items: options.images.max,
      items: { type: "string", format: "uri-or-data-image" },
    });
  }
  if (options.extraParameters)
    parameters.push(...(options.extraParameters as Record<string, unknown>[]));
  return {
    id: options.id,
    modality: "image",
    operation: "generate",
    order: options.order,
    input: {
      text: { required: true },
      images: options.images
        ? { min: 0, max: options.images.max, multiple: true }
        : { min: 0, max: 0, multiple: false },
    },
    output: {
      type: "image",
      ...(options.n?.fixed
        ? { count: { fixed: 1 } }
        : { count: { min: 1, max: options.n?.max ?? 8 } }),
    },
    parameters,
    endpoint: {
      method: "POST",
      path: "/v1/images/generations",
      content_type: "application/json",
    },
    public: { id: options.id, label: options.label, description: options.description ?? "" },
    selectable: true,
    pricing: {
      mode: "fixed",
      unit: options.unit ?? "request",
      currency: "CNY",
      credits_per_yuan: 100,
      credits: options.credits,
      yuan: options.yuan,
    },
  };
}

function videoModel(options: {
  id: string;
  label: string;
  order: number;
  description?: string;
  resolution?: { default?: string; options?: string[] };
  seconds?: { default?: number; min?: number; max?: number };
  duration?: { default?: number; min?: number; max?: number };
  images?: { max: number };
  videos?: { max: number };
  perSecond?: boolean;
  creditsPerSecond?: number;
  yuanPerSecond?: number;
  credits?: number;
  yuan?: number;
  extraParameters?: SourceModel["parameters"];
}): SourceModel {
  const parameters: Record<string, unknown>[] = [
    {
      name: "model",
      path: "model",
      type: "string",
      required: true,
      fixed: options.id,
      label: "模型",
    },
    {
      name: "prompt",
      path: "prompt",
      type: "string",
      required: true,
      min_length: 1,
      label: "提示词",
    },
  ];
  const seconds = options.seconds ?? { default: 5, min: 4, max: 15 };
  parameters.push({
    name: "seconds",
    path: "seconds",
    type: "integer",
    label: "时长（秒）",
    ...(seconds.default !== undefined ? { default: seconds.default } : {}),
    ...(seconds.min !== undefined ? { min: seconds.min } : {}),
    ...(seconds.max !== undefined ? { max: seconds.max } : {}),
  });
  if (options.duration) {
    parameters.push({
      name: "duration",
      path: "duration",
      type: "integer",
      label: "时长兼容字段（秒）",
      ...(options.duration.default !== undefined ? { default: options.duration.default } : {}),
      ...(options.duration.min !== undefined ? { min: options.duration.min } : {}),
      ...(options.duration.max !== undefined ? { max: options.duration.max } : {}),
    });
  }
  if (options.resolution) {
    parameters.push({
      name: "resolution",
      path: "resolution",
      type: "string",
      label: "分辨率",
      ...(options.resolution.default !== undefined ? { default: options.resolution.default } : {}),
      ...(options.resolution.options ? { options: options.resolution.options } : {}),
    });
  }
  if (options.images) {
    parameters.push({
      name: "images",
      path: "images",
      type: "array",
      label: "参考图",
      max_items: options.images.max,
      items: { type: "string", format: "public-http-url" },
    });
  }
  if (options.extraParameters)
    parameters.push(...(options.extraParameters as Record<string, unknown>[]));
  return {
    id: options.id,
    modality: "video",
    operation: "generate",
    order: options.order,
    input: {
      text: { required: true },
      images: options.images
        ? { min: 0, max: options.images.max, multiple: true }
        : { min: 0, max: 0, multiple: false },
      videos: options.videos
        ? { min: 0, max: options.videos.max, multiple: options.videos.max > 1 }
        : { min: 0, max: 0, multiple: false },
    },
    output: { type: "video", count: { fixed: 1 } },
    parameters,
    endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
    public: { id: options.id, label: options.label, description: options.description ?? "" },
    selectable: true,
    pricing: options.perSecond
      ? {
          mode: "fixed",
          unit: "second",
          currency: "CNY",
          credits_per_yuan: 100,
          credits: options.creditsPerSecond,
          yuan: options.yuanPerSecond,
          quantity_parameter: "duration",
        }
      : {
          mode: "fixed",
          unit: "request",
          currency: "CNY",
          credits_per_yuan: 100,
          credits: options.credits,
          yuan: options.yuan,
        },
  };
}

export function buildNonMjSourceCatalog(): unknown {
  return {
    success: true,
    version: "catalog-nonmj",
    capability_version: "capability-nonmj",
    pricing_version: "",
    fetched_at: NON_MJ_NOW_ISO,
    credits_per_yuan: 100,
    models: [
      // OpenAI / 全能模型2 family
      imageModel({
        id: "gpt-image-2-1k",
        label: "全能模型2 · 特价 1K",
        order: 20,
        description: "全能模型2 特价 1K 档位",
        n: { fixed: 1 },
        unit: "image",
        credits: 0.5,
        yuan: 0.005,
        images: { max: 14 },
      }),
      imageModel({
        id: "gpt-image-2",
        label: "全能模型2 · 标准",
        order: 21,
        n: { default: 1, min: 1, max: 8 },
        unit: "image",
        credits: 2,
        yuan: 0.02,
        size: { default: "auto", options: ["auto", "16:9", "1:1", "9:16"] },
        images: { max: 14 },
      }),
      imageModel({
        id: "gpt-image-2-ext",
        label: "全能模型2 · 高清",
        order: 22,
        description: "高分辨率长耗时模型",
        n: { fixed: 1 },
        unit: "image",
        credits: 3,
        yuan: 0.03,
        resolution: { default: "2k", options: ["1k", "2k", "4k"] },
        quality: { default: "high", options: ["standard", "high"] },
        size: { default: "auto", options: ["auto", "16:9", "1:1", "9:16"] },
        images: { max: 14 },
      }),
      imageModel({
        id: "gpt-image-2-free",
        label: "全能模型2 · 免费",
        order: 23,
        n: { fixed: 1 },
        unit: "request",
        credits: 0,
        yuan: 0,
        images: { max: 14 },
      }),
      // Fast 4K is a source-model alias normalized to public `image2-4k-fast`.
      imageModel({
        id: "gpt-image-2-4k-fast",
        label: "全能模型2 · 4K Fast",
        order: 24,
        n: { fixed: 1 },
        unit: "request",
        credits: 2,
        yuan: 0.02,
        images: { max: 14 },
      }),
      imageModel({
        id: "image2",
        label: "全能模型2",
        order: 25,
        n: { fixed: 1 },
        unit: "image",
        credits: 1.5,
        yuan: 0.015,
        images: { max: 14 },
      }),
      imageModel({
        id: "image2-economy",
        label: "全能模型2 · 经济版",
        order: 26,
        n: { fixed: 1 },
        unit: "image",
        credits: 0.8,
        yuan: 0.008,
        images: { max: 14 },
      }),
      // image2-A is the async task image route.
      imageModel({
        id: "image2-A",
        label: "全能模型2 · A",
        order: 27,
        n: { fixed: 1 },
        unit: "request",
        credits: 2.5,
        yuan: 0.025,
        resolution: { options: ["1k", "2k", "4k"] },
        quality: { default: "standard", options: ["standard", "high"] },
        images: { max: 14 },
      }),
      // Banana family
      imageModel({
        id: "nano-banana",
        label: "香蕉 · 标准 1K",
        order: 40,
        n: { fixed: 1 },
        unit: "image",
        credits: 1,
        yuan: 0.01,
        resolution: { default: "1k", options: ["1k", "2k", "4k"] },
        size: { default: "auto", options: ["auto", "16:9", "1:1", "9:16"] },
        images: { max: 14 },
      }),
      imageModel({
        id: "nano-banana-fast",
        label: "香蕉 · 极速 1K",
        order: 41,
        n: { fixed: 1 },
        unit: "image",
        credits: 0.9,
        yuan: 0.009,
        resolution: { default: "1k", options: ["1k"] },
        images: { max: 14 },
      }),
      imageModel({
        id: "nano-banana-2-lite",
        label: "香蕉 · Lite 1K",
        order: 42,
        n: { fixed: 1 },
        unit: "image",
        credits: 0.7,
        yuan: 0.007,
        resolution: { default: "1k", options: ["1k"] },
        images: { max: 14 },
      }),
      imageModel({
        id: "nano-banana-pro",
        label: "香蕉 · 专业 1K/2K/4K",
        order: 43,
        n: { fixed: 1 },
        unit: "image",
        credits: 2,
        yuan: 0.02,
        resolution: { default: "2k", options: ["1k", "2k", "4k"] },
        size: { default: "auto", options: ["auto", "16:9", "1:1", "9:16"] },
        images: { max: 14 },
      }),
      imageModel({
        id: "nano-banana-2",
        label: "香蕉 · 2代 1K/2K/4K",
        order: 44,
        n: { fixed: 1 },
        unit: "image",
        credits: 2,
        yuan: 0.02,
        resolution: { default: "2k", options: ["1k", "2k", "4k"] },
        size: { default: "auto", options: ["auto", "16:9", "1:1", "9:16"] },
        images: { max: 14 },
      }),
      // 灵图 family
      imageModel({
        id: "lingtu",
        label: "灵图",
        order: 50,
        n: { fixed: 1 },
        unit: "image",
        credits: 1,
        yuan: 0.01,
        resolution: { options: ["1k", "2k", "4k"] },
        images: { max: 14 },
      }),
      imageModel({
        id: "lingtu-fast",
        label: "灵图 · 极速",
        order: 51,
        n: { fixed: 1 },
        unit: "image",
        credits: 0.8,
        yuan: 0.008,
        images: { max: 14 },
      }),
      imageModel({
        id: "lingtu-lite",
        label: "灵图 · Lite",
        order: 52,
        n: { fixed: 1 },
        unit: "image",
        credits: 0.6,
        yuan: 0.006,
        images: { max: 14 },
      }),
      // Grok image
      imageModel({
        id: "grok-imagine-image",
        label: "Grok Imagine Image",
        order: 60,
        n: { fixed: 1 },
        unit: "request",
        credits: 3,
        yuan: 0.03,
        size: { default: "1024x1024", options: ["1024x1024", "16:9", "9:16"] },
        quality: { default: "auto", options: ["auto", "low", "high"] },
        images: { max: 4 },
      }),
      // Grok video
      videoModel({
        id: "grok-imagine-video",
        label: "Grok Imagine Video",
        order: 70,
        seconds: { default: 5, min: 1, max: 15 },
        resolution: { options: ["480p", "720p", "1080p"] },
        perSecond: true,
        creditsPerSecond: 0.68,
        yuanPerSecond: 0.0068,
        images: { max: 14 },
      }),
      videoModel({
        id: "grok-imagine-video-1.5",
        label: "Grok Imagine Video 1.5",
        order: 71,
        seconds: { default: 5, min: 1, max: 15 },
        resolution: { options: ["480p", "720p", "1080p"] },
        perSecond: true,
        creditsPerSecond: 0.6,
        yuanPerSecond: 0.006,
        images: { max: 14 },
      }),
      // Kling reference video
      videoModel({
        id: "kling-o3-pro-v2v-reference",
        label: "Kling O3 Pro",
        order: 80,
        description: "图生视频参考模型",
        seconds: { default: 5, min: 4, max: 15 },
        resolution: { default: "720p", options: ["480p", "720p", "1080p"] },
        credits: 8.5,
        yuan: 0.085,
        images: { max: 10 },
      }),
      // Seedance fixed-resolution video models
      videoModel({
        id: "sd2.0-480p",
        label: "Seedance 2.0 Pro 480P",
        order: 90,
        resolution: { default: "480p" },
        seconds: { default: 5, min: 4, max: 15 },
        perSecond: true,
        creditsPerSecond: 0.38,
        yuanPerSecond: 0.0038,
        images: { max: 9 },
      }),
      videoModel({
        id: "sd2.0-720p",
        label: "Seedance 2.0 Pro 720P",
        order: 91,
        resolution: { default: "720p" },
        seconds: { default: 5, min: 4, max: 15 },
        perSecond: true,
        creditsPerSecond: 0.58,
        yuanPerSecond: 0.0058,
        images: { max: 9 },
      }),
      // Legacy per-second motion models referenced by the browser catalog.
      videoModel({
        id: "motion-video",
        label: "动态影像",
        order: 100,
        seconds: { default: 5, min: 1, max: 15 },
        perSecond: true,
        creditsPerSecond: 1.9,
        yuanPerSecond: 0.019,
      }),
      videoModel({
        id: "motion-video-1-5",
        label: "动态影像 1.5",
        order: 101,
        seconds: { default: 5, min: 1, max: 15 },
        perSecond: true,
        creditsPerSecond: 1.5,
        yuanPerSecond: 0.015,
      }),
      videoModel({
        id: "firefly-seedance2-fast-480p",
        label: "Seedance 2.0 Fast 480P",
        order: 102,
        resolution: { default: "480p" },
        seconds: { default: 5, min: 4, max: 15 },
        perSecond: true,
        creditsPerSecond: 0.2,
        yuanPerSecond: 0.002,
        images: { max: 9 },
      }),
    ],
  };
}

/** The public model ids the fixture makes selectable (post-normalization). */
export const NON_MJ_IMAGE_MODEL_IDS = [
  "gpt-image-2-1k",
  "gpt-image-2",
  "gpt-image-2-ext",
  "gpt-image-2-free",
  "image2",
  "image2-economy",
  "image2-4k-fast",
  "image2-A",
  "nano-banana",
  "nano-banana-fast",
  "nano-banana-2-lite",
  "nano-banana-pro",
  "nano-banana-2",
  "lingtu",
  "lingtu-fast",
  "lingtu-lite",
  "grok-imagine-image",
] as const;

export const NON_MJ_VIDEO_MODEL_IDS = [
  "grok-imagine-video",
  "grok-imagine-video-1.5",
  "kling-o3-pro-v2v-reference",
  "sd2.0-480p",
  "sd2.0-720p",
  "motion-video",
  "motion-video-1-5",
  "firefly-seedance2-fast-480p",
  "sd2.0 pro 满血九图卡脸版",
] as const;

/** Models that must remain selectable for the full chain per the task list. */
export const TASK_REQUIRED_NON_MJ_MODEL_IDS = [
  "gpt-image-2-1k",
  "gpt-image-2-ext",
  "image2-A",
  "grok-imagine-image",
  "nano-banana",
  "nano-banana-pro",
  "nano-banana-2",
  "kling-o3-pro-v2v-reference",
  "sd2.0-480p",
] as const;
