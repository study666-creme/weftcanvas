import type { PublicGenerationJob } from "@kachang/contracts";

/** 与 API 侧 formatMicros 同一口径，避免同一个数字在两端显示成两个样子。 */
export function formatCreditMicros(value: number) {
  const whole = Math.floor(value / 1_000_000);
  const fraction = String(value % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

/**
 * 上游回执里的实扣文案。报价是预估、实扣才是用户真正付出的积分，两者要分开显示；
 * 没有回执的任务返回 null——绝不用报价冒充一个「实扣」出来。
 */
export function generationBillingText(job: Pick<PublicGenerationJob, "billing">): string | null {
  const billing = job.billing;
  if (!billing) return null;
  const credits = formatCreditMicros(billing.chargedCreditMicros);
  return billing.refunded ? `已退回 ${credits} 积分` : `实扣 ${credits} 积分`;
}
