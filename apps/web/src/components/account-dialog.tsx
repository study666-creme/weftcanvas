import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  Coins,
  Crown,
  Eye,
  EyeOff,
  ExternalLink,
  Gift,
  KeyRound,
  Landmark,
  ListChecks,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Mail,
  RefreshCw,
  RotateCcw,
  Ticket,
  UserRound,
  UserRoundPen,
  UserPlus,
  UsersRound,
  WalletCards,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
// 账户/钱包面板可在登录首屏与游客入口打开，样式必须随对话框本身加载。
import "../wallet-premium.css";
import type {
  MembershipTaskCenter,
  WalletCheckoutRequest,
  WalletCustomCreditTopUp,
  WalletOrder,
  WalletPaymentMethod,
  WalletProduct,
  WalletSummary,
} from "@weftcanvas/contracts";

import { useIdentityStore } from "../state/identity-store";
import { requestConfirmation } from "../lib/confirmation";
import { HOSTED_WALLET_NOTICE } from "../lib/hosted-wallet-notice";
import { useMembershipTaskStore } from "../state/membership-task-store";
import { useToastStore } from "../state/toast-store";
import { useWalletStore } from "../state/wallet-store";
import {
  persistWalletOrder,
  readPersistedWalletOrder,
  type PersistedWalletOrder,
} from "../lib/wallet-order-storage";

type CreditGrantMode = "daily" | "bundle";
type AccountView = "membership" | "tasks" | "wallet";
type MembershipTier = "lite" | "basic" | "standard" | "pro";

const MEMBERSHIP_PLANS: Array<{
  tier: MembershipTier;
  name: string;
  caption: string;
  features: Array<{ label: string; preview?: boolean }>;
}> = [
  {
    tier: "lite",
    name: "轻量会员",
    caption: "日常轻量创作",
    features: [
      { label: "每日 10 积分" },
      { label: "300MB + 2GB 云存储" },
      { label: "灵感抽卡 30 次/天" },
    ],
  },
  {
    tier: "basic",
    name: "基础会员",
    caption: "完整个人创作",
    features: [
      { label: "每日 13 积分或一次性 130 积分" },
      { label: "300MB + 5GB 云存储" },
      { label: "全站云同步与资产工作台" },
    ],
  },
  {
    tier: "standard",
    name: "标准会员",
    caption: "进阶工作流",
    features: [
      { label: "每日 32 积分或一次性 320 积分" },
      { label: "自定义 API", preview: true },
      { label: "300MB + 10GB 云存储" },
    ],
  },
  {
    tier: "pro",
    name: "专业会员",
    caption: "高阶专业创作",
    features: [
      { label: "每日 64 积分或一次性 700 积分" },
      { label: "自定义 API" },
      { label: "多人协作（最多 5 人）", preview: true },
      { label: "300MB + 30GB 云存储" },
    ],
  },
];

const ORDER_FAST_POLL_WINDOW_MS = 30_000;
const ORDER_AUTO_POLL_LIMIT_MS = 5 * 60_000;
const ORDER_FAST_POLL_DELAY_MS = 2_000;
const ORDER_SLOW_POLL_DELAY_MS = 5_000;

function isHttpUrl(value: string) {
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function formatCredits(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "--";
  return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function formatMoney(value: number) {
  return value.toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function validateCustomAmount(value: string, rules: WalletCustomCreditTopUp | null) {
  if (!rules) return { amount: null, error: "自定义充值暂不可用" } as const;
  const normalized = value.trim();
  if (!normalized) return { amount: null, error: "请输入充值金额" } as const;
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return { amount: null, error: "金额最多保留两位小数" } as const;
  }
  const amount = Number(normalized);
  if (!Number.isFinite(amount) || amount < rules.minAmount) {
    return { amount: null, error: `最低充值 ¥${formatMoney(rules.minAmount)}` } as const;
  }
  if (amount > rules.maxAmount) {
    return { amount: null, error: `最高充值 ¥${formatMoney(rules.maxAmount)}` } as const;
  }
  return { amount, error: null } as const;
}

function checkoutRequestFromOrder(order: PersistedWalletOrder): WalletCheckoutRequest {
  return {
    productId: order.productId,
    paymentMethod: order.paymentMethod,
    ...(order.creditGrantMode ? { creditGrantMode: order.creditGrantMode } : {}),
    ...(order.customAmount !== undefined ? { customAmount: order.customAmount } : {}),
  };
}

function formatDate(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "刚刚";
  return date.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function membershipLabel(tier: string | null) {
  if (!tier) return "会员权益";
  const labels: Record<string, string> = {
    lite: "轻量会员",
    basic: "基础会员",
    standard: "标准会员",
    pro: "专业会员",
    premium: "高级会员",
    plus: "Plus 会员",
  };
  return labels[tier.toLowerCase()] ?? `${tier} 会员`;
}

/** 档位 → CSS 类名。档位色（翡翠/蓝宝石/紫水晶/金）的钩子，样式见 wallet-premium.css。
    历史档位（premium/plus 等）与未识别档位统一走 is-member（标准金）。 */
function tierClass(tier: string) {
  const known = ["lite", "basic", "standard", "pro"];
  const normalized = tier.toLowerCase();
  return known.includes(normalized) ? `is-${normalized}` : "is-member";
}

function orderStatusLabel(status: WalletOrder["status"]) {
  return {
    pending: "等待支付",
    processing: "确认到账中",
    paid: "支付成功",
    failed: "支付失败",
    refunded: "已退款",
  }[status];
}

function orderStatusClass(status: WalletOrder["status"]) {
  return status === "paid"
    ? "is-success"
    : status === "failed" || status === "refunded"
      ? "is-error"
      : "is-pending";
}

function productLabel(product: WalletProduct) {
  if (product.kind === "credits") return `${formatCredits(product.credits)} 积分`;
  if (product.kind === "membership") return membershipLabel(product.tier);
  return `${product.seats} 个额外协作者席位`;
}

function productDetail(product: WalletProduct) {
  // 积分包的副行不放品类名（"积分包"三个字对决策没有信息量），
  // 放单价锚点——"多少钱换多少"是购买时最有说服力的一行字。
  if (product.kind === "credits") {
    const perYuan = product.credits / product.amount;
    return `约 ${formatCredits(Math.round(perYuan))} 积分/元`;
  }
  if (product.kind === "membership") return `${product.days} 天权益`;
  return "支付确认后计入账号，可跨项目复用";
}

function paidOrderMessage(order: WalletOrder) {
  return order.productKind === "collaboration_seat" ? "席位权益已到账" : "积分与权益已刷新";
}

function membershipGrantMode(product: WalletProduct | null): CreditGrantMode | undefined {
  if (!product || product.kind !== "membership") return undefined;
  return product.tier.toLowerCase() === "lite" ? "daily" : undefined;
}

function MembershipBenefits({
  summary,
  products,
  selectedProductId,
  grantMode,
  grantModeTouched,
  onSelectProduct,
  onGrantModeChange,
  checkoutAmount,
  checkoutBlocked,
  paymentBusy,
  onCheckout,
  orderError,
  productsStatus,
}: {
  summary: WalletSummary | null;
  products: WalletProduct[];
  selectedProductId: string;
  grantMode: CreditGrantMode;
  grantModeTouched: { current: boolean };
  onSelectProduct: (productId: string) => void;
  onGrantModeChange: (mode: CreditGrantMode) => void;
  checkoutAmount: number | null;
  checkoutBlocked: boolean;
  paymentBusy: boolean;
  onCheckout: () => void;
  orderError: string | null;
  productsStatus: "idle" | "loading" | "ready" | "error";
}) {
  const currentTier = summary?.membership.active
    ? (summary.membership.tier?.toLowerCase() as MembershipTier | undefined)
    : undefined;
  const selectedProduct = products.find((product) => product.id === selectedProductId) ?? null;
  const fixedGrantMode = selectedProduct ? membershipGrantMode(selectedProduct) : undefined;
  // 档位卡即商品：四张方案卡按 tier 直接对上会员商品，选中即可支付；
  // 对不上方案卡的会员商品（历史档位等）落到"其他方案"兜底行。
  const plannedTiers = new Set<string>(MEMBERSHIP_PLANS.map((plan) => plan.tier));
  const extraProducts = products.filter(
    (product) => product.kind === "membership" && !plannedTiers.has(product.tier.toLowerCase()),
  );

  return (
    <div className="wc-membership-panel">
      <section
        className={`wc-membership-current ${currentTier ? tierClass(currentTier) : ""}`}
        aria-label="当前会员"
      >
        <div className="wc-membership-current-copy">
          <span>当前权益</span>
          <strong>{currentTier ? membershipLabel(currentTier) : "普通用户"}</strong>
          <small>
            {currentTier
              ? summary?.membership.until
                ? `有效期至 ${formatDate(summary.membership.until)}`
                : "长期有效"
              : "每日可在任务中心领取 5 积分"}
          </small>
          {summary?.membership.queuedTier && summary.membership.queuedUntil ? (
            <em>
              接续 {membershipLabel(summary.membership.queuedTier)}，至{" "}
              {formatDate(summary.membership.queuedUntil)}
            </em>
          ) : null}
        </div>
      </section>

      <section className="wc-membership-preview" aria-label="当前开放权益">
        <div>
          <KeyRound aria-hidden="true" />
          <span>
            <strong>自定义 API</strong>
            <small>标准会员权益 · 当前限免</small>
          </span>
        </div>
        <div>
          <UsersRound aria-hidden="true" />
          <span>
            <strong>多人协作（最多 5 人）</strong>
            <small>专业会员权益 · 当前限免</small>
          </span>
        </div>
      </section>

      <section className="wc-membership-benefits" aria-labelledby="wc-membership-benefits-title">
        <div className="wc-membership-panel-heading">
          <div>
            <strong id="wc-membership-benefits-title">会员权益</strong>
            <span>选择档位即可支付，权益即时生效</span>
          </div>
          <BadgeCheck aria-hidden="true" />
        </div>
        <div className="wc-membership-plan-grid" role="listbox" aria-label="会员档位">
          {MEMBERSHIP_PLANS.map((plan) => {
            const product =
              products.find(
                (item) => item.kind === "membership" && item.tier.toLowerCase() === plan.tier,
              ) ?? null;
            const isCurrent = currentTier === plan.tier;
            const selected = product !== null && selectedProductId === product.id;
            return (
              <button
                type="button"
                role="option"
                key={plan.tier}
                aria-selected={selected}
                aria-disabled={product ? undefined : true}
                disabled={!product}
                aria-label={
                  product
                    ? `${plan.name}，¥${formatMoney(product.amount)}`
                    : `${plan.name}，暂未开放`
                }
                className={`wc-membership-plan ${tierClass(plan.tier)} ${isCurrent ? "is-current" : ""} ${selected ? "is-selected" : ""} ${product ? "" : "is-unavailable"}`}
                onClick={product ? () => onSelectProduct(product.id) : undefined}
              >
                <span className="wc-membership-plan-head">
                  <span>{plan.caption}</span>
                  <strong>{plan.name}</strong>
                  {isCurrent ? (
                    <em>
                      <Check aria-hidden="true" />
                      当前会员
                    </em>
                  ) : null}
                </span>
                <span className="wc-membership-plan-features">
                  {plan.features.map((feature) => (
                    <span className="wc-membership-plan-feature" key={feature.label}>
                      <Check aria-hidden="true" />
                      <span>{feature.label}</span>
                      {feature.preview ? <small>当前限免</small> : null}
                    </span>
                  ))}
                </span>
                <span className="wc-membership-plan-price">
                  {product ? (
                    <>
                      <b>¥{formatMoney(product.amount)}</b>
                      <small>{productDetail(product)}</small>
                    </>
                  ) : (
                    <small>暂未开放</small>
                  )}
                  <span
                    className={`wc-membership-plan-check ${selected ? "is-on" : ""}`}
                    aria-hidden="true"
                  >
                    {selected ? <Check aria-hidden="true" /> : null}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        {extraProducts.length ? (
          <div
            className="wc-wallet-products wc-membership-extra"
            role="listbox"
            aria-label="其他会员商品"
          >
            {extraProducts.map((product) => (
              <button
                type="button"
                role="option"
                aria-selected={selectedProductId === product.id}
                className={`wc-wallet-product ${selectedProductId === product.id ? "is-selected" : ""}`}
                key={product.id}
                onClick={() => onSelectProduct(product.id)}
              >
                <span className="wc-wallet-product-check">
                  {selectedProductId === product.id ? <Check aria-hidden="true" /> : null}
                </span>
                <span className="wc-wallet-product-copy">
                  <strong>{productLabel(product)}</strong>
                  <small>{productDetail(product)}</small>
                </span>
                <b>¥{formatMoney(product.amount)}</b>
              </button>
            ))}
          </div>
        ) : null}
        {products.length ? (
          <div className="wc-membership-plan-actions">
            {fixedGrantMode === undefined ? (
              <div className="wc-wallet-choice-row">
                <span>积分到账</span>
                <div className="wc-wallet-segmented" role="group" aria-label="积分到账方式">
                  <button
                    type="button"
                    className={grantMode === "bundle" ? "is-active" : ""}
                    aria-pressed={grantMode === "bundle"}
                    onClick={() => {
                      grantModeTouched.current = true;
                      onGrantModeChange("bundle");
                    }}
                  >
                    永久积分
                  </button>
                  <button
                    type="button"
                    className={grantMode === "daily" ? "is-active" : ""}
                    aria-pressed={grantMode === "daily"}
                    onClick={() => {
                      grantModeTouched.current = true;
                      onGrantModeChange("daily");
                    }}
                  >
                    每日积分
                  </button>
                </div>
              </div>
            ) : fixedGrantMode === "daily" ? (
              <div className="wc-wallet-choice-row wc-wallet-choice-row--fixed">
                <span>积分到账</span>
                <strong>每日积分</strong>
              </div>
            ) : null}
            <div className="wc-wallet-payment-row">
              <span>支付方式</span>
              <div className="wc-wallet-segmented" role="group" aria-label="支付方式">
                <button
                  type="button"
                  className="is-active"
                  aria-pressed="true"
                  disabled={paymentBusy || checkoutBlocked}
                >
                  <Landmark aria-hidden="true" />
                  支付宝
                </button>
              </div>
            </div>
            <button
              type="button"
              className="wc-account-submit wc-wallet-checkout"
              disabled={!selectedProduct || paymentBusy || checkoutBlocked}
              onClick={onCheckout}
            >
              {paymentBusy ? (
                <LoaderCircle className="is-spinning" aria-hidden="true" />
              ) : (
                <Coins aria-hidden="true" />
              )}
              {checkoutBlocked
                ? "请先处理待支付订单"
                : checkoutAmount !== null
                  ? `立即支付 ¥${formatMoney(checkoutAmount)}`
                  : "请选择商品"}
            </button>
            {orderError ? (
              <p className="wc-wallet-order-error" role="alert">
                {orderError}
              </p>
            ) : null}
          </div>
        ) : productsStatus === "loading" || productsStatus === "idle" ? (
          <div className="wc-wallet-state">
            <LoaderCircle className="is-spinning" aria-hidden="true" />
            正在加载会员商品
          </div>
        ) : (
          <div className="wc-wallet-state">暂时没有可购买的会员商品</div>
        )}
      </section>
    </div>
  );
}

function taskRewardLabel(task: MembershipTaskCenter["items"][number]) {
  const rewards: string[] = [];
  if (task.rewardDays > 0)
    rewards.push(`${task.rewardDays} 天${membershipLabel(task.rewardTier ?? "basic")}`);
  if (task.rewardCredits > 0) rewards.push(`${formatCredits(task.rewardCredits)} 积分`);
  return rewards.join(" + ") || "任务奖励";
}

function MembershipTasksPanel({
  data,
  status,
  error,
  claimingKey,
  onClaim,
  onReload,
}: {
  data: MembershipTaskCenter | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  claimingKey: string | null;
  onClaim: (taskKey: string) => void;
  onReload: () => void;
}) {
  if ((status === "idle" || status === "loading") && !data) {
    return (
      <div className="wc-membership-task-state">
        <LoaderCircle className="is-spinning" aria-hidden="true" />
        正在加载任务中心
      </div>
    );
  }
  if (!data) {
    return (
      <div className="wc-membership-task-state is-error">
        <AlertCircle aria-hidden="true" />
        <span>{error ?? "任务中心暂时无法连接"}</span>
        <button type="button" onClick={onReload}>
          重试
        </button>
      </div>
    );
  }

  const dailyTasks = [
    {
      key: data.hub.dailyBonus.key,
      title: "每日免费积分",
      description: `今日领取 5 积分 · 连续签到 ${data.hub.signStreak} 天`,
      reward: "5 积分（今日有效）",
      claimed: data.hub.dailyBonus.claimed,
      ready: data.hub.dailyBonus.ready,
    },
    ...(data.hub.memberDaily
      ? [
          {
            key: data.hub.memberDaily.key,
            title: "会员每日积分",
            description: "按当前会员档位领取，当日有效",
            reward: `${formatCredits(data.hub.memberDaily.amount)} 积分`,
            claimed: data.hub.memberDaily.claimed,
            ready: data.hub.memberDaily.ready,
          },
        ]
      : []),
  ];

  return (
    <div className="wc-membership-tasks-panel">
      <section className="wc-membership-daily" aria-labelledby="wc-membership-daily-title">
        <div className="wc-membership-panel-heading">
          <div>
            <strong id="wc-membership-daily-title">今日领取</strong>
            <span>每日积分当天有效，未使用部分次日清零</span>
          </div>
          <Gift aria-hidden="true" />
        </div>
        <div className="wc-membership-daily-grid">
          {dailyTasks.map((task) => (
            <article key={task.key} className={task.claimed ? "is-claimed" : ""}>
              <span className="wc-membership-task-icon" aria-hidden="true">
                <Coins />
              </span>
              <div>
                <strong>{task.title}</strong>
                <small>{task.description}</small>
                <em>{task.reward}</em>
              </div>
              <button
                type="button"
                disabled={task.claimed || !task.ready || Boolean(claimingKey)}
                onClick={() => onClaim(task.key)}
              >
                {claimingKey === task.key ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : task.claimed ? (
                  <Check aria-hidden="true" />
                ) : (
                  <Gift aria-hidden="true" />
                )}
                {task.claimed ? "今日已领" : "领取"}
              </button>
            </article>
          ))}
        </div>
        <p className="wc-membership-streak">
          再签到 {data.hub.daysToStreakBonus} 天可获得连续 7 天额外奖励
        </p>
      </section>

      <section className="wc-membership-growth" aria-labelledby="wc-membership-growth-title">
        <div className="wc-membership-panel-heading">
          <div>
            <strong id="wc-membership-growth-title">成长任务</strong>
            <span>会员奖励与卡片库共享，每项仅可领取一次</span>
          </div>
          <ListChecks aria-hidden="true" />
        </div>
        {data.items.length ? (
          <div className="wc-membership-task-list" role="list">
            {data.items.map((task) => (
              <article
                className={`${task.claimed ? "is-claimed" : ""} ${task.ready ? "is-ready" : ""}`}
                role="listitem"
                key={task.key}
              >
                <span className="wc-membership-task-icon" aria-hidden="true">
                  {task.claimed ? <Check /> : <Gift />}
                </span>
                <div className="wc-membership-task-copy">
                  <strong>{task.title}</strong>
                  <small>{task.description}</small>
                  <span>
                    {taskRewardLabel(task)}
                    {task.progress ? ` · ${task.progress}` : ""}
                  </span>
                </div>
                {task.kind === "promo" ? (
                  <em className="wc-membership-task-status">在卡片库完成</em>
                ) : (
                  <button
                    type="button"
                    disabled={task.claimed || !task.ready || Boolean(claimingKey)}
                    onClick={() => onClaim(task.key)}
                  >
                    {claimingKey === task.key ? (
                      <LoaderCircle className="is-spinning" aria-hidden="true" />
                    ) : task.claimed ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Gift aria-hidden="true" />
                    )}
                    {task.claimed ? "已领取" : task.ready ? "领取" : "未完成"}
                  </button>
                )}
              </article>
            ))}
          </div>
        ) : (
          <div className="wc-membership-task-state">当前没有成长任务</div>
        )}
      </section>

      {error ? (
        <div className="wc-account-error wc-membership-task-error" role="alert">
          <AlertCircle aria-hidden="true" />
          {error}
          <button type="button" onClick={onReload}>
            重新加载
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AccountDialog() {
  const open = useIdentityStore((state) => state.dialogOpen);
  const status = useIdentityStore((state) => state.status);
  const session = useIdentityStore((state) => state.session);
  const capabilities = useIdentityStore((state) => state.capabilities);
  const mode = useIdentityStore((state) => state.mode);
  const busy = useIdentityStore((state) => state.busy);
  const identityError = useIdentityStore((state) => state.error);
  const verificationEmail = useIdentityStore((state) => state.verificationEmail);
  const close = useIdentityStore((state) => state.closeDialog);
  const setMode = useIdentityStore((state) => state.setMode);
  const login = useIdentityStore((state) => state.login);
  const register = useIdentityStore((state) => state.register);
  const logout = useIdentityStore((state) => state.logout);
  const hydrate = useIdentityStore((state) => state.hydrate);

  const summary = useWalletStore((state) => state.summary);
  const products = useWalletStore((state) => state.products);
  const requestedProductKind = useWalletStore((state) => state.requestedProductKind);
  const customCreditTopUp = useWalletStore((state) => state.customCreditTopUp);
  const ledger = useWalletStore((state) => state.ledger);
  const summaryStatus = useWalletStore((state) => state.summaryStatus);
  const productsStatus = useWalletStore((state) => state.productsStatus);
  const ledgerStatus = useWalletStore((state) => state.ledgerStatus);
  const walletError = useWalletStore((state) => state.error);
  const loadSummary = useWalletStore((state) => state.loadSummary);
  const loadProducts = useWalletStore((state) => state.loadProducts);
  const loadLedger = useWalletStore((state) => state.loadLedger);
  const checkout = useWalletStore((state) => state.checkout);
  const readOrder = useWalletStore((state) => state.readOrder);
  const redeem = useWalletStore((state) => state.redeem);
  const clearRequestedProduct = useWalletStore((state) => state.clearRequestedProduct);
  const resetWallet = useWalletStore((state) => state.reset);
  const clearWalletError = useWalletStore((state) => state.clearError);
  const membershipTasks = useMembershipTaskStore((state) => state.data);
  const membershipTasksStatus = useMembershipTaskStore((state) => state.status);
  const membershipTasksError = useMembershipTaskStore((state) => state.error);
  const membershipTaskClaimingKey = useMembershipTaskStore((state) => state.claimingKey);
  const membershipTaskOpenRequested = useMembershipTaskStore((state) => state.requestedOpen);
  const loadMembershipTasks = useMembershipTaskStore((state) => state.load);
  const claimMembershipTaskReward = useMembershipTaskStore((state) => state.claim);
  const clearMembershipTaskOpen = useMembershipTaskStore((state) => state.clearRequestedOpen);
  const showToast = useToastStore((state) => state.show);

  const [accountView, setAccountView] = useState<AccountView>("membership");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [activationCode, setActivationCode] = useState("");
  const [redeeming, setRedeeming] = useState(false);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [customAmountInput, setCustomAmountInput] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<WalletPaymentMethod>("alipay");
  const [grantMode, setGrantMode] = useState<CreditGrantMode>("daily");
  const [redeemGrantMode, setRedeemGrantMode] = useState<CreditGrantMode>("daily");
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [paymentOrder, setPaymentOrder] = useState<WalletOrder | null>(null);
  const [persistedOrder, setPersistedOrder] = useState<PersistedWalletOrder | null>(
    readPersistedWalletOrder,
  );
  const [orderError, setOrderError] = useState<string | null>(null);
  const [orderPollingTimedOut, setOrderPollingTimedOut] = useState(false);
  const [orderPolling, setOrderPolling] = useState(false);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  const grantModeTouched = useRef(false);
  const redeemGrantModeTouched = useRef(false);
  const paymentBusyRef = useRef(false);
  const paymentOrderRef = useRef<WalletOrder | null>(null);
  const activeOrderRef = useRef<PersistedWalletOrder | null>(persistedOrder);
  const orderPollRef = useRef<{ orderNo: string; promise: Promise<WalletOrder | null> } | null>(
    null,
  );
  const previousUserIdRef = useRef<string | null>(session?.user.id ?? null);
  const accountWasOpenRef = useRef(false);

  const effectiveMode = capabilities.registration === "native" ? mode : "login";
  const selectedProduct = useMemo(
    () => products.find((product) => product.id === selectedProductId) ?? null,
    [products, selectedProductId],
  );
  // 积分充值与会员充值分家：充值页只展示积分商品，会员商品在“会员权益”页购买。
  const walletProducts = useMemo(
    () => products.filter((product) => product.kind !== "membership"),
    [products],
  );
  const membershipProducts = useMemo(
    () => products.filter((product) => product.kind === "membership"),
    [products],
  );
  const customTopUpSelected = customCreditTopUp?.productId === selectedProductId;
  const customAmountValidation = validateCustomAmount(customAmountInput, customCreditTopUp);
  const selectedCheckoutAmount = customTopUpSelected
    ? customAmountValidation.amount
    : (selectedProduct?.amount ?? null);
  const selectedCheckoutRequest: WalletCheckoutRequest | null = customTopUpSelected
    ? customAmountValidation.amount === null || !customCreditTopUp
      ? null
      : {
          productId: customCreditTopUp.productId,
          paymentMethod,
          customAmount: customAmountValidation.amount,
        }
    : selectedProduct
      ? {
          productId: selectedProduct.id,
          paymentMethod,
          ...(selectedProduct.kind === "membership"
            ? { creditGrantMode: membershipGrantMode(selectedProduct) ?? grantMode }
            : {}),
        }
      : null;
  const checkoutBlockedByOrder = Boolean(
    persistedOrder && paymentOrder?.status !== "failed" && paymentOrder?.status !== "refunded",
  );

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close, open]);

  useEffect(() => {
    const updateVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    const userId = session?.user.id ?? null;
    if (previousUserIdRef.current === userId) return;
    previousUserIdRef.current = userId;
    setAccountView("membership");
    setActivationCode("");
    setSelectedProductId("");
    setCustomAmountInput("");
    setPaymentMethod("alipay");
    setGrantMode("daily");
    setRedeemGrantMode("daily");
    grantModeTouched.current = false;
    redeemGrantModeTouched.current = false;
    setPaymentBusy(false);
    paymentBusyRef.current = false;
    setRedeeming(false);
    setPaymentOrder(null);
    paymentOrderRef.current = null;
    orderPollRef.current = null;
    setOrderPolling(false);
  }, [session?.user.id]);

  useEffect(() => {
    if (!open) {
      accountWasOpenRef.current = false;
      return;
    }
    const justOpened = !accountWasOpenRef.current;
    accountWasOpenRef.current = true;
    if (status !== "authenticated" || !session) return;
    if (membershipTaskOpenRequested) {
      setAccountView("tasks");
      clearMembershipTaskOpen();
      void loadMembershipTasks();
      return;
    }
    if (requestedProductKind) {
      setAccountView("wallet");
      return;
    }
    if (justOpened) setAccountView("membership");
  }, [
    clearMembershipTaskOpen,
    loadMembershipTasks,
    membershipTaskOpenRequested,
    open,
    requestedProductKind,
    session,
    status,
  ]);

  useEffect(() => {
    if (status !== "authenticated" || !session) return;
    if (persistedOrder && persistedOrder.userId !== session.user.id) {
      persistWalletOrder(null);
      setPersistedOrder(null);
      activeOrderRef.current = null;
      setPaymentOrder(null);
      paymentOrderRef.current = null;
      setOrderPollingTimedOut(false);
    }
  }, [persistedOrder, session, status]);

  useEffect(() => {
    if (status !== "authenticated") return;
    void loadSummary();
    // 会员商品在“会员权益”页购买，积分商品在“充值”页购买：两个视图都需要商品目录。
    if (open && (accountView === "wallet" || accountView === "membership")) {
      void loadProducts();
    }
    if (open && accountView === "wallet") {
      void loadLedger();
    }
    if (open && accountView === "tasks") void loadMembershipTasks();
  }, [accountView, loadLedger, loadMembershipTasks, loadProducts, loadSummary, open, status]);

  useEffect(() => {
    if (!products.length && !customCreditTopUp) return;
    setSelectedProductId((current) => {
      if (
        current &&
        (products.some((product) => product.id === current) ||
          customCreditTopUp?.productId === current)
      ) {
        return current;
      }
      // 首次加载按当前视图选：会员页选会员商品，充值页选积分商品。
      const candidates = accountView === "membership" ? membershipProducts : walletProducts;
      return (
        candidates.find((product) => product.kind === "credits")?.id ??
        (accountView === "membership" ? undefined : customCreditTopUp?.productId) ??
        candidates[0]?.id ??
        ""
      );
    });
  }, [accountView, customCreditTopUp, membershipProducts, products, walletProducts]);

  // 切到哪个视图就选中哪个视图的商品：充值页只显示积分商品，会员页只显示会员商品。
  useEffect(() => {
    if (!products.length) return;
    setSelectedProductId((current) => {
      const currentProduct = products.find((product) => product.id === current);
      const currentMatchesView = Boolean(
        currentProduct && (currentProduct.kind === "membership") === (accountView === "membership"),
      );
      if (currentMatchesView) return current;
      const candidates = accountView === "membership" ? membershipProducts : walletProducts;
      return (
        candidates.find((product) => product.kind === "credits")?.id ?? candidates[0]?.id ?? ""
      );
    });
    // 依赖 products 由上方 effect 处理；这里只响应视图切换。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountView]);

  useEffect(() => {
    if (!open || status !== "authenticated" || !requestedProductKind || productsStatus !== "ready")
      return;
    setAccountView(requestedProductKind === "membership" ? "membership" : "wallet");
    const requestedProduct = products.find((product) => product.kind === requestedProductKind);
    if (requestedProduct) {
      setSelectedProductId(requestedProduct.id);
      setOrderError(null);
    } else if (requestedProductKind === "collaboration_seat") {
      setOrderError("协作席位商品尚未开放，当前不会创建订单或扣款");
    }
    clearRequestedProduct();
  }, [clearRequestedProduct, open, products, productsStatus, requestedProductKind, status]);

  useEffect(() => {
    if (!summary?.creditGrantMode) return;
    if (!grantModeTouched.current) setGrantMode(summary.creditGrantMode);
    if (!redeemGrantModeTouched.current) setRedeemGrantMode(summary.creditGrantMode);
  }, [summary?.creditGrantMode]);

  const clearOrder = useCallback(() => {
    persistWalletOrder(null);
    setPersistedOrder(null);
    activeOrderRef.current = null;
    setPaymentOrder(null);
    paymentOrderRef.current = null;
    setOrderError(null);
    setOrderPollingTimedOut(false);
    setOrderPolling(false);
  }, []);

  const stopTrackingOrder = useCallback(async () => {
    const confirmed = await requestConfirmation({
      title: "停止跟踪支付订单",
      description: "画布将不再显示这笔订单的支付进度，但不会撤销或取消已经发起的支付。",
      detail: "付款完成后，权益仍会按上游订单结果到账。",
      confirmLabel: "停止跟踪",
      tone: "warning",
    });
    if (confirmed) clearOrder();
  }, [clearOrder]);

  const settleOrder = useCallback(
    async (next: WalletOrder) => {
      if (activeOrderRef.current?.orderNo !== next.orderNo) return;
      paymentOrderRef.current = next;
      setPaymentOrder(next);
      setOrderError(null);
      if (next.status !== "paid" && next.status !== "refunded") return;
      persistWalletOrder(null);
      setPersistedOrder(null);
      activeOrderRef.current = null;
      if (next.status === "refunded") {
        showToast("订单已退款，相关权益已撤销", "info");
        return;
      }
      await Promise.all([loadSummary(true), loadLedger(true)]);
      showToast(
        next.productKind === "collaboration_seat"
          ? "支付成功，协作席位已写入账号权益"
          : "支付成功，积分与权益已更新",
        "success",
      );
    },
    [loadLedger, loadSummary, showToast],
  );

  const pollOrder = useCallback((): Promise<WalletOrder | null> => {
    const activeOrder = activeOrderRef.current;
    if (!activeOrder || status !== "authenticated") return Promise.resolve(null);
    const current = orderPollRef.current;
    if (current?.orderNo === activeOrder.orderNo) return current.promise;
    const promise = (async () => {
      setOrderPolling(true);
      try {
        const next = await readOrder(activeOrder.orderNo);
        if (activeOrderRef.current?.orderNo !== activeOrder.orderNo) return null;
        await settleOrder(next);
        return next;
      } catch (cause) {
        if (activeOrderRef.current?.orderNo === activeOrder.orderNo) {
          setOrderError(cause instanceof Error ? cause.message : "订单状态暂时无法获取");
        }
        return null;
      }
    })();
    orderPollRef.current = { orderNo: activeOrder.orderNo, promise };
    void promise.finally(() => {
      if (orderPollRef.current?.promise === promise) orderPollRef.current = null;
      setOrderPolling(false);
    });
    return promise;
  }, [readOrder, settleOrder, status]);

  useEffect(() => {
    if (!pageVisible || status !== "authenticated" || !persistedOrder) return;
    const knownOrder = paymentOrderRef.current;
    if (
      knownOrder?.orderNo === persistedOrder.orderNo &&
      (knownOrder.status === "failed" ||
        knownOrder.status === "paid" ||
        knownOrder.status === "refunded")
    )
      return;
    if (Date.now() - persistedOrder.createdAt >= ORDER_AUTO_POLL_LIMIT_MS) {
      setOrderPollingTimedOut(true);
      return;
    }
    setOrderPollingTimedOut(false);
    let active = true;
    let timer: number | null = null;
    const run = async () => {
      if (!active) return;
      const age = Math.max(0, Date.now() - persistedOrder.createdAt);
      if (age >= ORDER_AUTO_POLL_LIMIT_MS) {
        setOrderPollingTimedOut(true);
        return;
      }
      const next = await pollOrder();
      if (!active) return;
      if (next?.status === "paid" || next?.status === "failed" || next?.status === "refunded")
        return;
      const delay =
        age < ORDER_FAST_POLL_WINDOW_MS ? ORDER_FAST_POLL_DELAY_MS : ORDER_SLOW_POLL_DELAY_MS;
      timer = window.setTimeout(run, Math.min(delay, ORDER_AUTO_POLL_LIMIT_MS - age));
    };
    void run();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [pageVisible, persistedOrder, pollOrder, status]);

  const submitIdentity = async (event: FormEvent) => {
    event.preventDefault();
    setFormError(null);
    if (effectiveMode === "register" && password !== confirmPassword) {
      setFormError("两次输入的密码不一致");
      return;
    }
    const normalizedDisplayName = displayName.trim();
    if (
      effectiveMode === "register" &&
      normalizedDisplayName &&
      !/^[\p{Script=Han}A-Za-z0-9_-]{2,20}$/u.test(normalizedDisplayName)
    ) {
      setFormError("昵称需 2-20 字，仅支持中文、字母、数字、下划线或连字符");
      return;
    }
    const completed =
      effectiveMode === "login"
        ? await login(email, password)
        : await register(email, password, normalizedDisplayName);
    if (completed) {
      setPassword("");
      setConfirmPassword("");
      setDisplayName("");
    }
  };

  const openCashier = (url: string) => {
    if (!isHttpUrl(url)) {
      setOrderError("收银台地址无效，请重新创建订单");
      return;
    }
    const popup = window.open(url, "_blank", "noopener,noreferrer");
    if (!popup) setOrderError("收银台被浏览器拦截，请允许弹窗后再试");
  };

  const startCheckout = async (input: WalletCheckoutRequest | null = selectedCheckoutRequest) => {
    if (!input || !session) {
      setOrderError(customTopUpSelected ? customAmountValidation.error : "请选择一个商品");
      return;
    }
    if (paymentBusyRef.current) return;
    paymentBusyRef.current = true;
    clearWalletError();
    setPaymentBusy(true);
    setOrderError(null);
    const placeholder = window.open("about:blank", "_blank");
    const ownerId = session.user.id;
    try {
      const result = await checkout(input);
      if (useIdentityStore.getState().session?.user.id !== ownerId) {
        placeholder?.close();
        return;
      }
      const next: PersistedWalletOrder = {
        version: 1,
        userId: session.user.id,
        orderNo: result.orderNo,
        checkoutUrl: result.checkoutUrl,
        productId: input.productId,
        paymentMethod: input.paymentMethod,
        ...(input.creditGrantMode ? { creditGrantMode: input.creditGrantMode } : {}),
        ...(input.customAmount !== undefined ? { customAmount: input.customAmount } : {}),
        createdAt: Date.now(),
      };
      persistWalletOrder(next);
      setPersistedOrder(next);
      activeOrderRef.current = next;
      setPaymentOrder(null);
      paymentOrderRef.current = null;
      setOrderPollingTimedOut(false);
      if (placeholder && !placeholder.closed && isHttpUrl(result.checkoutUrl)) {
        placeholder.opener = null;
        placeholder.location.replace(result.checkoutUrl);
      } else {
        // 占位窗口不可用或地址非 http(s)：统一走带方案校验的 openCashier。
        placeholder?.close();
        openCashier(result.checkoutUrl);
      }
      showToast("收银台已打开，支付完成后会自动确认到账", "info");
    } catch (cause) {
      placeholder?.close();
      if (useIdentityStore.getState().session?.user.id === ownerId) {
        setOrderError(cause instanceof Error ? cause.message : "创建支付订单失败");
      }
    } finally {
      paymentBusyRef.current = false;
      setPaymentBusy(false);
    }
  };

  const redeemCode = async (event?: FormEvent) => {
    event?.preventDefault();
    const code = activationCode.trim().toUpperCase();
    if (!code) {
      setOrderError("请输入激活码");
      return;
    }
    setRedeeming(true);
    setOrderError(null);
    const ownerId = session?.user.id;
    try {
      const message = await redeem({ code, creditGrantMode: redeemGrantMode });
      if (!ownerId || useIdentityStore.getState().session?.user.id !== ownerId) return;
      setActivationCode("");
      showToast(message || "激活码兑换成功", "success");
      await loadLedger(true);
    } catch (cause) {
      if (ownerId && useIdentityStore.getState().session?.user.id === ownerId) {
        setOrderError(cause instanceof Error ? cause.message : "激活码兑换失败");
      }
    } finally {
      setRedeeming(false);
    }
  };

  const handleLogout = async () => {
    clearOrder();
    resetWallet();
    await logout();
  };

  const handleMembershipTaskClaim = async (taskKey: string) => {
    const message = await claimMembershipTaskReward(taskKey);
    if (message) showToast(message, "success");
  };

  if (!open) return null;

  return createPortal(
    <div
      className="wc-account-backdrop"
      data-wc-preserve-drawers
      role="dialog"
      aria-modal="true"
      aria-labelledby="wc-account-title"
      aria-describedby="wc-account-description"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <section
        className={`wc-account-dialog ${status === "authenticated" && session ? "wc-account-dialog--wallet" : "wc-account-dialog--auth"}`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="wc-account-header">
          <div className="wc-account-heading">
            <span
              className={`wc-account-symbol ${status === "authenticated" && session ? "" : "wc-account-symbol--brand"}`}
            >
              {status === "authenticated" && session ? (
                <UserRound aria-hidden="true" />
              ) : (
                <img src="/weftcanvas-logo-ui.webp" alt="" />
              )}
            </span>
            <div>
              <strong id="wc-account-title">纬线账号</strong>
              <span id="wc-account-description">
                {status !== "authenticated"
                  ? "Weftcanvas"
                  : accountView === "membership"
                    ? "会员权益与共享状态"
                    : accountView === "tasks"
                      ? "任务中心与每日积分"
                      : "积分充值与流水"}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="wc-dialog-close"
            aria-label="关闭"
            title="关闭"
            onClick={close}
            disabled={busy || paymentBusy || redeeming}
          >
            <X aria-hidden="true" />
          </button>
        </header>

        {status === "authenticated" && session ? (
          <div className="wc-account-wallet">
            <section className="wc-wallet-profile">
              <span className="wc-account-avatar" aria-hidden="true">
                {session.user.displayName.slice(0, 1).toUpperCase()}
              </span>
              <div className="wc-wallet-profile-copy">
                <strong>{session.user.displayName}</strong>
                <span>{session.user.email}</span>
              </div>
              {summary?.membership.active ? (
                <span
                  className={`wc-wallet-membership ${summary.membership.tier ? tierClass(summary.membership.tier) : ""}`}
                >
                  <BadgeCheck aria-hidden="true" />
                  {membershipLabel(summary.membership.tier)}
                </span>
              ) : null}
              <button
                type="button"
                className="wc-account-logout wc-account-logout--compact"
                onClick={() => void handleLogout()}
                disabled={
                  busy ||
                  paymentBusy ||
                  redeeming ||
                  orderPolling ||
                  summaryStatus === "loading" ||
                  productsStatus === "loading" ||
                  ledgerStatus === "loading"
                }
              >
                {busy ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : (
                  <LogOut aria-hidden="true" />
                )}
                退出
              </button>
            </section>

            <nav className="wc-account-center-tabs" role="tablist" aria-label="账号中心">
              <button
                type="button"
                role="tab"
                aria-selected={accountView === "membership"}
                onClick={() => setAccountView("membership")}
              >
                <Crown aria-hidden="true" />
                会员权益
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={accountView === "tasks"}
                onClick={() => {
                  setAccountView("tasks");
                  void loadMembershipTasks();
                }}
              >
                <ListChecks aria-hidden="true" />
                任务中心
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={accountView === "wallet"}
                onClick={() => setAccountView("wallet")}
              >
                <WalletCards aria-hidden="true" />
                积分充值
              </button>
            </nav>

            {accountView === "membership" ? (
              <MembershipBenefits
                summary={summary}
                products={membershipProducts}
                selectedProductId={selectedProductId}
                grantMode={grantMode}
                grantModeTouched={grantModeTouched}
                onSelectProduct={(productId) => {
                  setSelectedProductId(productId);
                  setOrderError(null);
                }}
                onGrantModeChange={setGrantMode}
                checkoutAmount={selectedCheckoutAmount}
                checkoutBlocked={checkoutBlockedByOrder}
                paymentBusy={paymentBusy}
                onCheckout={() => void startCheckout()}
                orderError={orderError}
                productsStatus={productsStatus}
              />
            ) : accountView === "tasks" ? (
              <MembershipTasksPanel
                data={membershipTasks}
                status={membershipTasksStatus}
                error={membershipTasksError}
                claimingKey={membershipTaskClaimingKey}
                onClaim={(taskKey) => void handleMembershipTaskClaim(taskKey)}
                onReload={() => void loadMembershipTasks(true)}
              />
            ) : (
              <>
                <section className="wc-wallet-balance" aria-label="积分余额">
                  <div className="wc-wallet-balance-main">
                    <span>当前总积分</span>
                    <strong aria-live="polite">{formatCredits(summary?.credits)}</strong>
                    <small className="wc-wallet-balance-caption">在线生成将优先使用每日积分</small>
                    <button
                      type="button"
                      className="wc-wallet-refresh"
                      onClick={() => void loadSummary(true)}
                      disabled={summaryStatus === "loading"}
                      title="刷新积分余额"
                      aria-label="刷新积分余额"
                    >
                      <RefreshCw
                        className={summaryStatus === "loading" ? "is-spinning" : ""}
                        aria-hidden="true"
                      />
                    </button>
                  </div>
                  <div className="wc-wallet-balance-split">
                    <div>
                      <span>每日积分</span>
                      <strong>{formatCredits(summary?.dailyCredits)}</strong>
                      {summary?.dailyCreditsNote ? <small>{summary.dailyCreditsNote}</small> : null}
                    </div>
                    <div>
                      <span>永久积分</span>
                      <strong>{formatCredits(summary?.creditsPermanent)}</strong>
                    </div>
                    {summary?.membership.active ? (
                      <div>
                        <span>会员到期</span>
                        <strong>
                          {summary.membership.until
                            ? formatDate(summary.membership.until).split(" ")[0]
                            : "长期"}
                        </strong>
                      </div>
                    ) : null}
                  </div>
                  {summary?.membership.queuedTier && summary.membership.queuedUntil ? (
                    <p className="wc-wallet-queued-membership">
                      到期后接续：{membershipLabel(summary.membership.queuedTier)}，至{" "}
                      {formatDate(summary.membership.queuedUntil)}
                    </p>
                  ) : null}
                </section>

                <div className="wc-wallet-main-grid">
                  <section className="wc-wallet-section wc-wallet-products-section">
                    <div className="wc-wallet-section-heading">
                      <div>
                        <strong>充值与权益</strong>
                        {HOSTED_WALLET_NOTICE ? null : <span>选择商品后打开独立收银台</span>}
                      </div>
                      <WalletCards aria-hidden="true" />
                    </div>
                    {HOSTED_WALLET_NOTICE ? (
                      // 内测期不开充值：商品、自定义金额、支付方式与收银台整段隐去，
                      // 只留一句告知（文案在私有 lib/hosted-wallet-notice.ts）。
                      <div className="wc-wallet-state wc-wallet-state--notice" role="note">
                        <AlertCircle aria-hidden="true" />
                        {HOSTED_WALLET_NOTICE}
                      </div>
                    ) : (
                      <>
                        {productsStatus === "loading" &&
                        !walletProducts.length &&
                        !customCreditTopUp ? (
                          <div className="wc-wallet-state">
                            <LoaderCircle className="is-spinning" aria-hidden="true" />
                            正在加载商品
                          </div>
                        ) : productsStatus === "error" &&
                          !walletProducts.length &&
                          !customCreditTopUp ? (
                          <div className="wc-wallet-state is-error">
                            <AlertCircle aria-hidden="true" />
                            {walletError || "商品暂时无法获取"}
                            <button type="button" onClick={() => void loadProducts(true)}>
                              重试
                            </button>
                          </div>
                        ) : walletProducts.length || customCreditTopUp ? (
                          <div className="wc-wallet-products" role="listbox" aria-label="充值商品">
                            {walletProducts.map((product) => (
                              <button
                                type="button"
                                role="option"
                                aria-selected={selectedProductId === product.id}
                                className={`wc-wallet-product ${selectedProductId === product.id ? "is-selected" : ""}`}
                                key={product.id}
                                onClick={() => {
                                  setSelectedProductId(product.id);
                                  setOrderError(null);
                                }}
                              >
                                <span className="wc-wallet-product-check">
                                  {selectedProductId === product.id ? (
                                    <Check aria-hidden="true" />
                                  ) : null}
                                </span>
                                <span className="wc-wallet-product-copy">
                                  <strong>{productLabel(product)}</strong>
                                  <small>{productDetail(product)}</small>
                                </span>
                                <b>¥{formatMoney(product.amount)}</b>
                              </button>
                            ))}
                            {customCreditTopUp ? (
                              <button
                                type="button"
                                role="option"
                                aria-selected={customTopUpSelected}
                                className={`wc-wallet-product ${customTopUpSelected ? "is-selected" : ""}`}
                                onClick={() => {
                                  setSelectedProductId(customCreditTopUp.productId);
                                  setCustomAmountInput(
                                    (current) => current || String(customCreditTopUp.minAmount),
                                  );
                                  setOrderError(null);
                                }}
                              >
                                <span className="wc-wallet-product-check">
                                  {customTopUpSelected ? <Check aria-hidden="true" /> : null}
                                </span>
                                <span className="wc-wallet-product-copy">
                                  <strong>自定义充值</strong>
                                  <small>
                                    {formatCredits(customCreditTopUp.creditsPerYuan)} 积分/元
                                  </small>
                                </span>
                                <b>¥{formatMoney(customCreditTopUp.minAmount)} 起</b>
                              </button>
                            ) : null}
                          </div>
                        ) : (
                          <div className="wc-wallet-state">暂时没有可购买的商品</div>
                        )}

                        {customTopUpSelected && customCreditTopUp ? (
                          <div className="wc-wallet-custom-topup">
                            <label htmlFor="wc-wallet-custom-amount">
                              <span>自定义金额</span>
                              <small>
                                ¥{formatMoney(customCreditTopUp.minAmount)} - ¥
                                {formatMoney(customCreditTopUp.maxAmount)}
                              </small>
                            </label>
                            <div
                              className={`wc-wallet-custom-amount ${customAmountValidation.error ? "is-error" : ""}`}
                            >
                              <span aria-hidden="true">¥</span>
                              <input
                                id="wc-wallet-custom-amount"
                                type="text"
                                inputMode="decimal"
                                autoComplete="off"
                                maxLength={10}
                                value={customAmountInput}
                                aria-invalid={Boolean(customAmountValidation.error)}
                                aria-describedby="wc-wallet-custom-amount-note"
                                disabled={paymentBusy || checkoutBlockedByOrder}
                                onChange={(event) => {
                                  setCustomAmountInput(event.target.value.replace(/[^\d.]/g, ""));
                                  setOrderError(null);
                                }}
                              />
                              <em>
                                {customAmountValidation.amount === null
                                  ? "积分"
                                  : `${formatCredits(customAmountValidation.amount * customCreditTopUp.creditsPerYuan)} 积分`}
                              </em>
                            </div>
                            <p
                              id="wc-wallet-custom-amount-note"
                              className={customAmountValidation.error ? "is-error" : ""}
                            >
                              {customAmountValidation.error ?? "金额最多保留两位小数"}
                            </p>
                          </div>
                        ) : null}

                        <div className="wc-wallet-payment-row">
                          <span>支付方式</span>
                          <div className="wc-wallet-segmented" role="group" aria-label="支付方式">
                            <button
                              type="button"
                              className={paymentMethod === "alipay" ? "is-active" : ""}
                              aria-pressed={paymentMethod === "alipay"}
                              disabled={paymentBusy || checkoutBlockedByOrder}
                              onClick={() => setPaymentMethod("alipay")}
                            >
                              <Landmark aria-hidden="true" />
                              支付宝
                            </button>
                          </div>
                        </div>
                        <button
                          type="button"
                          className="wc-account-submit wc-wallet-checkout"
                          disabled={
                            !selectedCheckoutRequest || paymentBusy || checkoutBlockedByOrder
                          }
                          onClick={() => void startCheckout()}
                        >
                          {paymentBusy ? (
                            <LoaderCircle className="is-spinning" aria-hidden="true" />
                          ) : selectedProduct?.kind === "collaboration_seat" ? (
                            <UserPlus aria-hidden="true" />
                          ) : (
                            <Coins aria-hidden="true" />
                          )}
                          {checkoutBlockedByOrder
                            ? "请先处理待支付订单"
                            : selectedCheckoutAmount !== null
                              ? `立即支付 ¥${formatMoney(selectedCheckoutAmount)}`
                              : customTopUpSelected
                                ? "请填写有效金额"
                                : "请选择商品"}
                        </button>
                      </>
                    )}
                  </section>

                  <div className="wc-wallet-side-column">
                    <section className="wc-wallet-section wc-wallet-redeem-section">
                      <div className="wc-wallet-section-heading">
                        <div>
                          <strong>激活码</strong>
                          <span>兑换后余额会立即更新</span>
                        </div>
                        <Ticket aria-hidden="true" />
                      </div>
                      <form
                        className="wc-wallet-redeem-form"
                        onSubmit={(event) => void redeemCode(event)}
                      >
                        <input
                          value={activationCode}
                          onChange={(event) => setActivationCode(event.target.value.toUpperCase())}
                          placeholder="输入激活码"
                          autoCapitalize="characters"
                          autoComplete="off"
                          maxLength={64}
                          aria-label="激活码"
                        />
                        <button type="submit" disabled={redeeming || !activationCode.trim()}>
                          {redeeming ? (
                            <LoaderCircle className="is-spinning" aria-hidden="true" />
                          ) : (
                            "兑换"
                          )}
                        </button>
                      </form>
                      <div className="wc-wallet-choice-row wc-wallet-redeem-mode">
                        <span>会员码积分</span>
                        <div
                          className="wc-wallet-segmented"
                          role="group"
                          aria-label="激活码积分到账方式"
                        >
                          <button
                            type="button"
                            className={redeemGrantMode === "daily" ? "is-active" : ""}
                            aria-pressed={redeemGrantMode === "daily"}
                            onClick={() => {
                              redeemGrantModeTouched.current = true;
                              setRedeemGrantMode("daily");
                            }}
                          >
                            每日积分
                          </button>
                          <button
                            type="button"
                            className={redeemGrantMode === "bundle" ? "is-active" : ""}
                            aria-pressed={redeemGrantMode === "bundle"}
                            onClick={() => {
                              redeemGrantModeTouched.current = true;
                              setRedeemGrantMode("bundle");
                            }}
                          >
                            永久积分
                          </button>
                        </div>
                      </div>
                    </section>

                    {persistedOrder ? (
                      <section className="wc-wallet-section wc-wallet-order-section">
                        <div className="wc-wallet-section-heading">
                          <div>
                            <strong>待处理订单</strong>
                            <span>{persistedOrder.orderNo}</span>
                          </div>
                          <RefreshCw
                            className={
                              !orderPollingTimedOut &&
                              (paymentOrder?.status === "pending" ||
                                paymentOrder?.status === "processing")
                                ? "is-spinning"
                                : ""
                            }
                            aria-hidden="true"
                          />
                        </div>
                        {paymentOrder ? (
                          <div
                            className={`wc-wallet-order-status ${orderStatusClass(paymentOrder.status)}`}
                          >
                            <span>
                              {paymentOrder.status === "paid" ? (
                                <Check aria-hidden="true" />
                              ) : paymentOrder.status === "failed" ||
                                paymentOrder.status === "refunded" ? (
                                <AlertCircle aria-hidden="true" />
                              ) : orderPollingTimedOut ? (
                                <RefreshCw aria-hidden="true" />
                              ) : (
                                <LoaderCircle className="is-spinning" aria-hidden="true" />
                              )}
                            </span>
                            <strong>{orderStatusLabel(paymentOrder.status)}</strong>
                            <small>
                              {paymentOrder.status === "failed"
                                ? "可以重新下单"
                                : paymentOrder.status === "refunded"
                                  ? "席位权益已撤销，可以重新购买"
                                  : paymentOrder.status === "paid"
                                    ? paidOrderMessage(paymentOrder)
                                    : orderPollingTimedOut
                                      ? "仍待确认，可手动刷新"
                                      : "页面保持打开即可自动确认"}
                            </small>
                          </div>
                        ) : (
                          <div className="wc-wallet-order-status is-pending">
                            {orderPollingTimedOut ? (
                              <RefreshCw aria-hidden="true" />
                            ) : (
                              <LoaderCircle className="is-spinning" aria-hidden="true" />
                            )}
                            <strong>等待查询订单</strong>
                            <small>
                              {orderPollingTimedOut
                                ? "仍待确认，可手动刷新"
                                : "支付完成后会自动确认"}
                            </small>
                          </div>
                        )}
                        <div className="wc-wallet-order-actions">
                          {paymentOrder?.status === "failed" ||
                          paymentOrder?.status === "refunded" ? (
                            <button
                              type="button"
                              disabled={paymentBusy}
                              onClick={() =>
                                void startCheckout(checkoutRequestFromOrder(persistedOrder))
                              }
                            >
                              <RotateCcw aria-hidden="true" />
                              重新下单
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => openCashier(persistedOrder.checkoutUrl)}
                            >
                              <ExternalLink aria-hidden="true" />
                              打开收银台
                            </button>
                          )}
                          {orderPollingTimedOut && paymentOrder?.status !== "failed" ? (
                            <button type="button" onClick={stopTrackingOrder}>
                              <X aria-hidden="true" />
                              停止跟踪
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => void pollOrder()}
                            disabled={!pageVisible || paymentBusy}
                          >
                            <RefreshCw aria-hidden="true" />
                            刷新状态
                          </button>
                        </div>
                        {orderError ? (
                          <p className="wc-wallet-inline-error" role="alert">
                            {orderError}
                          </p>
                        ) : null}
                      </section>
                    ) : paymentOrder?.status === "paid" || paymentOrder?.status === "refunded" ? (
                      <section className="wc-wallet-section wc-wallet-order-section is-complete">
                        <div className="wc-wallet-section-heading">
                          <div>
                            <strong>最近支付</strong>
                            <span>{paymentOrder.orderNo}</span>
                          </div>
                          {paymentOrder.status === "paid" ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <AlertCircle aria-hidden="true" />
                          )}
                        </div>
                        <div
                          className={`wc-wallet-order-status ${orderStatusClass(paymentOrder.status)}`}
                        >
                          {paymentOrder.status === "paid" ? (
                            <Check aria-hidden="true" />
                          ) : (
                            <AlertCircle aria-hidden="true" />
                          )}
                          <strong>{orderStatusLabel(paymentOrder.status)}</strong>
                          <small>
                            {paymentOrder.status === "paid"
                              ? paidOrderMessage(paymentOrder)
                              : "席位权益已撤销，可以重新购买"}
                          </small>
                        </div>
                      </section>
                    ) : null}
                  </div>
                </div>

                {(walletError || orderError) && !persistedOrder ? (
                  <div className="wc-account-error wc-wallet-error" role="alert">
                    <AlertCircle aria-hidden="true" />
                    {orderError || walletError}
                  </div>
                ) : null}

                <section className="wc-wallet-ledger-section">
                  <div className="wc-wallet-section-heading">
                    <div>
                      <strong>最近流水</strong>
                      <span>展示最近 20 条积分变动</span>
                    </div>
                    <CalendarDays aria-hidden="true" />
                  </div>
                  {ledgerStatus === "loading" && !ledger.length ? (
                    <div className="wc-wallet-state">
                      <LoaderCircle className="is-spinning" aria-hidden="true" />
                      正在加载流水
                    </div>
                  ) : ledger.length ? (
                    <div className="wc-wallet-ledger" role="list">
                      {ledger.map((item) => (
                        <div className="wc-wallet-ledger-row" role="listitem" key={item.id}>
                          <span
                            className={`wc-wallet-ledger-dot ${item.delta >= 0 ? "is-positive" : "is-negative"}`}
                            aria-hidden="true"
                          />
                          <div>
                            <strong>{item.reasonLabel}</strong>
                            <small>
                              {formatDate(item.createdAt)}
                              {item.refId ? ` · ${item.refId}` : ""}
                            </small>
                          </div>
                          <b className={item.delta >= 0 ? "is-positive" : "is-negative"}>
                            {item.delta >= 0 ? "+" : ""}
                            {formatCredits(item.delta)}
                          </b>
                          <em>余额 {formatCredits(item.balanceAfter)}</em>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="wc-wallet-state">还没有积分流水</div>
                  )}
                  {ledgerStatus === "error" ? (
                    <button
                      type="button"
                      className="wc-wallet-ledger-retry"
                      onClick={() => void loadLedger(true)}
                    >
                      重新加载流水
                    </button>
                  ) : null}
                </section>
              </>
            )}
          </div>
        ) : (
          <div className="wc-account-auth-layout">
            <aside className="wc-account-auth-brand">
              <div className="wc-account-auth-copy">
                <span>创作空间</span>
                <strong>
                  从上次离开的地方
                  <br />
                  继续创作
                </strong>
                <p>一个账号，连接你的画布与资产。</p>
              </div>
              <div className="wc-account-auth-map" aria-hidden="true">
                <span className="wc-account-auth-path wc-account-auth-path--one" />
                <span className="wc-account-auth-path wc-account-auth-path--two" />
                <span className="wc-account-auth-node wc-account-auth-node--one">
                  <i />
                </span>
                <span className="wc-account-auth-node wc-account-auth-node--two">
                  <i />
                </span>
                <span className="wc-account-auth-node wc-account-auth-node--three">
                  <i />
                </span>
              </div>
              <div className="wc-account-auth-signature">
                <i />
                <span>纬线账号</span>
                <i />
                <span>创作资产</span>
              </div>
            </aside>

            <div className="wc-account-auth-main">
              <div className="wc-account-auth-intro">
                <span>{effectiveMode === "login" ? "欢迎回来" : "建立创作身份"}</span>
                <strong>{effectiveMode === "login" ? "登录你的创作空间" : "创建纬线账号"}</strong>
                <p>
                  {effectiveMode === "login"
                    ? "继续管理画布、资产与生成记录"
                    : "你的画布会跟随账号持续保存"}
                </p>
              </div>

              {capabilities.registration === "native" ? (
                <div className="wc-account-tabs" role="tablist" aria-label="账号方式">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveMode === "login"}
                    onClick={() => {
                      setFormError(null);
                      setMode("login");
                    }}
                  >
                    登录
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={effectiveMode === "register"}
                    onClick={() => {
                      setFormError(null);
                      setMode("register");
                    }}
                  >
                    注册
                  </button>
                </div>
              ) : null}

              <form className="wc-account-form" onSubmit={(event) => void submitIdentity(event)}>
                {effectiveMode === "register" ? (
                  <label htmlFor="wc-account-display-name">
                    <span>昵称</span>
                    <div className="wc-account-input-shell">
                      <UserRoundPen aria-hidden="true" />
                      <input
                        id="wc-account-display-name"
                        value={displayName}
                        maxLength={20}
                        autoComplete="nickname"
                        onChange={(event) => {
                          setDisplayName(event.target.value);
                          setFormError(null);
                        }}
                        placeholder="选填，2-20 字"
                      />
                    </div>
                  </label>
                ) : null}
                <label htmlFor="wc-account-email">
                  <span>邮箱</span>
                  <div className="wc-account-input-shell">
                    <Mail aria-hidden="true" />
                    <input
                      id="wc-account-email"
                      type="email"
                      required
                      value={email}
                      autoFocus
                      autoComplete="email"
                      onChange={(event) => {
                        setEmail(event.target.value);
                        setFormError(null);
                      }}
                      placeholder="name@example.com"
                    />
                  </div>
                </label>
                <label htmlFor="wc-account-password">
                  <span>密码</span>
                  <div className="wc-account-input-shell">
                    <LockKeyhole aria-hidden="true" />
                    <input
                      id="wc-account-password"
                      aria-label="密码"
                      type={showPassword ? "text" : "password"}
                      required
                      minLength={effectiveMode === "register" ? 10 : 1}
                      maxLength={128}
                      value={password}
                      autoComplete={effectiveMode === "login" ? "current-password" : "new-password"}
                      onChange={(event) => {
                        setPassword(event.target.value);
                        setFormError(null);
                      }}
                      placeholder={effectiveMode === "register" ? "至少 10 位" : "请输入密码"}
                    />
                    <button
                      type="button"
                      className="wc-account-password-toggle"
                      aria-label={showPassword ? "隐藏输入内容" : "显示输入内容"}
                      title={showPassword ? "隐藏密码" : "显示密码"}
                      onClick={() => setShowPassword((visible) => !visible)}
                    >
                      {showPassword ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    </button>
                  </div>
                </label>
                {effectiveMode === "register" ? (
                  <label htmlFor="wc-account-password-confirm">
                    <span>确认密码</span>
                    <div className="wc-account-input-shell">
                      <LockKeyhole aria-hidden="true" />
                      <input
                        id="wc-account-password-confirm"
                        aria-label="确认密码"
                        type={showPassword ? "text" : "password"}
                        required
                        minLength={10}
                        maxLength={128}
                        value={confirmPassword}
                        autoComplete="new-password"
                        onChange={(event) => {
                          setConfirmPassword(event.target.value);
                          setFormError(null);
                        }}
                        placeholder="再次输入密码"
                      />
                    </div>
                  </label>
                ) : null}
                {verificationEmail ? (
                  <div className="wc-account-verification" role="status">
                    <Check aria-hidden="true" />
                    <span>
                      注册已提交，请到 {verificationEmail} 查收验证邮件；验证后即可在这里登录。
                    </span>
                  </div>
                ) : null}
                {formError || identityError ? (
                  <div className="wc-account-error" role="alert">
                    <AlertCircle aria-hidden="true" />
                    {formError ?? identityError}
                  </div>
                ) : null}
                <button
                  type="submit"
                  className="wc-account-submit"
                  disabled={
                    busy || status === "loading" || capabilities.registration === "disabled"
                  }
                >
                  {busy || status === "loading" ? (
                    <LoaderCircle className="is-spinning" aria-hidden="true" />
                  ) : (
                    <ArrowRight aria-hidden="true" />
                  )}
                  <span>{effectiveMode === "login" ? "进入画布" : "创建账号"}</span>
                </button>
                {capabilities.registration === "external" ? (
                  <div className="wc-account-external-links">
                    <span>注册与密码找回在官网完成</span>
                    <div>
                      {capabilities.registrationUrl ? (
                        <a href={capabilities.registrationUrl} target="_blank" rel="noreferrer">
                          注册账号
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : null}
                      {capabilities.passwordResetUrl ? (
                        <a href={capabilities.passwordResetUrl} target="_blank" rel="noreferrer">
                          找回密码
                          <ExternalLink aria-hidden="true" />
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : capabilities.registration === "disabled" ? (
                  <p className="wc-account-external-note">
                    当前部署暂不开放注册，请使用已有账号登录。
                  </p>
                ) : effectiveMode === "login" && capabilities.passwordResetUrl ? (
                  <div className="wc-account-external-links">
                    <a href={capabilities.passwordResetUrl} target="_blank" rel="noreferrer">
                      找回密码
                      <ExternalLink aria-hidden="true" />
                    </a>
                  </div>
                ) : null}
                {status === "unavailable" ? (
                  <button
                    type="button"
                    className="wc-account-retry"
                    onClick={() => void hydrate(true)}
                    disabled={busy}
                  >
                    重新连接账号服务
                  </button>
                ) : null}
              </form>
            </div>
          </div>
        )}
      </section>
    </div>,
    document.body,
  );
}
