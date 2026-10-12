import type { WalletSummary } from "@weftcanvas/contracts";

/**
 * Canvas's browser-owned API connection is currently in a free preview. Keep
 * the switch in one place so a future paid rollout can change the policy
 * without spreading membership checks through the settings and generation UI.
 */
export const CANVAS_API_FREE_PREVIEW_ENABLED = true;
export const CANVAS_API_ENTITLEMENT_LABEL = "标准会员权益 · 当前限免";

export type CanvasApiMembership = Pick<WalletSummary["membership"], "active" | "tier">;

export type CanvasApiAccessContext = {
  /** Authenticated accounts can be checked against membership; anonymous users
   * retain the local BYOK path because their key never enters Canvas storage. */
  authenticated: boolean;
  membership?: CanvasApiMembership | null;
  previewEnabled?: boolean;
};

export type CanvasApiAccessSource = "local" | "membership" | "preview" | "locked";

export type CanvasApiAccess = {
  allowed: boolean;
  memberEligible: boolean;
  preview: boolean;
  source: CanvasApiAccessSource;
};

const STANDARD_API_TIERS = new Set(["standard", "pro", "professional", "premium", "plus"]);

export function hasCanvasApiMembership(membership: CanvasApiMembership | null | undefined) {
  if (!membership?.active || !membership.tier) return false;
  return STANDARD_API_TIERS.has(membership.tier.trim().toLowerCase());
}

type CanvasApiMembershipInput = CanvasApiMembership | null | undefined;

/**
 * Resolve either a full access context or the wallet membership projection.
 * The membership-only form keeps settings callers independent from identity
 * state; a missing projection is treated as local/anonymous preview access.
 */
export function resolveCanvasApiAccess(context: CanvasApiAccessContext): CanvasApiAccess;
export function resolveCanvasApiAccess(membership: CanvasApiMembershipInput): CanvasApiAccess;
export function resolveCanvasApiAccess(
  input: CanvasApiAccessContext | CanvasApiMembershipInput,
): CanvasApiAccess {
  const context: CanvasApiAccessContext =
    input && "authenticated" in input
      ? input
      : {
          authenticated: input !== null && input !== undefined,
          membership: input,
        };
  const memberEligible = hasCanvasApiMembership(context.membership);
  const preview = context.previewEnabled ?? CANVAS_API_FREE_PREVIEW_ENABLED;
  if (!context.authenticated) {
    return { allowed: true, memberEligible, preview, source: "local" };
  }
  if (memberEligible) {
    return { allowed: true, memberEligible, preview, source: "membership" };
  }
  return { allowed: preview, memberEligible, preview, source: preview ? "preview" : "locked" };
}

/** The single UI/runtime gate for Canvas BYOK access. */
export function canUseCanvasApi(context: CanvasApiAccessContext): boolean;
export function canUseCanvasApi(membership: CanvasApiMembershipInput): boolean;
export function canUseCanvasApi(input: CanvasApiAccessContext | CanvasApiMembershipInput) {
  return resolveCanvasApiAccess(input as CanvasApiAccessContext).allowed;
}

export function canvasApiAccessLabel(access: Pick<CanvasApiAccess, "allowed" | "memberEligible">) {
  if (access.memberEligible) return "标准会员权益";
  return access.allowed ? CANVAS_API_ENTITLEMENT_LABEL : "需要标准会员";
}
