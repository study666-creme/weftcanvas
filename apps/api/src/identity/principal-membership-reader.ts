import type { WalletSummary } from "@kachang/contracts";
import type { Pool } from "pg";

export type PrincipalMembership = WalletSummary["membership"];

export interface PrincipalMembershipReader {
  readMembership(principalId: string): Promise<PrincipalMembership>;
}

type MembershipRow = {
  membership_tier: string | null;
  membership_until: Date | string | null;
  membership_queued_tier: string | null;
  membership_queued_until: Date | string | null;
};

/**
 * Adapter for the shared Prompt Hub profile authority. It is deliberately
 * separate from the cloud-project domain so project code never needs to know
 * the provider's table shape.
 */
export class PostgresPrincipalMembershipReader implements PrincipalMembershipReader {
  constructor(private readonly pool: Pick<Pool, "query">, private readonly now: () => number = Date.now) {}

  async readMembership(principalId: string): Promise<PrincipalMembership> {
    const result = await this.pool.query<MembershipRow>(
      `SELECT membership_tier, membership_until, membership_queued_tier, membership_queued_until
       FROM public.profiles
       WHERE user_id = $1
       LIMIT 1`,
      [principalId],
    );
    const row = result.rows[0];
    if (!row) return inactiveMembership();

    const primaryUntil = dateMs(row.membership_until);
    const queuedUntil = dateMs(row.membership_queued_until);
    const now = this.now();
    if (row.membership_tier && (row.membership_until === null || (primaryUntil !== null && primaryUntil > now))) {
      return membership(row.membership_tier, row.membership_until, row.membership_queued_tier, row.membership_queued_until, true);
    }
    if (row.membership_queued_tier && queuedUntil && queuedUntil > now) {
      return membership(row.membership_queued_tier, row.membership_queued_until, null, null, true);
    }
    return inactiveMembership();
  }
}

function membership(
  tier: string,
  until: Date | string | null,
  queuedTier: string | null,
  queuedUntil: Date | string | null,
  active: boolean,
): PrincipalMembership {
  return {
    tier: tier.trim() || null,
    until: dateIso(until),
    queuedTier: queuedTier?.trim() || null,
    queuedUntil: dateIso(queuedUntil),
    active,
    genDiscount: null,
  };
}

function inactiveMembership(): PrincipalMembership {
  return {
    tier: null,
    until: null,
    queuedTier: null,
    queuedUntil: null,
    active: false,
    genDiscount: null,
  };
}

function dateMs(value: Date | string | null) {
  if (!value) return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function dateIso(value: Date | string | null) {
  if (!value) return null;
  const time = dateMs(value);
  return time === null ? null : new Date(time).toISOString();
}
