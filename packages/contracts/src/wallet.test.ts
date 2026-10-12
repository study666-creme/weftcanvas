import { describe, expect, it } from "vitest";

import { walletLedgerResponseSchema, walletLedgerUpstreamResponseSchema } from "./wallet.js";

const NOW = "2026-08-10T08:00:00.000Z";

function item(overrides: Record<string, unknown> = {}) {
  return {
    id: "ledger-1",
    delta: -400,
    balanceAfter: 1200,
    reason: "reservation",
    reasonLabel: "生成预留",
    refId: "job-1",
    meta: null,
    createdAt: NOW,
    ...overrides,
  };
}

function envelope(data: unknown, ok: unknown = true) {
  return { ok, data };
}

describe("wallet ledger upstream compatibility", () => {
  it("parses the current payment-service shape with the items array under data", () => {
    const parsed = walletLedgerUpstreamResponseSchema.parse(
      envelope([
        item(),
        item({
          id: "ledger-2",
          delta: -360,
          balanceAfter: 840,
          reason: "settlement",
          reasonLabel: "生成结算",
        }),
        item({
          id: "ledger-3",
          delta: 360,
          balanceAfter: 1200,
          reason: "refund",
          reasonLabel: "生成退款",
        }),
      ]),
    );
    expect(parsed.data.items).toHaveLength(3);
    expect(parsed.data.items[0]).toEqual(item());
  });

  it("keeps the old data.items wrapper working", () => {
    const parsed = walletLedgerUpstreamResponseSchema.parse(envelope({ items: [item()] }));
    expect(parsed.data.items).toEqual([item()]);
  });

  it("accepts a data.list wrapper", () => {
    const parsed = walletLedgerUpstreamResponseSchema.parse(envelope({ list: [item()] }));
    expect(parsed.data.items).toEqual([item()]);
  });

  it("derives bounded display fields when entry kinds omit them", () => {
    const parsed = walletLedgerUpstreamResponseSchema.parse(
      envelope([
        {
          id: "ledger-t",
          delta: -400,
          balanceAfter: 800,
          type: "reservation",
          createdAt: NOW,
        },
      ]),
    );
    expect(parsed.data.items[0]).toMatchObject({
      id: "ledger-t",
      delta: -400,
      balanceAfter: 800,
      reason: "reservation",
      reasonLabel: "reservation",
      refId: null,
      meta: null,
      createdAt: NOW,
    });
  });

  it("keeps an upstream-provided reason and reasonLabel when present", () => {
    const parsed = walletLedgerUpstreamResponseSchema.parse(
      envelope([
        {
          ...item(),
          reason: "settle",
          reasonLabel: "生成结算",
          refId: "job-9",
          meta: { order: "PAY1" },
        },
      ]),
    );
    expect(parsed.data.items[0]).toMatchObject({
      reason: "settle",
      reasonLabel: "生成结算",
      refId: "job-9",
      meta: { order: "PAY1" },
    });
  });

  it("bounds deep, oversized, and non-JSON-safe upstream meta", () => {
    const deep = { level1: { level2: { level3: { level4: { level5: "too deep" } } } } };
    const oversized = { values: Array.from({ length: 128 }, (_, index) => `value-${index}`) };
    const longString = "x".repeat(10_000);
    const parsed = walletLedgerUpstreamResponseSchema.parse(
      envelope([
        item({
          meta: { deep, oversized, longString, number: 12.5, flag: true, invalid: Number.NaN },
        }),
      ]),
    );
    const meta = parsed.data.items[0]!.meta as Record<string, unknown>;
    const boundedDeep = meta.deep as Record<string, unknown>;
    const level1 = boundedDeep.level1 as Record<string, unknown>;
    const level2 = level1.level2 as Record<string, unknown>;
    expect(level2.level3).toBeNull();
    const values = (meta.oversized as { values: unknown[] }).values;
    expect(values).toHaveLength(32);
    expect(values[31]).toBe("value-31");
    expect(meta.longString).toBe("x".repeat(240));
    expect(meta.number).toBe(12.5);
    expect(meta.flag).toBe(true);
    expect(meta.invalid).toBeNull();
  });

  it("drops non-object meta instead of carrying it into the canonical item", () => {
    const parsed = walletLedgerUpstreamResponseSchema.parse(
      envelope([item({ meta: ["a", "b"] }), item({ meta: "raw-string" }), item({ meta: 42 })]),
    );
    expect(parsed.data.items[0]!.meta).toBeNull();
    expect(parsed.data.items[1]!.meta).toBeNull();
    expect(parsed.data.items[2]!.meta).toBeNull();
  });

  it("rejects error envelopes and non-ok payloads", () => {
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(envelope({ items: [item()] }, false)).success,
    ).toBe(false);
    expect(
      walletLedgerUpstreamResponseSchema.safeParse({
        ok: true,
        data: { items: [item()] },
        error: { code: "X", message: "unexpected" },
      }).success,
    ).toBe(true);
  });

  it("rejects items missing critical financial fields", () => {
    for (const missing of ["id", "delta", "balanceAfter", "createdAt"]) {
      const value = { ...item() } as Record<string, unknown>;
      delete value[missing];
      expect(
        walletLedgerUpstreamResponseSchema.safeParse(envelope({ items: [value] })).success,
        `missing ${missing}`,
      ).toBe(false);
    }
  });

  it("rejects non-finite and string deltas but accepts negative balances", () => {
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(
        envelope({ items: [item({ delta: Number.NaN })] }),
      ).success,
    ).toBe(false);
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(
        envelope({ items: [item({ delta: Number.POSITIVE_INFINITY })] }),
      ).success,
    ).toBe(false);
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(envelope({ items: [item({ delta: "-400" })] }))
        .success,
    ).toBe(false);
    // 运营追回可以把余额扣成负数：契约必须放行，否则受影响用户的流水整页解析失败。
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(
        envelope({ items: [item({ balanceAfter: -1 })] }),
      ).success,
    ).toBe(true);
  });

  it("rejects malformed dates and oversized lists", () => {
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(
        envelope({ items: [item({ createdAt: "2026-08-10" })] }),
      ).success,
    ).toBe(false);
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(
        envelope({ items: [item({ createdAt: "yesterday" })] }),
      ).success,
    ).toBe(false);
    const oversized = Array.from({ length: 51 }, (_, index) => item({ id: `ledger-${index}` }));
    expect(walletLedgerUpstreamResponseSchema.safeParse(envelope(oversized)).success).toBe(false);
    expect(
      walletLedgerUpstreamResponseSchema.safeParse(envelope(oversized.slice(0, 50))).success,
    ).toBe(true);
  });

  it("rejects non-array data and unknown envelopes", () => {
    expect(walletLedgerUpstreamResponseSchema.safeParse({ ok: true, data: null }).success).toBe(
      false,
    );
    expect(walletLedgerUpstreamResponseSchema.safeParse({ ok: true, data: {} }).success).toBe(
      false,
    );
    expect(
      walletLedgerUpstreamResponseSchema.safeParse({ ok: true, data: { records: [item()] } })
        .success,
    ).toBe(false);
    expect(walletLedgerUpstreamResponseSchema.safeParse({ ok: true }).success).toBe(false);
    expect(walletLedgerUpstreamResponseSchema.safeParse(null).success).toBe(false);
  });

  it("never carries unknown or private item fields into the canonical item", () => {
    const parsed = walletLedgerUpstreamResponseSchema.parse(
      envelope([
        {
          ...item(),
          user_id: "private-user",
          access_token: "secret",
          internal_note: "do not leak",
          balanceAfter: 1200,
        },
      ]),
    );
    const canonical = parsed.data.items[0]!;
    expect(JSON.stringify(canonical)).not.toContain("private-user");
    expect(JSON.stringify(canonical)).not.toContain("secret");
    expect(JSON.stringify(canonical)).not.toContain("do not leak");
    expect(Object.keys(canonical).sort()).toEqual([
      "balanceAfter",
      "createdAt",
      "delta",
      "id",
      "meta",
      "reason",
      "reasonLabel",
      "refId",
    ]);
  });
});

describe("wallet ledger public contract", () => {
  it("stays stable for canonical ledger responses", () => {
    const parsed = walletLedgerResponseSchema.parse(envelope({ items: [item()] }));
    expect(parsed.data.items).toEqual([item()]);
  });
});
