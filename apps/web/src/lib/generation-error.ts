import type { PublicGenerationJob } from "@weftcanvas/contracts";

import { generationBillingText } from "./generation-billing";

type GenerationErrorSource = Pick<PublicGenerationJob, "error" | "billing" | "status">;

/**
 * 上游失败话术里的退款承诺。Prompt Hub 是积分权威方，但它的错误文案是固定
 * 话术：超时、参数错误、状态未确认等失败也会写「积分已自动退回」，而同一份
 * 巡检回执却报 `refunded=false` 且实扣全额（2026-11-13 用户投诉「失败不退款」）。
 * 画布不代客退款，所以只在回执确认退款（或实扣为 0）时保留这类承诺。
 */
const REFUND_CLAIM = /退回|退还|返还|退分|退款|已退/;
const CUSTOMER_SERVICE_HINT = /联系客服|客服核对/;
const CLAUSE_SPLIT = /([，,。；;！!]+)/;

export interface GenerationErrorTextOptions {
  /** 状态栏等窄容器只剥离不可信承诺，不追加核对指引。 */
  compact?: boolean;
}

/**
 * 生成失败时给用户看的错误文案。返回 null 表示没有错误可展示。
 * 只改写「说了退款但账单不支持」或「确实有实扣」的失败任务，其余原样透传。
 */
export function generationErrorMessage(
  job: GenerationErrorSource,
  options: GenerationErrorTextOptions = {},
): string | null {
  const raw = job.error?.message?.trim();
  if (!raw) return null;
  if (job.status && job.status !== "failed") return raw;

  const billing = job.billing;
  const refundConfirmed =
    billing?.refunded === true ||
    (typeof billing?.chargedCreditMicros === "number" && billing.chargedCreditMicros === 0);
  if (refundConfirmed) return raw;

  const claimedRefund = REFUND_CLAIM.test(raw);
  const charged =
    typeof billing?.chargedCreditMicros === "number" && billing.chargedCreditMicros > 0;

  // 上游既没承诺退款、也没回报实扣时，不要给历史失败任务凭空加字。
  if (!claimedRefund && !charged) return raw;

  const stripped = stripRefundClaims(raw);
  if (options.compact) return stripped || "生成失败，请重试";

  const pieces: string[] = [];
  if (stripped) pieces.push(stripped);
  const billingText = charged ? generationBillingText(job) : null;
  if (billingText) pieces.push(billingText);
  if (!CUSTOMER_SERVICE_HINT.test(raw)) {
    pieces.push(
      charged ? "未确认退款，如已扣费请联系客服核对" : "未确认退款，如已产生扣费请联系客服核对",
    );
  }
  return `${pieces.join("；")}。`;
}

/** 按子句剔除退款承诺，保留失败原因本身与原有标点。 */
function stripRefundClaims(message: string): string {
  const parts = message.split(CLAUSE_SPLIT);
  let kept = "";
  for (let index = 0; index < parts.length; index += 2) {
    const clause = (parts[index] ?? "").trim();
    const separator = parts[index + 1] ?? "";
    if (clause && !REFUND_CLAIM.test(clause)) kept += clause + separator;
  }
  return kept
    .replace(/[，,。；;！!\s]+$/, "")
    .replace(/[，,；;]{2,}/g, "，")
    .trim();
}
