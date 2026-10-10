/**
 * H3 系列的上游视频路线要求参考视频必须同时声明时长。目录给 minimax_h3 等
 * 模型发布了 `referenceVideoDurations` 参数（required_with: referenceVideos、
 * aligned_with: referenceVideos、最多 3 个、合计不超过 15 秒），只发
 * referenceVideos 不发音长的请求会被上游整单按 400 拒绝——线上表现为画布
 * 视频节点一连上参考视频就「请求参数无效」，而其他入口不传参考视频，所以一直
 * 看起来正常。参考视频本身按该模型的每秒价格另行计费（目录描述原文），报价
 * 侧因此也要把这部分秒数算进预扣。
 *
 * 这些约束里只有参数名和每模型秒价投影到了公开目录（required_with、
 * max_total 等没有进公开参数表），所以上限按目录口径在这里钉住，费率则一律
 * 从实时目录读，不写死。
 */
export const REFERENCE_VIDEO_DURATIONS_PARAMETER = "referenceVideoDurations";

/** 目录里 referenceVideos.max_total_duration_seconds / max_total 的口径。 */
export const MAX_REFERENCE_VIDEO_TOTAL_SECONDS = 15;

export function declaresReferenceVideoDurations(model: { parameters?: readonly { name: string }[] }) {
  return (model.parameters ?? []).some((parameter) => parameter.name === REFERENCE_VIDEO_DURATIONS_PARAMETER);
}

/**
 * 毫秒转秒，保留两位小数——上游按整秒计价，秒级以下的精度对计费和时长声明
 * 都没有意义，截断还能避免浮点尾差把 4.999999 报成超限。
 */
export function durationSeconds(durationMs: number | null | undefined) {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs <= 0) return null;
  return Math.round(durationMs / 10) / 100;
}

/**
 * 把客户端或素材元数据带来的时长归一成「有限正数」的秒数组；结构不对（非数字、
 * 非正数）一律返回 null，由调用方给出面向用户的错误。单条超长交给合计校验报，
 * 错误信息只说一条「总时长」规则，不逼用户分辨是哪一条先炸。
 */
export function sanitizeReferenceVideoDurations(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const durations: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry <= 0) return null;
    durations.push(Math.round(entry * 100) / 100);
  }
  return durations;
}

export function sumReferenceVideoDurations(durations: readonly number[]) {
  return durations.reduce((total, seconds) => total + seconds, 0);
}
