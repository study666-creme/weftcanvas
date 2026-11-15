import type {
  ModelInputCount,
  ModelModality,
  ModelParameter,
  PublicModel,
} from "@weftcanvas/contracts";

import {
  declaredReferenceKinds,
  type CustomApiRoute,
  type CustomApiRouteParameter,
} from "./custom-api";

/**
 * BYOK（自有 API）的「常用能力」兼容档。
 *
 * 中转站与自建服务的模型列表通常只有一个 ID，能力目录里没有画幅、秒数、分辨率
 * 这些创作参数，更没有「能不能传参考图」的声明；可用户确实要用它们。既然无法预知
 * 上游支持哪些字段，就按常见兼容接口的字段名固定给出选择项，而不是继续由目录决定
 * （目录缺参数时用户连选都没得选）。
 *
 * 用户口径（2026-11-06）：**选项要给够，能不能用用户心里有数**。以前「参数宁缺毋滥、
 * 多一个字段就可能 400」的保守档把参考图入口也一起省掉了，自带 API 的模型因此只能
 * 文生，用户上传了图也无处可放。现在的边界改成：
 *
 * - **默认不发未知字段**：新增的创作参数一律「不填就不下发」（没有 default，也没有
 *   枚举兜底），勾了/填了才进请求；用户不动它们，请求与以前逐字节相同。
 * - **只在没有等价字段时补**：目录/协议档案已经声明了比例、尺寸、时长、参考图就沿用
 *   声明，绝不重复下发。
 * - **参考图入口按素材语义补**：视频补「首帧图（单张）/ 多图参考（数组）」与
 *   「参考视频」，图片补 `images` 数组；字段名不合上游胃口时，设置中心的协议档案
 *   仍可逐项改名或删除——但那属于个别站点的适配，不该让所有人一开始就没有入口。
 *
 * 这些参数只存在于浏览器内存与本次请求里，不参与服务端校验，也不写进任何持久化
 * 契约。
 */

export const CUSTOM_COMMON_ASPECT_RATIOS: readonly string[] = [
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
  "3:2",
  "2:3",
  "21:9",
];
export const CUSTOM_COMMON_IMAGE_RESOLUTIONS: readonly string[] = ["1K", "2K", "4K"];
export const CUSTOM_COMMON_VIDEO_RESOLUTIONS: readonly string[] = ["480p", "720p", "1080p"];
export const CUSTOM_COMMON_VIDEO_SECONDS: readonly string[] = ["5", "8", "10", "12", "15"];

/** 图片模态的参考图上限：与「没有能力目录的自建图片模型」保持一致。 */
export const CUSTOM_COMMON_IMAGE_INPUT: ModelInputCount = { min: 0, max: 16, multiple: true };
/**
 * 视频模态的参考图上限：1 张走首帧字段，2 张以上走多图参考数组（见下面的字段说明）。
 * 4 张覆盖 Seedance / Kling 这类「首帧 + 多图参考」的常见档位，再多上游也不认。
 */
export const CUSTOM_COMMON_VIDEO_IMAGE_INPUT: ModelInputCount = { min: 0, max: 4, multiple: true };

type CommonParameterSpec = {
  /** 界面上的芯片/字段。 */
  parameter: ModelParameter;
  /** 下发字段。 */
  wire: CustomApiRouteParameter;
  /** 目录里出现这些名字（去下划线、小写）就说明概念已声明，不再补。 */
  coverage: readonly string[];
};

/** 去掉下划线与大小写差异后比较：aspectRatio / aspect_ratio / ASPECT_RATIO 同族。 */
function conceptKey(value: string) {
  return value.trim().toLowerCase().replaceAll("_", "");
}

const ASPECT_KEYS = ["aspectratio", "ratio", "size"];
const RESOLUTION_KEYS = ["resolution", "imagesize", "size"];
const DURATION_KEYS = ["seconds", "duration", "durationseconds"];
const NEGATIVE_PROMPT_KEYS = ["negativeprompt", "negative", "negprompt", "negativeprompts"];
const SEED_KEYS = ["seed", "randomseed", "seednumber"];
const WATERMARK_KEYS = ["watermark", "watermarked", "logo", "addwatermark"];
const CAMERA_FIXED_KEYS = ["camerafixed", "fixedcamera", "staticcamera", "enablecamerafixed"];
const GENERATE_AUDIO_KEYS = ["generateaudio", "withaudio", "generatesound"];

function enumParameter(
  name: string,
  label: string,
  options: readonly string[],
  defaultValue: string,
): ModelParameter {
  return {
    name,
    label,
    type: "string",
    required: false,
    default: defaultValue,
    options: [...options],
    mutuallyExclusiveWith: [],
  };
}

function enumSpec(
  name: string,
  label: string,
  options: readonly string[],
  defaultValue: string,
  coverage: readonly string[],
): CommonParameterSpec {
  return {
    parameter: enumParameter(name, label, options, defaultValue),
    wire: { name, path: name, type: "string" },
    coverage,
  };
}

/**
 * 「不填就不下发」的自由参数：没有 default、没有 options 兜底，用户不动它，
 * 请求里就不会出现这个键。这是本次把选项给够的前提——多出来的字段不能自己跑进请求。
 */
function optInSpec(
  parameter: Omit<ModelParameter, "mutuallyExclusiveWith">,
  coverage: readonly string[],
): CommonParameterSpec {
  return {
    parameter: { ...parameter, mutuallyExclusiveWith: [] },
    wire: {
      name: parameter.name,
      path: parameter.name,
      type:
        parameter.type === "integer" || parameter.type === "number"
          ? "number"
          : parameter.type === "boolean"
            ? "boolean"
            : "string",
    },
    coverage,
  };
}

function negativePromptSpec(label = "负面提示词"): CommonParameterSpec {
  return optInSpec(
    {
      name: "negative_prompt",
      label,
      description: "不想出现的内容；留空则不下发，按上游默认处理。",
      type: "string",
      required: false,
      maxLength: 2_000,
    },
    NEGATIVE_PROMPT_KEYS,
  );
}

function seedSpec(): CommonParameterSpec {
  return optInSpec(
    {
      name: "seed",
      label: "随机种子",
      description: "固定种子便于复现同一结果；留空则不下发，由上游随机。",
      type: "integer",
      required: false,
      min: 0,
      max: 2_147_483_647,
      step: 1,
    },
    SEED_KEYS,
  );
}

function watermarkSpec(): CommonParameterSpec {
  return optInSpec(
    { name: "watermark", label: "水印", type: "boolean", required: false },
    WATERMARK_KEYS,
  );
}

function cameraFixedSpec(): CommonParameterSpec {
  return optInSpec(
    {
      name: "camera_fixed",
      label: "固定镜头",
      description: "锁定机位，不做运镜；未勾选时不下发。",
      type: "boolean",
      required: false,
    },
    CAMERA_FIXED_KEYS,
  );
}

function generateAudioSpec(): CommonParameterSpec {
  return optInSpec(
    {
      name: "generate_audio",
      label: "生成音频",
      description: "让视频同时产出声音；未勾选时不下发。",
      type: "boolean",
      required: false,
    },
    GENERATE_AUDIO_KEYS,
  );
}

function commonSpecs(modality: ModelModality): CommonParameterSpec[] {
  if (modality === "image") {
    return [
      enumSpec("aspect_ratio", "画面比例", CUSTOM_COMMON_ASPECT_RATIOS, "1:1", ASPECT_KEYS),
      enumSpec("resolution", "分辨率", CUSTOM_COMMON_IMAGE_RESOLUTIONS, "1K", RESOLUTION_KEYS),
      negativePromptSpec(),
      seedSpec(),
      watermarkSpec(),
    ];
  }
  if (modality === "video") {
    return [
      enumSpec("aspect_ratio", "画面比例", CUSTOM_COMMON_ASPECT_RATIOS, "16:9", ASPECT_KEYS),
      enumSpec("resolution", "分辨率", CUSTOM_COMMON_VIDEO_RESOLUTIONS, "720p", RESOLUTION_KEYS),
      enumSpec("seconds", "时长（秒）", CUSTOM_COMMON_VIDEO_SECONDS, "5", DURATION_KEYS),
      negativePromptSpec(),
      seedSpec(),
      watermarkSpec(),
      cameraFixedSpec(),
      generateAudioSpec(),
    ];
  }
  // 文本/音频没有跨厂商通用的画幅、时长与参考图字段，宁可不给。
  return [];
}

/** 该模型已经声明过的字段（UI 参数名 + 下发点路径末段）。 */
function declaredConcepts(model: PublicModel, route: CustomApiRoute) {
  const keys = new Set<string>();
  for (const parameter of route.parameters) {
    keys.add(conceptKey(parameter.name));
    const lastSegment = parameter.path.split(".").at(-1);
    if (lastSegment) keys.add(conceptKey(lastSegment));
  }
  for (const parameter of model.parameters) keys.add(conceptKey(parameter.name));
  return keys;
}

function isCovered(spec: CommonParameterSpec, declared: Set<string>) {
  return spec.coverage.some((key) => declared.has(key));
}

/** 模型侧是否已经声明过任何图片输入（含风格图/元素图这类分用途槽位）。 */
function hasDeclaredImageInput(model: PublicModel) {
  const referenceMedia = model.input.referenceMedia;
  return Boolean(
    model.input.images ||
    referenceMedia?.images ||
    referenceMedia?.styleImages ||
    referenceMedia?.elementImages,
  );
}

function hasDeclaredVideoInput(model: PublicModel) {
  return Boolean(model.input.videos || model.input.referenceMedia?.videos);
}

/**
 * 参考素材入口：目录没声明就按兼容字段补一份。
 *
 * - 视频模型：`image`（单张，首帧/参考图）+ `reference_images`（多图参考，字符串数组）。
 *   一张图走首帧字段、多张走多图参考数组——这是兼容接口里最常见的两种表达，且两者
 *   同时只会有一种被下发（绑定逻辑按数量二选一）。
 * - 视频模型另有 `video`（单条参考视频），支持「视频生视频 / 视频延长」的站点直接可用。
 * - 图片模型：`images` 数组，允许 data URL（走 `uri-or-data-image`），不要求公网可访问，
 *   与没有能力目录的自建图片模型完全一致。
 *
 * 只有在我们补了字段时才声明对应的输入槽位：`model.input` 是素材入口的唯一开关，
 * 声明了才会出现上传控件，也才会通过提交前的数量校验。
 */
function withCommonMedia(
  model: PublicModel,
  route: CustomApiRoute,
): { model: PublicModel; route: CustomApiRoute } {
  const declaredKinds = declaredReferenceKinds(route);
  const wire: CustomApiRouteParameter[] = [];
  const input: PublicModel["input"] = { ...model.input };

  if (model.modality === "video") {
    if (!declaredKinds.has("image") && !hasDeclaredImageInput(model)) {
      wire.push(
        { name: "image", path: "image", type: "string", format: "public-http-url" },
        {
          name: "reference_images",
          path: "reference_images",
          type: "array",
          itemsFormat: "public-http-url",
        },
      );
      input.images = CUSTOM_COMMON_VIDEO_IMAGE_INPUT;
    }
    if (!declaredKinds.has("video") && !hasDeclaredVideoInput(model)) {
      wire.push({ name: "video", path: "video", type: "string", format: "public-http-url" });
      input.videos = { min: 0, max: 1, multiple: false };
    }
  } else if (model.modality === "image") {
    if (!declaredKinds.has("image") && !hasDeclaredImageInput(model)) {
      wire.push({
        name: "images",
        path: "images",
        type: "array",
        itemsFormat: "uri-or-data-image",
      });
      input.images = CUSTOM_COMMON_IMAGE_INPUT;
    }
  }

  if (!wire.length) return { model, route };
  return {
    model: { ...model, input },
    route: { ...route, parameters: [...route.parameters, ...wire] },
  };
}

/**
 * 给自定义模型补上常用参数与参考素材：模型侧出芯片（UI）与输入槽位，路由侧出下发字段。
 * 路由为 null（模型没有可用协议）时原样返回——那种模型本来就生成不了。
 */
export function withCommonCustomParameters(
  model: PublicModel,
  route: CustomApiRoute | null,
): { model: PublicModel; route: CustomApiRoute | null } {
  if (!route) return { model, route };
  const declared = declaredConcepts(model, route);
  const additions = commonSpecs(model.modality).filter((spec) => !isCovered(spec, declared));
  const withParameters = additions.length
    ? {
        model: {
          ...model,
          parameters: [...model.parameters, ...additions.map((item) => item.parameter)],
        },
        route: {
          ...route,
          parameters: [...route.parameters, ...additions.map((item) => item.wire)],
        },
      }
    : { model, route };
  return withCommonMedia(withParameters.model, withParameters.route);
}
