import type { ModelModality, ModelParameter, PublicModel } from "@weftcanvas/contracts";

import type { CustomApiRoute, CustomApiRouteParameter } from "./custom-api";

/**
 * BYOK（自有 API）的「常用参数」兼容档。
 *
 * 中转站与自建服务的模型列表通常只有一个 ID，能力目录里没有画幅、秒数、分辨率
 * 这些创作参数；可用户确实要用它们。既然无法预知上游支持哪些字段，就按常见兼容
 * 接口的字段名固定给出常用值供用户自选，而不是继续由目录决定（目录缺参数时用户
 * 连选都没得选）。
 *
 * 两条边界：
 * - **只在没有等价字段时补**：目录/协议档案已经声明了比例、尺寸或时长（含
 *   `size`、`image_size`、`duration_seconds` 这些别名）就沿用声明，绝不重复下发；
 *   多一个上游不认的字段就可能让整条请求 400。
 * - **默认值就是芯片上高亮的那一项**：每档都有明确默认（图片 1:1 / 1K，视频
 *   16:9 / 720p / 5 秒），所见即所发；用户不想改就直接生成，想改在同一组芯片里点。
 *   上游不认这些字段时，设置中心的协议档案仍可逐项改名或删除。
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

type CommonParameterName = "aspect_ratio" | "resolution" | "seconds";

type CommonParameterSpec = {
  name: CommonParameterName;
  label: string;
  options: readonly string[];
  default: string;
};

/** 去掉下划线与大小写差异后比较：aspectRatio / aspect_ratio / ASPECT_RATIO 同族。 */
function conceptKey(value: string) {
  return value.trim().toLowerCase().replaceAll("_", "");
}

const ASPECT_KEYS = new Set(["aspectratio", "ratio", "size"]);
const RESOLUTION_KEYS = new Set(["resolution", "imagesize", "size"]);
const DURATION_KEYS = new Set(["seconds", "duration", "durationseconds"]);

const COVERAGE: Record<CommonParameterName, Set<string>> = {
  aspect_ratio: ASPECT_KEYS,
  resolution: RESOLUTION_KEYS,
  seconds: DURATION_KEYS,
};

function commonSpecs(modality: ModelModality): CommonParameterSpec[] {
  if (modality === "image") {
    return [
      {
        name: "aspect_ratio",
        label: "画面比例",
        options: CUSTOM_COMMON_ASPECT_RATIOS,
        default: "1:1",
      },
      {
        name: "resolution",
        label: "分辨率",
        options: CUSTOM_COMMON_IMAGE_RESOLUTIONS,
        default: "1K",
      },
    ];
  }
  if (modality === "video") {
    return [
      {
        name: "aspect_ratio",
        label: "画面比例",
        options: CUSTOM_COMMON_ASPECT_RATIOS,
        default: "16:9",
      },
      {
        name: "resolution",
        label: "分辨率",
        options: CUSTOM_COMMON_VIDEO_RESOLUTIONS,
        default: "720p",
      },
      {
        name: "seconds",
        label: "时长（秒）",
        options: CUSTOM_COMMON_VIDEO_SECONDS,
        default: "5",
      },
    ];
  }
  // 文本/音频没有跨厂商通用的画幅与时长字段，宁可不给。
  return [];
}

/**
 * 该模型已经声明过的字段（UI 参数名 + 下发点路径末段）。
 * 任意一层声明了等价字段，就说明上游对这个概念有自己的表达，不再补。
 */
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
  for (const key of COVERAGE[spec.name]) if (declared.has(key)) return true;
  return false;
}

/**
 * 给自定义模型补上常用参数：模型侧出芯片（UI），路由侧出下发字段（wire）。
 * 路由为 null（模型没有可用协议）时原样返回——那种模型本来就生成不了。
 */
export function withCommonCustomParameters(
  model: PublicModel,
  route: CustomApiRoute | null,
): { model: PublicModel; route: CustomApiRoute | null } {
  if (!route) return { model, route };
  const declared = declaredConcepts(model, route);
  const additions = commonSpecs(model.modality).filter((spec) => !isCovered(spec, declared));
  if (!additions.length) return { model, route };

  const uiParameters: ModelParameter[] = additions.map((spec) => ({
    name: spec.name,
    label: spec.label,
    type: "string",
    required: false,
    default: spec.default,
    options: [...spec.options],
    mutuallyExclusiveWith: [],
  }));
  const wireParameters: CustomApiRouteParameter[] = additions.map((spec) => ({
    name: spec.name,
    path: spec.name,
    type: "string",
  }));

  return {
    model: { ...model, parameters: [...model.parameters, ...uiParameters] },
    route: { ...route, parameters: [...route.parameters, ...wireParameters] },
  };
}
