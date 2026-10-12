import { z } from "zod";

const nullableDateTime = z.string().datetime({ offset: true }).nullable();

export const walletMembershipSchema = z.object({
  tier: z.string().trim().min(1).max(32).nullable(),
  until: nullableDateTime,
  queuedTier: z.string().trim().min(1).max(32).nullable().default(null),
  queuedUntil: nullableDateTime.default(null),
  active: z.boolean(),
  genDiscount: z.string().trim().max(120).nullable(),
});

export const walletSummarySchema = z.object({
  // Balances may be negative: an operator recovery can deduct an undercharge
  // past zero, and generation stays blocked by the credit RPC either way.
  credits: z.number().finite(),
  creditsPermanent: z.number().finite(),
  dailyCredits: z.number().finite().nonnegative(),
  creditGrantMode: z.enum(["daily", "bundle"]).nullable(),
  dailyCreditsNote: z.string().trim().max(240).nullable(),
  membership: walletMembershipSchema,
  lifetimeCreditsSpent: z.number().finite().nonnegative(),
});
export type WalletSummary = z.infer<typeof walletSummarySchema>;

export const walletResponseSchema = z.object({
  ok: z.literal(true),
  data: walletSummarySchema,
});

export const walletLedgerItemSchema = z.object({
  id: z.string().min(1).max(160),
  delta: z.number().finite(),
  balanceAfter: z.number().finite(),
  reason: z.string().trim().min(1).max(80),
  reasonLabel: z.string().trim().min(1).max(120),
  refId: z.string().trim().max(160).nullable(),
  meta: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime({ offset: true }),
});
export type WalletLedgerItem = z.infer<typeof walletLedgerItemSchema>;

export const walletLedgerResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ items: z.array(walletLedgerItemSchema).max(50) }),
});

/**
 * Server-only input normalization for the Prompt Hub `/api/v1/me/ledger`
 * success response.
 *
 * The payment service historically wrapped the list as `data.items`; its list
 * endpoints now expose the items array directly under `data` (the same
 * envelope style the products endpoint uses). This preprocess accepts the old
 * `{ data: { items } }` form, the current bare `data: [...]` form, and a
 * `{ data: { list } }` wrapper, and always returns the canonical
 * `{ data: { items } }` shape so the public `walletLedgerResponseSchema`
 * stays stable.
 *
 * Critical financial fields (`id`, `delta`, `balanceAfter`, `createdAt`)
 * remain required and fail closed. Display-only fields that some entry kinds
 * omit (`reason`, `reasonLabel`, `refId`, `meta`) receive bounded neutral
 * defaults instead of rejecting the whole list; the machine kind falls back to
 * the upstream `type` value when `reason` is absent. Unknown/private fields on
 * an item are never carried into the canonical item, so they cannot leak to a
 * browser response.
 *
 * The public contract allows arbitrary `meta` values, so the passthrough is
 * bounded here at the server boundary: nesting depth, entries per object/array,
 * and string length are capped, and non-JSON-safe values are dropped. A
 * misbehaving upstream can therefore never bloat the browser response with a
 * deeply nested or oversized `meta` payload.
 */
const MAX_META_DEPTH = 4;
const MAX_META_ENTRIES = 32;
const MAX_META_STRING_LENGTH = 240;

const normalizeUpstreamLedgerItem = (input: unknown): unknown => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const reason =
    typeof record.reason === "string" && record.reason.trim()
      ? record.reason
      : typeof record.type === "string" && record.type.trim()
        ? record.type
        : "ledger";
  const reasonLabel =
    typeof record.reasonLabel === "string" && record.reasonLabel.trim()
      ? record.reasonLabel
      : typeof record.reason === "string" && record.reason.trim()
        ? record.reason
        : typeof record.type === "string" && record.type.trim()
          ? record.type
          : "积分变动";
  const refId = typeof record.refId === "string" && record.refId.trim() ? record.refId : null;
  const meta =
    record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
      ? boundUpstreamMeta(record.meta, 0)
      : null;
  return {
    id: record.id,
    delta: record.delta,
    balanceAfter: record.balanceAfter,
    reason,
    reasonLabel,
    refId,
    meta,
    createdAt: record.createdAt,
  };
};

function boundUpstreamMeta(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === "string") return value.slice(0, MAX_META_STRING_LENGTH);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    if (depth >= MAX_META_DEPTH) return null;
    return value.slice(0, MAX_META_ENTRIES).map((item) => boundUpstreamMeta(item, depth + 1));
  }
  if (value && typeof value === "object") {
    if (depth >= MAX_META_DEPTH) return null;
    const record: Record<string, unknown> = {};
    let entries = 0;
    for (const [key, item] of Object.entries(value)) {
      if (entries >= MAX_META_ENTRIES) break;
      record[key] = boundUpstreamMeta(item, depth + 1);
      entries += 1;
    }
    return record;
  }
  return null;
}

const normalizeUpstreamLedgerEnvelope = (input: unknown): unknown => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  const record = input as { ok?: unknown; data?: unknown };
  if (record.ok !== true) return input;
  const data = record.data;
  if (Array.isArray(data)) return { ...record, data: { items: data } };
  if (data && typeof data === "object") {
    const wrapped = data as { items?: unknown; list?: unknown };
    if (Array.isArray(wrapped.items)) return input;
    if (Array.isArray(wrapped.list)) return { ...record, data: { items: wrapped.list } };
  }
  return input;
};

export const walletLedgerUpstreamResponseSchema = z.preprocess(
  normalizeUpstreamLedgerEnvelope,
  z.object({
    ok: z.literal(true),
    data: z.object({
      items: z.array(z.preprocess(normalizeUpstreamLedgerItem, walletLedgerItemSchema)).max(50),
    }),
  }),
);
export type WalletLedgerUpstreamResponse = z.infer<typeof walletLedgerUpstreamResponseSchema>;

export const walletProductSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("credits"),
    id: z.string().min(1).max(64),
    amount: z.number().finite().positive(),
    credits: z.number().finite().positive(),
  }),
  z.object({
    kind: z.literal("membership"),
    id: z.string().min(1).max(64),
    amount: z.number().finite().positive(),
    tier: z.string().trim().min(1).max(32),
    days: z.number().int().positive().max(366),
  }),
  z.object({
    kind: z.literal("collaboration_seat"),
    id: z.string().min(1).max(64),
    amount: z.number().finite().positive(),
    seats: z.number().int().positive().max(100),
  }),
]);
export type WalletProduct = z.infer<typeof walletProductSchema>;

const hasAtMostTwoDecimalPlaces = (value: number) =>
  Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;

export const walletCustomCreditTopUpSchema = z
  .object({
    productId: z.string().trim().min(1).max(64),
    minAmount: z
      .number()
      .finite()
      .positive()
      .refine(hasAtMostTwoDecimalPlaces, "amount must use at most two decimals"),
    maxAmount: z
      .number()
      .finite()
      .positive()
      .refine(hasAtMostTwoDecimalPlaces, "amount must use at most two decimals"),
    creditsPerYuan: z.number().finite().positive(),
  })
  .superRefine((value, context) => {
    if (value.maxAmount < value.minAmount) {
      context.addIssue({
        code: "custom",
        path: ["maxAmount"],
        message: "maxAmount must be greater than or equal to minAmount",
      });
    }
  });
export type WalletCustomCreditTopUp = z.infer<typeof walletCustomCreditTopUpSchema>;

/**
 * The payment service historically returned `data` as an array and added the
 * custom top-up rules beside it. Accept the newer embedded form as well, but
 * expose one canonical shape to callers.
 */
export const walletProductsResponseSchema = z.preprocess(
  (input) => {
    if (!input || typeof input !== "object") return input;
    const value = input as { data?: unknown; customCreditTopUp?: unknown };
    if (!value.data || typeof value.data !== "object" || Array.isArray(value.data)) return input;
    const embedded = value.data as { products?: unknown; customCreditTopUp?: unknown };
    if (!Array.isArray(embedded.products)) return input;
    return {
      ...value,
      data: embedded.products,
      customCreditTopUp: value.customCreditTopUp ?? embedded.customCreditTopUp,
    };
  },
  z.object({
    ok: z.literal(true),
    data: z.array(walletProductSchema).max(64),
    customCreditTopUp: walletCustomCreditTopUpSchema.nullable().optional().default(null),
  }),
);

export const walletPaymentMethodSchema = z.enum(["alipay", "wxpay"]);
export type WalletPaymentMethod = z.infer<typeof walletPaymentMethodSchema>;

export const walletCheckoutRequestSchema = z
  .object({
    productId: z.string().trim().min(1).max(64),
    paymentMethod: walletPaymentMethodSchema,
    creditGrantMode: z.enum(["daily", "bundle"]).optional(),
    customAmount: z
      .number()
      .finite()
      .min(5)
      .max(5000)
      .refine(hasAtMostTwoDecimalPlaces, "custom amount must use at most two decimals")
      .optional(),
  })
  .strict();
export type WalletCheckoutRequest = z.infer<typeof walletCheckoutRequestSchema>;

export const walletCheckoutResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    orderNo: z.string().regex(/^PAY[A-Z0-9]+$/),
    checkoutUrl: z
      .string()
      .url()
      .refine((value) => {
        const protocol = new URL(value).protocol;
        return protocol === "https:";
      }, "checkout URL must use HTTPS"),
  }),
});

export const walletRedeemRequestSchema = z
  .object({
    code: z.string().trim().min(1).max(64),
    creditGrantMode: z.enum(["daily", "bundle"]).optional(),
  })
  .strict();
export type WalletRedeemRequest = z.infer<typeof walletRedeemRequestSchema>;

export const walletRedeemResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    message: z.string().trim().min(1).max(500),
    // A successful redemption must not be reported as failed if the follow-up
    // balance read is temporarily unavailable. The client retries that read.
    summary: walletSummarySchema.nullable(),
  }),
});

export const walletOrderSchema = z.object({
  orderNo: z.string().regex(/^PAY[A-Z0-9]+$/),
  status: z.enum(["pending", "processing", "paid", "failed", "refunded"]),
  productKind: z.enum(["credits", "membership", "collaboration_seat"]),
  productId: z.string().min(1).max(64),
  amount: z.number().finite().positive(),
  paidAt: nullableDateTime,
  createdAt: z.string().datetime({ offset: true }),
});
export type WalletOrder = z.infer<typeof walletOrderSchema>;

export const walletOrderResponseSchema = z.object({
  ok: z.literal(true),
  data: walletOrderSchema,
});
