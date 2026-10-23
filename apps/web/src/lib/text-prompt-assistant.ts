import type { PublicModel } from "@weftcanvas/contracts";

/**
 * 文本节点的两个提示词助手任务。它们都只是一次普通的文本模型调用：
 * 输入是「指令 + 节点正文」，输出仍是文本，由既有生成管线写回画布节点。
 *
 * - `optimize`：把节点里已有的提示词改写得更有可执行细节，结果替换原节点正文；
 * - `derive`：从一段创作文本（故事、设定、想法）提炼生成提示词，结果落到
 *   右侧新建的文本节点，原文本保持不变。
 */
export type TextPromptTask = "optimize" | "derive";

export const textPromptTaskLabels: Record<TextPromptTask, string> = {
  optimize: "优化提示词",
  derive: "根据文本生成提示词",
};

const PROMPT_SOURCE_LIMIT = 8_000;

function clampSource(source: string) {
  return source.trim().slice(0, PROMPT_SOURCE_LIMIT);
}

/**
 * 组合交给文本模型的完整指令。分隔符用三引号，并明确「只输出正文」，
 * 让结果可以直接作为画布提示词使用，不再需要人工删标题/引号。
 */
export function composeTextPromptTask(task: TextPromptTask, source: string): string {
  const text = clampSource(source);
  if (!text) return "";
  if (task === "optimize") {
    return [
      "你是画布上的提示词编辑。请优化下面这段提示词。",
      "要求：",
      "1. 保留原有主体、意图、语言与关键设定，不要更换主体或加入原内容没有的品牌；",
      "2. 补足镜头、构图、光线、材质、风格与氛围等可执行细节；",
      "3. 删除空泛、重复、互相矛盾的表述；",
      "4. 只输出优化后的提示词正文，不要解释、不要分点、不要加标题或引号。",
      "",
      "原提示词：",
      '"""',
      text,
      '"""',
    ].join("\n");
  }
  return [
    "你是画布上的提示词编辑。请根据下面这段创作文本，提炼一条可直接用于 AI 图片或视频生成的提示词。",
    "要求：",
    "1. 保留文本中的主体、场景、动作、情绪与关键情节，不要杜撰人物关系；",
    "2. 补足镜头、构图、光线、材质、色彩与风格等可执行细节；",
    "3. 只输出一条提示词正文，不要解释、不要分点、不要加标题或引号。",
    "",
    "创作文本：",
    '"""',
    text,
    '"""',
  ].join("\n");
}

/**
 * 选择这次助手调用使用的文本模型：节点上显式选过的模型优先，其次沿用
 * 创作者上次用过的文本模型，最后取目录第一项。目录为空时返回 null，
 * 界面必须显示「没有可用文本模型」，不能假装能跑。
 */
export function resolveTextPromptModel(
  models: readonly PublicModel[],
  preferredId: string | null | undefined,
  rememberedId?: string | null,
): PublicModel | null {
  const textModels = models.filter((model) => model.modality === "text");
  if (!textModels.length) return null;
  return (
    textModels.find((model) => model.id === preferredId) ??
    (rememberedId ? textModels.find((model) => model.id === rememberedId) : undefined) ??
    textModels[0] ??
    null
  );
}

/**
 * 平台文本模型在托管通道里没有执行链（API 的 `submitOnce` 只放行 image/video），
 * 提交必然失败。把「暂不支持这个模型类型」原样丢给用户等于没说，这里换成可执行
 * 的下一步：去 Agent 对话，或换成自有 API 的文本模型。
 */
export const UNSUPPORTED_TEXT_CHANNEL =
  "平台文本模型还没接入画布生成：请用右侧 Agent 对话，或在「自有 API」里配置一个文本模型";

/** 失败文案：通道不支持文本时给出可执行的下一步，其余保留接口原文。 */
export function describeTextAssistantFailure(cause: unknown, fallback: string) {
  const code = (cause as { code?: unknown } | null)?.code;
  if (code === "MODEL_MODALITY_UNAVAILABLE") return UNSUPPORTED_TEXT_CHANNEL;
  return cause instanceof Error ? cause.message : fallback;
}
