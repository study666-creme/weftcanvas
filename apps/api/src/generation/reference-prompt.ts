import type { GenerationJobInput } from "@weftcanvas/contracts";

const REFERENCE_HINT_LINE = /^\s*参考素材按上传顺序\s*[:：][^\r\n]*(?:\r?\n|$)/gmu;
const MARKDOWN_LINK =
  /!?\[([^\]\r\n]{0,120})\]\(\s*((?:(?:https?|blob):[^)\s]+|data:[^)\s]+))\s*\)/giu;
const DATA_URL = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[^,\s]*)?,[^\s<>"'`，。；！？、）】}]+/giu;
const BLOB_URL = /blob:[^\s<>"'`，。；！？、）】}]+/giu;
const LABELED_HTTP_URL =
  /((?:@?(?:图片|视频|音频)\d+)(?:(?:\s*[:：=]\s*)|(?:\s+链接(?:为|是)?\s*)|\s+))(https?:\/\/[^\s<>"'`，。；！？、）】}]+)/giu;
const REFERENCE_LABEL = /^@?(?:图片|视频|音频)\d+$/u;
const REFERENCE_MENTION = /@(?=(?:图片|视频|音频)\d+)/gu;

/**
 * Keeps reference semantics readable while ensuring transport values stay in
 * their dedicated request fields. This also repairs prompts saved by clients
 * that previously embedded reference URLs or media ids in visible text.
 */
export function referenceAwarePrompt(
  value: string,
  inputs: GenerationJobInput,
  resolvedReferences: readonly string[] = [],
) {
  if (!referenceCount(inputs)) return value;
  const styleImages = inputs.styleImages ?? [];
  const elementImages = inputs.elementImages ?? [];

  const transportValues = new Set([
    ...inputs.images,
    ...styleImages,
    ...elementImages,
    ...inputs.videos,
    ...inputs.audios,
    ...resolvedReferences,
  ]);
  let prompt = value
    .replace(REFERENCE_HINT_LINE, "")
    .replace(MARKDOWN_LINK, (match, label: string, target: string) =>
      REFERENCE_LABEL.test(label.trim()) || isLocalTransport(target) || transportValues.has(target)
        ? label.trim()
        : match,
    )
    .replace(DATA_URL, "")
    .replace(BLOB_URL, "")
    .replace(LABELED_HTTP_URL, "$1")
    .replace(REFERENCE_MENTION, "");

  for (const transportValue of transportValues) {
    // Real media ids and hosted refs are opaque, non-trivial values. Avoid
    // erasing short natural-language fragments from a user's prompt.
    if (transportValue.length >= 8) prompt = prompt.split(transportValue).join("");
  }

  prompt = cleanPrompt(prompt);
  const hint = `参考素材按上传顺序：${[
    sequence("图片", inputs.images.length + styleImages.length + elementImages.length),
    sequence("视频", inputs.videos.length),
    sequence("音频", inputs.audios.length),
  ]
    .filter(Boolean)
    .join("；")}`;
  return prompt ? `${prompt}\n${hint}` : hint;
}

function referenceCount(inputs: GenerationJobInput) {
  return (
    inputs.images.length +
    (inputs.styleImages?.length ?? 0) +
    (inputs.elementImages?.length ?? 0) +
    inputs.videos.length +
    inputs.audios.length
  );
}

function sequence(label: string, count: number) {
  return Array.from({ length: count }, (_, index) => `${label}${index + 1}`).join("、");
}

function cleanPrompt(value: string) {
  return value
    .split(/\r?\n/u)
    .map((line) =>
      line
        .replace(/[ \t]+/gu, " ")
        .replace(/\s+([，。；！？])/gu, "$1")
        .trim(),
    )
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isLocalTransport(value: string) {
  return value.startsWith("blob:") || value.startsWith("data:");
}
