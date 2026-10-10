import type { WalletPaymentMethod } from "@kachang/contracts";

type CreditGrantMode = "daily" | "bundle";

export type PersistedWalletOrder = {
  version: 1;
  userId: string;
  orderNo: string;
  checkoutUrl: string;
  productId: string;
  paymentMethod: WalletPaymentMethod;
  creditGrantMode?: CreditGrantMode;
  customAmount?: number;
  createdAt: number;
};

export const WALLET_ORDER_STORAGE_KEY = "kachang-canvas:wallet-order:v1";

export function readPersistedWalletOrder(): PersistedWalletOrder | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WALLET_ORDER_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PersistedWalletOrder>;
    if (
      value.version !== 1
      || typeof value.userId !== "string"
      || !value.userId
      || typeof value.orderNo !== "string"
      || !/^PAY[A-Z0-9]+$/.test(value.orderNo)
      || typeof value.checkoutUrl !== "string"
      || !isHttpsUrl(value.checkoutUrl)
      || typeof value.productId !== "string"
      || !value.productId
      || (value.paymentMethod !== "alipay" && value.paymentMethod !== "wxpay")
      || (value.customAmount !== undefined && !isPersistedCustomAmount(value.customAmount))
    ) return null;
    return {
      version: 1,
      userId: value.userId,
      orderNo: value.orderNo,
      checkoutUrl: value.checkoutUrl,
      productId: value.productId,
      paymentMethod: value.paymentMethod,
      ...(value.creditGrantMode === "daily" || value.creditGrantMode === "bundle" ? { creditGrantMode: value.creditGrantMode } : {}),
      ...(value.customAmount !== undefined ? { customAmount: value.customAmount } : {}),
      createdAt: typeof value.createdAt === "number" && Number.isFinite(value.createdAt) && value.createdAt > 0
        ? Math.min(value.createdAt, Date.now())
        : Date.now(),
    };
  } catch {
    return null;
  }
}

export function persistWalletOrder(value: PersistedWalletOrder | null) {
  if (typeof window === "undefined") return;
  try {
    if (value) window.localStorage.setItem(WALLET_ORDER_STORAGE_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(WALLET_ORDER_STORAGE_KEY);
  } catch {
    // Restricted local storage must not stop a payment from opening.
  }
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isPersistedCustomAmount(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 5
    && value <= 5000
    && Math.abs(value * 100 - Math.round(value * 100)) < 1e-6;
}
