import { requestConfirmation } from "./confirmation";

/**
 * 消费确认闸门。
 *
 * 任何会产生积分消费的提交都必须先经过这里：用户确认之前不得发起任何请求，
 * 也不得启动自有 API 的生成。Agent / 自动流程永远拿不到这个确认，
 * 因此不存在"未经确认擅自消费"的路径。
 */
export function confirmGenerationSpend(input: {
  modelLabel: string;
  costText: string;
  /** 说明这次提交会做什么，出现在弹窗正文。 */
  detail?: string;
}) {
  return requestConfirmation({
    title: "确认生成并消耗积分？",
    description: `${input.modelLabel} · ${input.costText}`,
    detail: input.detail ?? "只有点「确认生成」才会提交任务并扣除积分；取消不会产生任何消费。",
    confirmLabel: "确认生成",
    cancelLabel: "取消",
    tone: "warning",
  });
}
