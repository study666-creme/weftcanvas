import type { ModelModality, ModelParameter, PublicModel } from "@weftcanvas/contracts";

import {
  isModelBoundTextParameter,
  isModelCompatibilityParameterHidden,
  isModelInternalParameter,
  isModelMediaReferenceParameter,
} from "./generation-config";

const QUICK_PARAMETER_LIMIT = 5;

const QUICK_PARAMETER_PRIORITY: Record<ModelModality, readonly string[]> = {
  // `hd` 是 Midjourney 稳定版的分辨率开关（2K 高清出图），必须和其它常用参数
  // 一样直接出现在紧凑参数条上，否则用户只能靠提示词手写 --hd。
  image: ["aspect_ratio", "aspectRatio", "ratio", "resolution", "size", "quality", "hd"],
  video: [
    "duration_seconds",
    "seconds",
    "duration",
    "aspect_ratio",
    "aspectRatio",
    "ratio",
    "resolution",
    "size",
  ],
  text: ["temperature", "max_tokens", "max_output_tokens"],
  audio: ["voice", "duration", "format"],
};

/** 同一组是同义字段；旧目录也只渲染并提交选定的规范字段。 */
const QUICK_PARAMETER_GROUPS: readonly (readonly string[])[] = [
  ["duration_seconds", "seconds", "duration"],
  ["aspect_ratio", "aspectRatio", "ratio"],
];

export type GenerationParameterGroups = {
  quickParameters: ModelParameter[];
  moreParameters: ModelParameter[];
};

export function partitionGenerationParameters(model: PublicModel): GenerationParameterGroups {
  const visibleParameters = model.parameters.filter(
    (parameter) =>
      !isModelBoundTextParameter(model, parameter) &&
      !isModelInternalParameter(parameter) &&
      !isModelMediaReferenceParameter(model, parameter) &&
      !isModelCompatibilityParameterHidden(model, parameter),
  );
  const priorityByName = new Map(
    QUICK_PARAMETER_PRIORITY[model.modality].map((name, priority) => [name, priority]),
  );
  const groupByName = new Map(
    QUICK_PARAMETER_GROUPS.flatMap((group) => group.map((name) => [name, group] as const)),
  );
  const quickParameters = visibleParameters
    .map((parameter, catalogOrder) => ({ parameter, catalogOrder }))
    .filter(
      ({ parameter }) => !isStructuredParameter(parameter) && priorityByName.has(parameter.name),
    )
    .sort((left, right) => {
      const priorityDifference =
        priorityByName.get(left.parameter.name)! - priorityByName.get(right.parameter.name)!;
      return priorityDifference || left.catalogOrder - right.catalogOrder;
    })
    .filter(({ parameter }, index, items) => {
      const group = groupByName.get(parameter.name);
      if (!group) return true;
      return items.findIndex((item) => groupByName.get(item.parameter.name) === group) === index;
    })
    .slice(0, QUICK_PARAMETER_LIMIT)
    .map(({ parameter }) => parameter);
  const quickParameterSet = new Set(quickParameters);

  return {
    quickParameters,
    moreParameters: visibleParameters.filter((parameter) => !quickParameterSet.has(parameter)),
  };
}

function isStructuredParameter(parameter: ModelParameter) {
  return parameter.type === "array" || parameter.type === "object";
}
