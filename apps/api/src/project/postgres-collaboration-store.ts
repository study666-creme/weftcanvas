import {
  cloudProjectInvitationStatusSchema,
  cloudProjectMemberRoleSchema,
  type CloudProjectInvitation,
  type CloudProjectMember,
} from "@weftcanvas/contracts";
import type { Pool, PoolClient } from "pg";

import { ensureCloudPrincipal } from "./principal.js";
import type {
  AcceptCloudProjectInvitationResult,
  CloudProjectCollaborationStore,
  CloudProjectInvitationRecord,
  CloudProjectMemberRecord,
  CreateCloudProjectInvitationInput,
  CreateCloudProjectInvitationResult,
  RemoveCloudProjectMemberResult,
} from "./collaboration-store.js";
import {
  COLLABORATION_FREE_ACCESS_ENABLED,
  collaborationLimit,
  FREE_COLLABORATOR_LIMIT,
  INCLUDED_COLLABORATOR_LIMIT,
  MAX_COLLABORATOR_LIMIT,
} from "./collaboration-seat-entitlements.js";
import { CloudProjectAccessAmbiguousError as AmbiguousAccess } from "./collaboration-store.js";

type QueryClient = Pick<Pool, "query"> | Pick<PoolClient, "query">;
const COLLABORATION_SEAT_PRODUCT_ID = "canvas-collaboration-seat-1";

type MemberRow = {
  owner_id: string;
  project_id: string;
  principal_id: string;
  role: string;
  created_at: Date | string;
};

type InvitationRow = {
  id: string;
  owner_id: string;
  project_id: string;
  inviter_id: string;
  invitee_id: string;
  role: string;
  status: string;
  created_at: Date | string;
  expires_at: Date | string;
  accepted_at: Date | string | null;
};

export class PostgresCloudProjectCollaborationStore implements CloudProjectCollaborationStore {
  constructor(private readonly pool: Pool) {}

  async findAccess(projectId: string, principalId: string, ownerId?: string) {
    if (ownerId) {
      const result = await this.pool.query<MemberRow>(
        `${memberSelect()} WHERE owner_id = $1 AND project_id = $2 AND principal_id = $3 LIMIT 1`,
        [ownerId, projectId, principalId],
      );
      return result.rows[0] ? memberRecord(result.rows[0]) : null;
    }
    const result = await this.pool.query<MemberRow>(
      `${memberSelect()} WHERE project_id = $1 AND principal_id = $2
       ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, owner_id ASC LIMIT 2`,
      [projectId, principalId],
    );
    if (result.rows[0]?.role !== "owner" && result.rows.length > 1) {
      throw new AmbiguousAccess(projectId, principalId);
    }
    return result.rows[0] ? memberRecord(result.rows[0]) : null;
  }

  async findInvitationOwner(invitationId: string, principalId: string) {
    const result = await this.pool.query<{ owner_id: string }>(
      `SELECT owner_id FROM canvas_cloud_project_invitations
       WHERE id = $1 AND invitee_id = $2
       LIMIT 1`,
      [invitationId, principalId],
    );
    return result.rows[0]?.owner_id ?? null;
  }

  async listMembers(ownerId: string, projectId: string) {
    const result = await this.pool.query<MemberRow>(
      `${memberSelect()} WHERE owner_id = $1 AND project_id = $2
       ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END, created_at ASC, principal_id ASC LIMIT 100`,
      [ownerId, projectId],
    );
    return result.rows.map((row) => publicMember(memberRecord(row)));
  }

  async listMembersForActor(ownerId: string, projectId: string, principalId: string) {
    const result = await this.pool.query<MemberRow>(
      `${memberSelect("member")}
       WHERE member.owner_id = $1 AND member.project_id = $2
         AND EXISTS (
           SELECT 1 FROM canvas_cloud_project_members AS actor
           WHERE actor.owner_id = member.owner_id
             AND actor.project_id = member.project_id
             AND actor.principal_id = $3
             AND actor.role = 'member'
         )
       ORDER BY CASE member.role WHEN 'owner' THEN 0 ELSE 1 END,
         member.created_at ASC, member.principal_id ASC LIMIT 100`,
      [ownerId, projectId, principalId],
    );
    return result.rows.length > 0
      ? result.rows.map((row) => publicMember(memberRecord(row)))
      : null;
  }

  async countOccupiedSeats(ownerId: string, now: string) {
    const result = await this.pool.query<{ count: number | string }>(
      `SELECT COUNT(*)::INTEGER AS count FROM (
         SELECT principal_id FROM canvas_cloud_project_members
         WHERE owner_id = $1 AND role = 'member'
         UNION
         SELECT invitee_id AS principal_id FROM canvas_cloud_project_invitations
         WHERE owner_id = $1 AND status = 'pending' AND expires_at > $2
       ) AS occupied_seats`,
      [ownerId, now],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async listProjectInvitations(ownerId: string, projectId: string, now: string, limit: number) {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE canvas_cloud_project_invitations
         SET status = 'expired'
         WHERE owner_id = $1 AND project_id = $2
           AND status = 'pending' AND expires_at <= $3`,
        [ownerId, projectId, now],
      );
      const result = await client.query<InvitationRow>(
        `${invitationSelect()} WHERE owner_id = $1 AND project_id = $2 AND status = 'pending'
         ORDER BY created_at DESC, id DESC LIMIT $3`,
        [ownerId, projectId, limit],
      );
      return result.rows.map((row) => publicInvitation(invitationRecord(row)));
    });
  }

  async createInvitation(
    input: CreateCloudProjectInvitationInput,
  ): Promise<CreateCloudProjectInvitationResult> {
    return withTransaction(this.pool, async (client) => {
      await lockOwner(client, input.ownerId);
      const memberLimit = await transactionalMemberLimit(client, input.ownerId, input.memberLimit);
      const project = await client.query(
        `SELECT 1 FROM canvas_cloud_projects WHERE owner_id = $1 AND id = $2 FOR SHARE`,
        [input.ownerId, input.projectId],
      );
      if (!project.rowCount) return { kind: "project_not_found" };

      // Pending invitations reserve seats. Expire old reservations inside the
      // same owner lock so an invitation nobody opens cannot block the only
      // default collaborator seat forever.
      await client.query(
        `UPDATE canvas_cloud_project_invitations
         SET status = 'expired'
         WHERE owner_id = $1
           AND status = 'pending' AND expires_at <= $2`,
        [input.ownerId, input.createdAt],
      );

      await ensureCloudPrincipal(client, input.inviteeId, input.createdAt);
      const member = await client.query(
        `SELECT 1 FROM canvas_cloud_project_members
         WHERE owner_id = $1 AND project_id = $2 AND principal_id = $3`,
        [input.ownerId, input.projectId, input.inviteeId],
      );
      if (member.rowCount) return { kind: "already_member" };

      const existing = await client.query<InvitationRow>(
        `${invitationSelect()} WHERE owner_id = $1 AND project_id = $2
         AND invitee_id = $3 AND status = 'pending'
         FOR UPDATE`,
        [input.ownerId, input.projectId, input.inviteeId],
      );
      if (existing.rows[0])
        return { kind: "duplicate", invitation: invitationRecord(existing.rows[0]) };

      const occupied = await client.query<{ count: number | string; already_occupies: boolean }>(
        `SELECT COUNT(*)::INTEGER AS count,
           COALESCE(BOOL_OR(principal_id = $2), FALSE) AS already_occupies
         FROM (
           SELECT principal_id FROM canvas_cloud_project_members
           WHERE owner_id = $1 AND role = 'member'
           UNION
           SELECT invitee_id AS principal_id FROM canvas_cloud_project_invitations
           WHERE owner_id = $1 AND status = 'pending'
         ) AS occupied_seats`,
        [input.ownerId, input.inviteeId],
      );
      const seat = occupied.rows[0];
      if (Number(seat?.count ?? 0) >= memberLimit && !seat?.already_occupies) {
        return { kind: "seat_limit" };
      }

      const inserted = await client.query<InvitationRow>(
        `INSERT INTO canvas_cloud_project_invitations (
          id, owner_id, project_id, inviter_id, invitee_id, role, status,
          created_at, expires_at, accepted_at
        ) VALUES ($1, $2, $3, $4, $5, 'member', 'pending', $6, $7, NULL)
        RETURNING id, owner_id, project_id, inviter_id, invitee_id, role, status,
          created_at, expires_at, accepted_at`,
        [
          input.id,
          input.ownerId,
          input.projectId,
          input.inviterId,
          input.inviteeId,
          input.createdAt,
          input.expiresAt,
        ],
      );
      return { kind: "created", invitation: invitationRecord(inserted.rows[0]!) };
    });
  }

  async listInvitations(principalId: string, now: string, limit: number) {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE canvas_cloud_project_invitations
         SET status = 'expired'
         WHERE invitee_id = $1 AND status = 'pending' AND expires_at <= $2`,
        [principalId, now],
      );
      const result = await client.query<InvitationRow>(
        `${invitationSelect()} WHERE invitee_id = $1
         ORDER BY created_at DESC, id DESC LIMIT $2`,
        [principalId, limit],
      );
      return result.rows.map((row) => publicInvitation(invitationRecord(row)));
    });
  }

  async acceptInvitation(
    invitationId: string,
    principalId: string,
    now: string,
    memberLimit: number,
  ): Promise<AcceptCloudProjectInvitationResult> {
    return withTransaction(this.pool, async (client) => {
      const initial = await client.query<InvitationRow>(`${invitationSelect()} WHERE id = $1`, [
        invitationId,
      ]);
      const invitation = initial.rows[0];
      if (!invitation) return { kind: "not_found" };
      if (invitation.invitee_id !== principalId) return { kind: "not_target" };
      await lockOwner(client, invitation.owner_id);
      const effectiveMemberLimit = await transactionalMemberLimit(
        client,
        invitation.owner_id,
        memberLimit,
      );

      const locked = await client.query<InvitationRow>(
        `${invitationSelect()} WHERE id = $1 FOR UPDATE`,
        [invitationId],
      );
      const current = locked.rows[0];
      if (!current) return { kind: "not_found" };
      if (current.invitee_id !== principalId) return { kind: "not_target" };
      if (
        current.status === "pending" &&
        Date.parse(dateIso(current.expires_at)) <= Date.parse(now)
      ) {
        await client.query(
          `UPDATE canvas_cloud_project_invitations SET status = 'expired' WHERE id = $1`,
          [invitationId],
        );
        return { kind: "expired" };
      }
      if (current.status === "accepted") {
        const existing = await client.query<MemberRow>(
          `${memberSelect()} WHERE owner_id = $1 AND project_id = $2 AND principal_id = $3`,
          [current.owner_id, current.project_id, principalId],
        );
        if (!existing.rows[0]) return { kind: "invalid_status" };
        return { kind: "already_accepted", member: memberRecord(existing.rows[0]) };
      }
      if (current.status !== "pending") return { kind: "invalid_status" };

      const occupied = await client.query<{ count: number | string; already_occupies: boolean }>(
        `SELECT COUNT(DISTINCT principal_id)::INTEGER AS count,
           COALESCE(BOOL_OR(principal_id = $2), FALSE) AS already_occupies
         FROM canvas_cloud_project_members
         WHERE owner_id = $1 AND role = 'member'`,
        [current.owner_id, principalId],
      );
      const seat = occupied.rows[0];
      if (Number(seat?.count ?? 0) >= effectiveMemberLimit && !seat?.already_occupies) {
        return { kind: "seat_limit" };
      }

      await ensureCloudPrincipal(client, principalId, now);
      const inserted = await client.query<MemberRow>(
        `INSERT INTO canvas_cloud_project_members (owner_id, project_id, principal_id, role, created_at)
         VALUES ($1, $2, $3, 'member', $4)
         ON CONFLICT (owner_id, project_id, principal_id) DO NOTHING
         RETURNING owner_id, project_id, principal_id, role, created_at`,
        [current.owner_id, current.project_id, principalId, now],
      );
      const member =
        inserted.rows[0] ??
        (
          await client.query<MemberRow>(
            `${memberSelect()} WHERE owner_id = $1 AND project_id = $2 AND principal_id = $3`,
            [current.owner_id, current.project_id, principalId],
          )
        ).rows[0];
      if (!member) return { kind: "invalid_status" };
      await client.query(
        `UPDATE canvas_cloud_project_invitations
         SET status = 'accepted', accepted_at = $2
         WHERE id = $1`,
        [invitationId, now],
      );
      return { kind: "accepted", member: memberRecord(member) };
    });
  }

  async revokeInvitation(ownerId: string, projectId: string, invitationId: string) {
    return withTransaction(this.pool, async (client) => {
      await lockOwner(client, ownerId);
      const result = await client.query(
        `UPDATE canvas_cloud_project_invitations
         SET status = 'revoked'
         WHERE id = $1 AND owner_id = $2 AND project_id = $3 AND status = 'pending'`,
        [invitationId, ownerId, projectId],
      );
      return result.rowCount ? { kind: "revoked" as const } : { kind: "not_found" as const };
    });
  }

  async declineInvitation(invitationId: string, principalId: string) {
    return withTransaction(this.pool, async (client) => {
      const invitation = await client.query<InvitationRow>(
        `${invitationSelect()} WHERE id = $1 AND invitee_id = $2`,
        [invitationId, principalId],
      );
      const current = invitation.rows[0];
      if (!current) return { kind: "not_found" as const };
      await lockOwner(client, current.owner_id);
      const result = await client.query(
        `UPDATE canvas_cloud_project_invitations
         SET status = 'revoked'
         WHERE id = $1 AND invitee_id = $2 AND status = 'pending'`,
        [invitationId, principalId],
      );
      return result.rowCount ? { kind: "revoked" as const } : { kind: "not_found" as const };
    });
  }

  async removeMember(
    ownerId: string,
    projectId: string,
    principalId: string,
  ): Promise<RemoveCloudProjectMemberResult> {
    return withTransaction(this.pool, async (client) => {
      await lockOwner(client, ownerId);
      const result = await client.query(
        `DELETE FROM canvas_cloud_project_members
         WHERE owner_id = $1 AND project_id = $2 AND principal_id = $3 AND role = 'member'`,
        [ownerId, projectId, principalId],
      );
      if (!result.rowCount) return { kind: "not_found" };
      await client.query(
        `UPDATE canvas_cloud_project_invitations
         SET status = 'revoked'
         WHERE owner_id = $1 AND project_id = $2 AND invitee_id = $3 AND status = 'pending'`,
        [ownerId, projectId, principalId],
      );
      return { kind: "removed" };
    });
  }
}

function memberSelect(alias?: string) {
  const prefix = alias ? `${alias}.` : "";
  const table = alias ? `canvas_cloud_project_members AS ${alias}` : "canvas_cloud_project_members";
  return `SELECT ${prefix}owner_id, ${prefix}project_id, ${prefix}principal_id,
    ${prefix}role, ${prefix}created_at FROM ${table}`;
}

function invitationSelect() {
  return `SELECT id, owner_id, project_id, inviter_id, invitee_id, role, status,
    created_at, expires_at, accepted_at
    FROM canvas_cloud_project_invitations`;
}

function memberRecord(row: MemberRow): CloudProjectMemberRecord {
  return {
    ownerId: row.owner_id,
    projectId: row.project_id,
    principalId: row.principal_id,
    role: cloudProjectMemberRoleSchema.parse(row.role),
    createdAt: dateIso(row.created_at),
  };
}

function publicMember(member: CloudProjectMemberRecord): CloudProjectMember {
  const { ownerId: _ownerId, ...value } = member;
  return value;
}

function invitationRecord(row: InvitationRow): CloudProjectInvitationRecord {
  const role = row.role === "member" ? "member" : row.role;
  return {
    ownerId: row.owner_id,
    id: row.id,
    projectId: row.project_id,
    inviterId: row.inviter_id,
    inviteeId: row.invitee_id,
    role: role as "member",
    status: cloudProjectInvitationStatusSchema.parse(row.status),
    createdAt: dateIso(row.created_at),
    expiresAt: dateIso(row.expires_at),
    acceptedAt: row.accepted_at ? dateIso(row.accepted_at) : null,
  };
}

function publicInvitation(invitation: CloudProjectInvitationRecord): CloudProjectInvitation {
  const { ownerId: _ownerId, ...value } = invitation;
  return value;
}

async function lockOwner(client: QueryClient, ownerId: string) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [ownerId]);
}

async function transactionalMemberLimit(
  client: QueryClient,
  ownerId: string,
  requestedLimit: number,
) {
  if (COLLABORATION_FREE_ACCESS_ENABLED) return FREE_COLLABORATOR_LIMIT;
  const requested =
    Number.isSafeInteger(requestedLimit) && requestedLimit >= INCLUDED_COLLABORATOR_LIMIT
      ? Math.min(requestedLimit, MAX_COLLABORATOR_LIMIT)
      : INCLUDED_COLLABORATOR_LIMIT;
  const relation = await client.query<{ relation_name: string | null }>(
    "SELECT to_regclass('public.canvas_collaboration_seat_purchases')::text AS relation_name",
  );
  if (!relation.rows[0]?.relation_name) return INCLUDED_COLLABORATOR_LIMIT;

  const result = await client.query<{ purchased_seats: string }>(
    `SELECT COALESCE(SUM(seat_count), 0)::text AS purchased_seats
     FROM canvas_collaboration_seat_purchases
     WHERE owner_id = $1
       AND product_id = $2
       AND revoked_at IS NULL`,
    [ownerId, COLLABORATION_SEAT_PRODUCT_ID],
  );
  return Math.min(requested, collaborationLimit(result.rows[0]?.purchased_seats));
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function dateIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Collaboration timestamp is invalid");
  return date.toISOString();
}
