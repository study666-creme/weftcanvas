import { describe, expect, it } from "vitest";

import { generationErrorMessage } from "./generation-error";

type Source = Parameters<typeof generationErrorMessage>[0];

function failed(
  message: string,
  billing?: { chargedCreditMicros: number; refunded: boolean },
): Source {
  return {
    status: "failed",
    error: { code: "GENERATION_FAILED", message, retryable: false },
    ...(billing ? { billing } : {}),
  };
}

const REFUNDED_CLAIM = "视频生成失败：未获得最终结果；本次失败将自动退还预扣额度，积分已自动退回";

describe("generation error message refund claims", () => {
  it("keeps the upstream wording when the receipt confirms a refund", () => {
    expect(
      generationErrorMessage(
        failed(REFUNDED_CLAIM, { chargedCreditMicros: 120_000_000, refunded: true }),
      ),
    ).toBe(REFUNDED_CLAIM);
  });

  it("keeps the upstream wording when nothing was charged", () => {
    expect(
      generationErrorMessage(failed(REFUNDED_CLAIM, { chargedCreditMicros: 0, refunded: false })),
    ).toBe(REFUNDED_CLAIM);
  });

  it("exposes an unreconciled charge even when the message never promised a refund", () => {
    // 2026-11-13 complaint: -185 "视频生成超时" with refunded=false.
    const text = generationErrorMessage(
      failed("视频生成超时，请稍后重试。", { chargedCreditMicros: 185_000_000, refunded: false }),
    );
    expect(text).toContain("视频生成超时");
    expect(text).toContain("实扣 185 积分");
    expect(text).toContain("未确认退款");
    expect(text).toContain("联系客服核对");
  });

  it("drops the refund claim and surfaces the real charge when refunded=false", () => {
    const text = generationErrorMessage(
      failed(REFUNDED_CLAIM, { chargedCreditMicros: 120_000_000, refunded: false }),
    );
    expect(text).toContain("未获得最终结果");
    expect(text).toContain("实扣 120 积分");
    expect(text).toContain("未确认退款");
    expect(text).not.toMatch(/退还|退回/);
  });

  it("keeps the failure reason while removing an inline full-refund claim", () => {
    const text = generationErrorMessage(
      failed("UPSTREAM_TIMEOUT · 生图排队超时，积分已全额退回；若仍在生成中可刷新页面尝试恢复", {
        chargedCreditMicros: 6_000_000,
        refunded: false,
      }),
    );
    expect(text).toContain("生图排队超时");
    expect(text).toContain("若仍在生成中可刷新页面尝试恢复");
    expect(text).toContain("实扣 6 积分");
    expect(text).not.toMatch(/退回|退还/);
  });

  it("leaves historical failures untouched when there is no claim and no receipt", () => {
    const message = "长时间无法确认上游任务状态，已停止等待；请重新生成，如已扣费请联系客服核对";
    expect(generationErrorMessage(failed(message))).toBe(message);
  });

  it("downgrades an unverifiable refund claim without a receipt", () => {
    const text = generationErrorMessage(failed("本次扣除的额度已退回。"));
    expect(text).not.toMatch(/退回|退还/);
    expect(text).toContain("未确认退款");
    expect(text).toContain("如已产生扣费请联系客服核对");
  });

  it("does not repeat a customer-service hint the upstream already gave", () => {
    const text = generationErrorMessage(
      failed("生成失败；如已扣费请联系客服核对", {
        chargedCreditMicros: 185_000_000,
        refunded: false,
      }),
    );
    expect(text).toContain("实扣 185 积分");
    expect(text?.match(/联系客服/g)).toHaveLength(1);
  });

  it("compact mode only strips claims for narrow status bars", () => {
    const text = generationErrorMessage(
      failed(REFUNDED_CLAIM, { chargedCreditMicros: 120_000_000, refunded: false }),
      { compact: true },
    );
    expect(text).toBe("视频生成失败：未获得最终结果");
    expect(text).not.toMatch(/实扣|客服|退还|退回/);
  });

  it("falls back when every clause was a refund claim", () => {
    expect(generationErrorMessage(failed("积分已自动退回"), { compact: true })).toBe(
      "生成失败，请重试",
    );
    expect(generationErrorMessage(failed("积分已自动退回"))).toContain("未确认退款");
  });

  it("passes through non-failed jobs and jobs without an error", () => {
    const running: Source = { status: "running", error: null };
    expect(generationErrorMessage(running)).toBeNull();
    const queued: Source = {
      status: "queued",
      error: { code: "GENERATION_FAILED", message: "积分已自动退回", retryable: false },
    };
    expect(generationErrorMessage(queued)).toBe("积分已自动退回");
  });
});
