import type { Pool } from "pg";

export const COLLABORATION_FREE_ACCESS_ENABLED = true;
export const FREE_COLLABORATOR_LIMIT = 4;
export const INCLUDED_COLLABORATOR_LIMIT = 1;
export const MAX_COLLABORATOR_LIMIT = 100;
const COLLABORATION_SEAT_PRODUCT_ID = "canvas-collaboration-seat-1";

export type CollaborationSeatEntitlement = {
  limit: number;
};

export interface CollaborationSeatEntitlementResolver {
  resolve(ownerId: string): Promise<CollaborationSeatEntitlement>;
}

export class IncludedCollaborationSeatEntitlementResolver implements CollaborationSeatEntitlementResolver {
  async resolve(): Promise<CollaborationSeatEntitlement> {
    return { limit: INCLUDED_COLLABORATOR_LIMIT };
  }
}

export class PostgresCollaborationSeatEntitlementResolver implements CollaborationSeatEntitlementResolver {
  constructor(private readonly pool: Pick<Pool, "query">) {}

  async resolve(ownerId: string): Promise<CollaborationSeatEntitlement> {
    try {
      const result = await this.pool.query<{ purchased_seats: string }>(
        `SELECT COALESCE(SUM(seat_count), 0)::text AS purchased_seats
         FROM canvas_collaboration_seat_purchases
         WHERE owner_id = $1
           AND product_id = $2
           AND revoked_at IS NULL`,
        [ownerId, COLLABORATION_SEAT_PRODUCT_ID],
      );
      return { limit: collaborationLimit(result.rows[0]?.purchased_seats) };
    } catch {
      // Paid capacity is authorization state. Missing or unavailable ledger
      // data must never grant seats that cannot be proven.
      return { limit: INCLUDED_COLLABORATOR_LIMIT };
    }
  }
}

export async function resolveCollaborationSeatLimit(
  resolver: CollaborationSeatEntitlementResolver,
  ownerId: string,
) {
  if (COLLABORATION_FREE_ACCESS_ENABLED) return FREE_COLLABORATOR_LIMIT;
  try {
    const entitlement = await resolver.resolve(ownerId);
    return Number.isSafeInteger(entitlement.limit) && entitlement.limit >= 1
      ? Math.min(entitlement.limit, MAX_COLLABORATOR_LIMIT)
      : INCLUDED_COLLABORATOR_LIMIT;
  } catch {
    return INCLUDED_COLLABORATOR_LIMIT;
  }
}

export function collaborationLimit(purchasedSeatsValue: string | undefined) {
  if (!purchasedSeatsValue || !/^(?:0|[1-9][0-9]*)$/.test(purchasedSeatsValue)) {
    return INCLUDED_COLLABORATOR_LIMIT;
  }
  const purchasedSeats = Number(purchasedSeatsValue);
  if (!Number.isSafeInteger(purchasedSeats)) return INCLUDED_COLLABORATOR_LIMIT;
  return Math.min(INCLUDED_COLLABORATOR_LIMIT + purchasedSeats, MAX_COLLABORATOR_LIMIT);
}
