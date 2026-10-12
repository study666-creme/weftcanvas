import type { ImageLoadResult, LoadedImageAsset } from "./bounded-image-loader";

/**
 * 瞬时失败后的自愈退避表：共 4 次额外尝试（约 37 秒）。
 *
 * 有界加载器自己的重试预算（默认 12s × 3 + 原生兜底）在慢的对象存储上可能
 * 早于服务端的派生对象就绪——画布节点展示的是 `variant=thumb`，而缩略图是
 * 服务端首次访问时才惰性生成的。此时正确的界面行为是继续「正在载入」并
 * 自动重试，而不是给用户弹一个假的「结果加载失败」；一旦某次成功，节点原地
 * 显示，不需要悬停/选中/刷新去触发重新请求。
 */
export const TRANSIENT_IMAGE_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 20_000] as const;

export type ImageLoadDecision =
  | { action: "show"; asset: LoadedImageAsset }
  | { action: "retry"; delayMs: number }
  | { action: "error" }
  | { action: "ignore" };

/**
 * 把一次有界加载结果翻译成界面动作：
 * - 成功 → 显示；
 * - 确定性失败（404/409/解码失败）→ 立即错误，重试无意义；
 * - 瞬时失败（超时/网络/可重试状态码）→ 退避重试，预算用尽才落错误态；
 * - 未持有失败原因（引用被释放/主动清空）→ 不改变任何状态。
 */
export function decideImageLoadOutcome(
  result: ImageLoadResult,
  retryAttempt: number,
): ImageLoadDecision {
  if (result.asset) return { action: "show", asset: result.asset };
  if (result.failure === "permanent") return { action: "error" };
  if (result.failure !== "transient") return { action: "ignore" };
  const delayMs = TRANSIENT_IMAGE_RETRY_DELAYS_MS[retryAttempt];
  if (delayMs === undefined) return { action: "error" };
  return { action: "retry", delayMs };
}
