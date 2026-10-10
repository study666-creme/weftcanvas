/**
 * 视频可执行性对齐。
 *
 * 卡藏目录（newapi）是**上架/定价**权威，执行器目录（Prompt Hub 的
 * `/api/v1/model-catalog`）才是**可执行**权威——它按「这个模型当前有没有可用
 * 渠道」做了 fail-closed 过滤（newapi.ts 的 `publicNewApiRoutedCatalogModels`）。
 *
 * 两边并不一致。实测 2026-10-01：卡藏发布 31 条视频、执行器只接 23 条。差集里
 * 的 token 计费 Seedance 系（doubao-seedance-2.0 / seedance-2.0 / -fast / -mini /
 * 2.5）报价能通过、点「生成」才由执行器回 `MODEL_UNAVAILABLE`，用户白等一轮并
 * 看到「模型不可用」。这就是「模型明明在用、却因两端不一致而用不了」的来源。
 *
 * 两端偶尔用不同 id 指同一个模型（执行器把 Grok 视频发布成 `motion-video`，
 * 卡藏叫 `grok-imagine-video`），所以需要一张显式映射表；漏掉它会把本来能跑的
 * 模型误杀。映射只收「同一模型、两边取名不同」的情况，不做猜测。
 */

/** 执行器 id → 它实际覆盖的卡藏 id。 */
const EXECUTOR_VIDEO_ID_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "motion-video": ["grok-imagine-video"],
  "motion-video-1-5": ["grok-imagine-video-1.5"],
};

/**
 * 把执行器目录里的视频 id 展开成 Canvas 侧的等价 id 集合。
 * 额外的别名 id 只在该执行器 id 确实存在时展开，避免凭空放行。
 */
export function expandExecutorVideoIds(executorVideoIds: readonly string[]): string[] {
  const ids = new Set(executorVideoIds);
  for (const [executorId, covered] of Object.entries(EXECUTOR_VIDEO_ID_ALIASES)) {
    if (!ids.has(executorId)) continue;
    for (const id of covered) ids.add(id);
  }
  return [...ids];
}

/** 交给 filterVideoModels 的可用性注解：白名单 + 显式下架。 */
export function executorAvailability(input: {
  executorVideoIds: readonly string[];
  disabledVideoIds?: readonly string[];
  validatedAt: number;
}) {
  return {
    publicModelIds: expandExecutorVideoIds(input.executorVideoIds).sort(),
    disabledModelIds: [...new Set(input.disabledVideoIds ?? [])].sort(),
    validatedAt: input.validatedAt,
  };
}
