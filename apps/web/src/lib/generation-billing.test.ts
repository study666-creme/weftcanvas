import { describe, expect, it } from "vitest";

import { formatCreditMicros, generationBillingText } from "./generation-billing";

describe("generation billing text", () => {
  it("formats the upstream receipt with the same precision as the quote", () => {
    expect(formatCreditMicros(322_920_000)).toBe("322.92");
    expect(formatCreditMicros(9_687_600_000)).toBe("9687.6");
    expect(formatCreditMicros(3_100_630)).toBe("3.10063");
    expect(formatCreditMicros(0)).toBe("0");
  });

  it("separates the actual charge from the estimate and reports refunds", () => {
    expect(
      generationBillingText({ billing: { chargedCreditMicros: 322_920_000, refunded: false } }),
    ).toBe("实扣 322.92 积分");
    expect(
      generationBillingText({ billing: { chargedCreditMicros: 322_920_000, refunded: true } }),
    ).toBe("已退回 322.92 积分");
  });

  it("shows nothing when the upstream never reported a charge", () => {
    // 没有回执就不说「实扣」——报价是预估，不能拿来冒充真实扣费。
    expect(generationBillingText({})).toBeNull();
  });
});
