import type { CloudProjectInvitation, CloudProjectMember } from "@weftcanvas/contracts";

export type CloudProjectMemberRecord = CloudProjectMember & {
  ownerId: string;
};

export type CloudProjectInvitationRecord = CloudProjectInvitation & {
  ownerId: string;
};

export class CloudProjectAccessAmbiguousError extends Error {
  constructor(
    readonly projectId: string,
    readonly principalId: string,
  ) {
    super("Cloud project access is ambiguous without an owner id");
    this.name = "CloudProjectAccessAmbiguousError";
  }
}

export type CreateCloudProjectInvitationInput = {
  id: string;
  ownerId: string;
  projectId: string;
  inviterId: string;
  inviteeId: string;
  createdAt: string;
  expiresAt: string;
  memberLimit: number;
};

export type CreateCloudProjectInvitationResult =
  | { kind: "created"; invitation: CloudProjectInvitationRecord }
  | { kind: "duplicate"; invitation: CloudProjectInvitationRecord }
  | { kind: "already_member" }
  | { kind: "seat_limit" }
  | { kind: "project_not_found" };

export type AcceptCloudProjectInvitationResult =
  | { kind: "accepted"; member: CloudProjectMemberRecord }
  | { kind: "already_accepted"; member: CloudProjectMemberRecord }
  | { kind: "not_found" }
  | { kind: "not_target" }
  | { kind: "expired" }
  | { kind: "seat_limit" }
  | { kind: "invalid_status" };

export type RemoveCloudProjectMemberResult = { kind: "removed" } | { kind: "not_found" };

export type RevokeCloudProjectInvitationResult = { kind: "revoked" } | { kind: "not_found" };

export interface CloudProjectCollaborationStore {
  findAccess(
    projectId: string,
    principalId: string,
    ownerId?: string,
  ): Promise<CloudProjectMemberRecord | null>;
  findInvitationOwner(invitationId: string, principalId: string): Promise<string | null>;
  listMembers(ownerId: string, projectId: string): Promise<CloudProjectMember[]>;
  listMembersForActor(
    ownerId: string,
    projectId: string,
    principalId: string,
  ): Promise<CloudProjectMember[] | null>;
  countOccupiedSeats(ownerId: string, now: string): Promise<number>;
  listProjectInvitations(
    ownerId: string,
    projectId: string,
    now: string,
    limit: number,
  ): Promise<CloudProjectInvitation[]>;
  createInvitation(
    input: CreateCloudProjectInvitationInput,
  ): Promise<CreateCloudProjectInvitationResult>;
  listInvitations(
    principalId: string,
    now: string,
    limit: number,
  ): Promise<CloudProjectInvitation[]>;
  acceptInvitation(
    invitationId: string,
    principalId: string,
    now: string,
    memberLimit: number,
  ): Promise<AcceptCloudProjectInvitationResult>;
  revokeInvitation(
    ownerId: string,
    projectId: string,
    invitationId: string,
  ): Promise<RevokeCloudProjectInvitationResult>;
  declineInvitation(
    invitationId: string,
    principalId: string,
  ): Promise<RevokeCloudProjectInvitationResult>;
  removeMember(
    ownerId: string,
    projectId: string,
    principalId: string,
  ): Promise<RemoveCloudProjectMemberResult>;
}
