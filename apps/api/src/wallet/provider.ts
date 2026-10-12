import type {
  MembershipTaskAction,
  MembershipTaskCenter,
  WalletCheckoutRequest,
  WalletCustomCreditTopUp,
  WalletOrder,
  WalletProduct,
  WalletRedeemRequest,
  WalletSummary,
} from "@weftcanvas/contracts";

export type WalletLedgerItem = {
  id: string;
  delta: number;
  balanceAfter: number;
  reason: string;
  reasonLabel: string;
  refId: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
};

export type WalletProductCatalog = {
  products: WalletProduct[];
  customCreditTopUp: WalletCustomCreditTopUp | null;
};

export type WalletCreditOperationInput = {
  /** 积分数量（整数，非微积分）。 */
  amount: number;
  reason: string;
  refId: string;
};

export type WalletCreditOperationResult = {
  /** 操作后的可花积分余额。 */
  balance: number;
  /** 同一个 refId 是否已经执行过（幂等重放）。 */
  replayed: boolean;
};

export type WalletProviderResult<T> = {
  data: T;
  refreshedToken?: string;
  expiresAt?: string;
};

export class WalletProviderError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 404 | 409 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly refreshedToken?: string,
    readonly expiresAt?: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "WalletProviderError";
  }
}

export interface WalletProvider {
  getSummary(token: string | undefined): Promise<WalletProviderResult<WalletSummary>>;
  getLedger(
    token: string | undefined,
    limit: number,
  ): Promise<WalletProviderResult<WalletLedgerItem[]>>;
  getProducts(token: string | undefined): Promise<WalletProviderResult<WalletProductCatalog>>;
  createCheckout(
    token: string | undefined,
    input: WalletCheckoutRequest,
  ): Promise<WalletProviderResult<{ orderNo: string; checkoutUrl: string }>>;
  getOrder(token: string | undefined, orderNo: string): Promise<WalletProviderResult<WalletOrder>>;
  redeem(
    token: string | undefined,
    input: WalletRedeemRequest,
  ): Promise<WalletProviderResult<{ message: string; summary: WalletSummary | null }>>;
  /** 按 refId 幂等扣减积分（同一 refId 重复调用不会二次扣费）。 */
  consumeCredit(
    token: string | undefined,
    input: WalletCreditOperationInput,
  ): Promise<WalletProviderResult<WalletCreditOperationResult>>;
  /** 按 refId 幂等退回积分（同一 refId 重复调用不会二次到账）。 */
  refundCredit(
    token: string | undefined,
    input: WalletCreditOperationInput,
  ): Promise<WalletProviderResult<WalletCreditOperationResult>>;
}

export interface MembershipTaskProvider {
  getMembershipTasks(
    token: string | undefined,
  ): Promise<WalletProviderResult<MembershipTaskCenter>>;
  claimMembershipTask(
    token: string | undefined,
    taskKey: string,
  ): Promise<WalletProviderResult<MembershipTaskAction>>;
  recordCanvasNodeCreated(
    token: string | undefined,
  ): Promise<WalletProviderResult<MembershipTaskAction>>;
}
