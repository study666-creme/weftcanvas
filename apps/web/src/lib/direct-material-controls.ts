import type { MediaKind, ModelInputCount, PublicModel } from "@weftcanvas/contracts";

import type { DirectReference } from "../state/direct-reference-store";
import { getReferenceImagePurposes, referenceImageCapability } from "./generation-inputs";

function modelInput(model: PublicModel, kind: MediaKind) {
  if (kind === "image") return model.input.images;
  if (kind === "video") return model.input.referenceMedia?.videos ?? model.input.videos;
  return model.input.referenceMedia?.audios ?? model.input.audios;
}

function directReferenceMaximum(input: ModelInputCount | undefined, kind: MediaKind) {
  if (!input) return 0;
  const requestLimit = kind === "image" ? 32 : 10;
  const declared = input.max ?? (input.multiple ? requestLimit : 1);
  return Math.max(0, Math.min(requestLimit, input.multiple ? declared : Math.min(1, declared)));
}

/**
 * 素材入口的可用槽位计算，供工作台与首页入口共用。
 * 放在 lib 而不是 direct-generation-studio：首页入口只需要这组纯函数，
 * 从工作台组件文件导入会把整个工作台模块图拖进首屏 entry chunk。
 */
export function directMaterialControls(model: PublicModel | null, references: DirectReference[]) {
  if (!model) return [];
  return [
    {
      kind: "image" as const,
      label: "图片素材",
      accept: "image/png,image/jpeg,image/webp,image/gif,image/avif,image/heif,image/tiff",
    },
    { kind: "video" as const, label: "视频素材", accept: "video/*" },
    { kind: "audio" as const, label: "音频素材", accept: "audio/*" },
  ].flatMap((control) => {
    const input = modelInput(model, control.kind);
    const max = directMaterialMaximum(model, control.kind);
    const hasExisting = references.some((reference) => reference.kind === control.kind);
    return max > 0 || hasExisting
      ? [
          {
            ...control,
            max,
            multiple: control.kind === "image" ? max > 1 : Boolean(input?.multiple),
          },
        ]
      : [];
  });
}

export function directMaterialMaximum(model: PublicModel, kind: MediaKind) {
  if (kind !== "image") return directReferenceMaximum(modelInput(model, kind), kind);
  const imagePurposes = getReferenceImagePurposes(model);
  const slotMaximum = imagePurposes.reduce(
    (total, purpose) =>
      total + directReferenceMaximum(referenceImageCapability(model, purpose), "image"),
    0,
  );
  const aggregateMaximum = model.input.referenceMedia?.maxTotalItems ?? 32;
  return Math.min(slotMaximum, aggregateMaximum, 32);
}
