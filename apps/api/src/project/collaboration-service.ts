import { randomUUID } from "node:crypto";

import {
  cloudProjectInvitationSchema,
  cloudProjectInviteRequestSchema,
  cloudProjectMemberListResponseSchema,
  cloudProjectMemberSchema,
  type CloudProjectInvitation,
  type CloudProjectMember,
} from "@weftcanvas/contracts";

import { StaticCloudProjectEntitlementResolver } from "./entitlements.js";
import {
  COLLABORATION_FREE_ACCESS_ENABLED,
  IncludedCollaborationSeatEntitlementResolver,
  resolveCollaborationSeatLimit,
  type CollaborationSeatEntitlementResolver,
} from "./collaboration-seat-entitlements.js";
import type { CloudProjectEntitlementResolver, CloudProjectServiceResult } from "./types.js";
import type { CloudProjectCollaborationStore } from "./collaboration-store.js";
import { CloudProjectAccessAmbiguousError } from "./collaboration-store.js";

const DEFAULT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export type CollaborationServiceErrorCode =
  | "COLLABORATION_PRO_REQUIRED"
  | "COLLABORATION_PROJECT_NOT_FOUND"
  | "COLLABORATION_PROJECT_OWNER_REQUIRED"
  | "COLLABORATION_FORBIDDEN"
  | "COLLABORATION_MEMBER_NOT_FOUND"
  | "COLLABORATION_SEAT_LIMIT_REACHED"
  | "COLLABORATION_INVITATION_EXISTS"
  | "COLLABORATION_ALREADY_MEMBER"
  | "COLLABORATION_INVITATION_NOT_FOUND"
  | "COLLABORATION_INVITATION_NOT_TARGET"
  | "COLLABORATION_INVITATION_EXPIRED"
  | "COLLABORATION_INVITATION_UNAVAILABLE";

export class CollaborationServiceError extends Error {
  constructor(
    readonly code: CollaborationServiceErrorCode,
    message: string,
    readonly status: 403 | 404 | 409,
  ) {
    super(message);
    this.name = "CollaborationServiceError";
  }
}

export class CloudProjectCollaborationService {
  private readonly now: () => number;
  private readonly invitationTtlMs: number;
  private readonly extraSeatPriceCny: number;
  private readonly seatEntitlements: CollaborationSeatEntitlementResolver;

  constructor(
    private readonly store: CloudProjectCollaborationStore,
    private readonly entitlements: CloudProjectEntitlementResolver = new StaticCloudProjectEntitlementResolver(),
    options: {
      now?: () => number;
      invitationTtlMs?: number;
      extraSeatPriceCny?: number;
      seatEntitlements?: CollaborationSeatEntitlementResolver;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.invitationTtlMs = options.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS;
    if (!Number.isSafeInteger(this.invitationTtlMs) || this.invitationTtlMs <= 0) {
      throw new Error("invitationTtlMs must be a positive safe integer");
    }
    this.extraSeatPriceCny = options.extraSeatPriceCny ?? 15;
    if (!Number.isFinite(this.extraSeatPriceCny) || this.extraSeatPriceCny <= 0) {
      throw new Error("extraSeatPriceCny must be positive");
    }
    this.seatEntitlements =
      options.seatEntitlements ?? new IncludedCollaborationSeatEntitlementResolver();
  }

  async listMembers(
    actorId: string,
    projectId: string,
    token?: string,
    ownerId?: string,
  ): Promise<
    CloudProjectServiceResult<{
      members: CloudProjectMember[];
      invitations: CloudProjectInvitation[];
      seatUsage?: { limit: number; used: number } | null;
    }>
  > {
    const access = await this.findAccess(projectId, actorId, ownerId);
    if (!access) throw projectNotFound();
    const resolved =
      access.role === "owner"
        ? undefined
        : await this.requireMemberAndOwnerPro(actorId, access.ownerId, token);
    const now = new Date(this.now()).toISOString();
    const [members, invitations] =
      access.role === "owner"
        ? await Promise.all([
            this.store.listMembers(access.ownerId, projectId),
            this.store.listProjectInvitations(access.ownerId, projectId, now, 100),
          ])
        : ([await this.store.listMembersForActor(access.ownerId, projectId, actorId), []] as const);
    if (!members) throw projectNotFound();
    const seatUsage =
      access.role === "owner"
        ? {
            limit: await resolveCollaborationSeatLimit(this.seatEntitlements, access.ownerId),
            used: await this.store.countOccupiedSeats(access.ownerId, now),
          }
        : null;
    const data = cloudProjectMemberListResponseSchema.shape.data.parse({
      members,
      invitations,
      seatUsage,
    });
    return resolved ? withRefresh(data, resolved) : { data };
  }

  async invite(
    actorId: string,
    projectId: string,
    value: unknown,
    token?: string,
  ): Promise<CloudProjectServiceResult<CloudProjectInvitation>> {
    const resolved = await this.requirePro(actorId, token);
    const input = cloudProjectInviteRequestSchema.parse(value);
    const access = await this.findAccess(projectId, actorId);
    if (!access) throw projectNotFound();
    if (access.role !== "owner") throw forbidden();
    if (input.inviteeId === actorId)
      throw new CollaborationServiceError(
        "COLLABORATION_ALREADY_MEMBER",
        "The project owner is already a member",
        409,
      );

    const now = new Date(this.now());
    const memberLimit = await resolveCollaborationSeatLimit(this.seatEntitlements, access.ownerId);
    const result = await this.store.createInvitation({
      id: randomUUID(),
      ownerId: access.ownerId,
      projectId,
      inviterId: actorId,
      inviteeId: input.inviteeId,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.invitationTtlMs).toISOString(),
      memberLimit,
    });
    if (result.kind === "project_not_found") throw projectNotFound();
    if (result.kind === "already_member")
      throw new CollaborationServiceError(
        "COLLABORATION_ALREADY_MEMBER",
        "The invitee is already a project member",
        409,
      );
    if (result.kind === "duplicate")
      throw new CollaborationServiceError(
        "COLLABORATION_INVITATION_EXISTS",
        "A pending invitation already exists for this principal",
        409,
      );
    if (result.kind === "seat_limit") throw seatLimit(this.extraSeatPriceCny);
    return withRefresh(
      cloudProjectInvitationSchema.parse(publicInvitation(result.invitation)),
      resolved,
    );
  }

  async listInvitations(
    actorId: string,
    _token?: string, // 统一服务面形状；列邀请只查成员身份，不解析 Pro 权益
  ): Promise<
    CloudProjectServiceResult<{
      invitations: CloudProjectInvitation[];
    }>
  > {
    const invitations = await this.store.listInvitations(
      actorId,
      new Date(this.now()).toISOString(),
      100,
    );
    return {
      data: {
        invitations: invitations.map((invitation) =>
          cloudProjectInvitationSchema.parse(invitation),
        ),
      },
    };
  }

  async acceptInvitation(
    actorId: string,
    invitationId: string,
    token?: string,
  ): Promise<CloudProjectServiceResult<CloudProjectMember>> {
    const resolved = await this.requirePro(actorId, token);
    const ownerId = await this.store.findInvitationOwner(invitationId, actorId);
    if (!ownerId) throw invitationNotFound();
    await this.requireOwnerPro(ownerId);
    const memberLimit = await resolveCollaborationSeatLimit(this.seatEntitlements, ownerId);
    const result = await this.store.acceptInvitation(
      invitationId,
      actorId,
      new Date(this.now()).toISOString(),
      memberLimit,
    );
    if (result.kind === "not_found") throw invitationNotFound();
    if (result.kind === "not_target") throw invitationNotFound();
    if (result.kind === "expired") throw invitationExpired();
    if (result.kind === "invalid_status") throw invitationUnavailable();
    if (result.kind === "seat_limit") throw seatLimit(this.extraSeatPriceCny);
    return withRefresh(cloudProjectMemberSchema.parse(publicMember(result.member)), resolved);
  }

  async removeMember(
    actorId: string,
    projectId: string,
    memberId: string,
    _token?: string, // 统一服务面形状；移除成员只查 owner 角色，不解析 Pro 权益
  ): Promise<CloudProjectServiceResult<{ ok: true }>> {
    const access = await this.findAccess(projectId, actorId);
    if (!access) throw projectNotFound();
    if (access.role !== "owner") throw forbidden();
    if (memberId === actorId) throw forbidden();
    const result = await this.store.removeMember(access.ownerId, projectId, memberId);
    if (result.kind === "not_found")
      throw new CollaborationServiceError(
        "COLLABORATION_MEMBER_NOT_FOUND",
        "The project member was not found",
        404,
      );
    return { data: { ok: true as const } };
  }

  async revokeInvitation(
    actorId: string,
    projectId: string,
    invitationId: string,
  ): Promise<CloudProjectServiceResult<{ ok: true }>> {
    const access = await this.findAccess(projectId, actorId);
    if (!access) throw projectNotFound();
    if (access.role !== "owner") throw forbidden();
    const result = await this.store.revokeInvitation(access.ownerId, projectId, invitationId);
    if (result.kind === "not_found") throw invitationNotFound();
    return { data: { ok: true as const } };
  }

  async declineInvitation(
    actorId: string,
    invitationId: string,
  ): Promise<CloudProjectServiceResult<{ ok: true }>> {
    const result = await this.store.declineInvitation(invitationId, actorId);
    if (result.kind === "not_found") throw invitationNotFound();
    return { data: { ok: true as const } };
  }

  private async requirePro(actorId: string, token?: string) {
    const resolved = await this.entitlements.resolve(actorId, token, { allowStale: false });
    if (!COLLABORATION_FREE_ACCESS_ENABLED && !isProTier(resolved.data.tier))
      throw new CollaborationServiceError(
        "COLLABORATION_PRO_REQUIRED",
        "Project collaboration requires a Pro membership",
        403,
      );
    return resolved;
  }

  private async findAccess(projectId: string, actorId: string, ownerId?: string) {
    try {
      return await this.store.findAccess(projectId, actorId, ownerId);
    } catch (error) {
      if (error instanceof CloudProjectAccessAmbiguousError) {
        throw new CollaborationServiceError(
          "COLLABORATION_PROJECT_OWNER_REQUIRED",
          "Multiple shared projects use this id; specify the project owner",
          409,
        );
      }
      throw error;
    }
  }

  private async requireMemberAndOwnerPro(actorId: string, ownerId: string, token?: string) {
    const resolved = await this.requirePro(actorId, token);
    await this.requireOwnerPro(ownerId);
    return resolved;
  }

  private async requireOwnerPro(ownerId: string) {
    if (COLLABORATION_FREE_ACCESS_ENABLED) return;
    const owner = this.entitlements.resolveForPrincipal
      ? await this.entitlements.resolveForPrincipal(ownerId, { allowStale: false })
      : await this.entitlements.resolve(ownerId, undefined, { allowStale: false });
    if (!isProTier(owner.data.tier))
      throw new CollaborationServiceError(
        "COLLABORATION_PRO_REQUIRED",
        "Project collaboration requires an active Pro owner",
        403,
      );
    return owner;
  }
}

function isProTier(tier: string) {
  return ["pro", "professional", "premium", "plus"].includes(tier.trim().toLowerCase());
}

function publicMember(member: { ownerId: string } & CloudProjectMember) {
  const { ownerId: _ownerId, ...value } = member;
  return value;
}

function publicInvitation(invitation: CloudProjectInvitationRecordLike) {
  const { ownerId: _ownerId, ...value } = invitation;
  return value;
}

type CloudProjectInvitationRecordLike = CloudProjectInvitation & { ownerId: string };

function withRefresh<T>(
  data: T,
  resolved: Awaited<ReturnType<CloudProjectEntitlementResolver["resolve"]>>,
): CloudProjectServiceResult<T> {
  return {
    data,
    ...(resolved.refreshedToken ? { refreshedToken: resolved.refreshedToken } : {}),
    ...(resolved.expiresAt ? { expiresAt: resolved.expiresAt } : {}),
  };
}

function projectNotFound() {
  return new CollaborationServiceError(
    "COLLABORATION_PROJECT_NOT_FOUND",
    "Cloud project not found",
    404,
  );
}

function forbidden() {
  return new CollaborationServiceError(
    "COLLABORATION_FORBIDDEN",
    "Only the project owner can manage members",
    403,
  );
}

function invitationNotFound() {
  return new CollaborationServiceError(
    "COLLABORATION_INVITATION_NOT_FOUND",
    "Invitation not found",
    404,
  );
}

function invitationExpired() {
  return new CollaborationServiceError(
    "COLLABORATION_INVITATION_EXPIRED",
    "This invitation has expired",
    409,
  );
}

function invitationUnavailable() {
  return new CollaborationServiceError(
    "COLLABORATION_INVITATION_UNAVAILABLE",
    "This invitation is no longer pending",
    409,
  );
}

function seatLimit(extraSeatPriceCny: number) {
  if (COLLABORATION_FREE_ACCESS_ENABLED) {
    return new CollaborationServiceError(
      "COLLABORATION_SEAT_LIMIT_REACHED",
      "当前账号已达到协作人数上限（含所有者最多 5 人）",
      403,
    );
  }
  return new CollaborationServiceError(
    "COLLABORATION_SEAT_LIMIT_REACHED",
    `当前账号已用完协作席位；额外席位为每个 ${extraSeatPriceCny} 元`,
    403,
  );
}
