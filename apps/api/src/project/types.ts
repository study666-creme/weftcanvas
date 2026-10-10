import type {
  CanvasDocument,
  CloudProject,
  CloudProjectEntitlements,
  CloudProjectSharedSummary,
  CloudProjectSummary,
  CloudProjectUsage,
} from "@kachang/contracts";

export type CloudProjectRecord = CloudProject & {
  ownerId: string;
};

export type CloudProjectUsageRecord = Pick<CloudProjectUsage, "projectCount" | "projectStorageBytes" | "mediaStorageBytes">;

export type CreateCloudProjectStoreResult =
  | { kind: "created"; project: CloudProjectRecord }
  | { kind: "exists" }
  | { kind: "project_limit" }
  | { kind: "storage_limit" };

export type SaveCloudProjectStoreResult =
  | { kind: "saved"; project: CloudProjectRecord }
  | { kind: "not_found" }
  | { kind: "revision_conflict"; revision: number }
  | { kind: "storage_limit" };

export type DeleteCloudProjectStoreResult =
  | { kind: "deleted" }
  | { kind: "not_found" }
  | { kind: "revision_conflict"; revision: number };

export interface CloudProjectStore {
  list(ownerId: string, limit: number): Promise<CloudProjectSummary[]>;
  listForActor?(principalId: string, limit: number): Promise<CloudProjectSharedSummary[]>;
  get(ownerId: string, projectId: string): Promise<CloudProjectRecord | null>;
  getForActor?(ownerId: string, projectId: string, actorId: string): Promise<CloudProjectRecord | null>;
  usage(ownerId: string): Promise<CloudProjectUsageRecord>;
  create(project: CloudProjectRecord, checksum: string, entitlements: CloudProjectEntitlements): Promise<CreateCloudProjectStoreResult>;
  save(input: {
    project: CloudProjectRecord;
    baseRevision: number;
    checksum: string;
    checkpoint: boolean;
    entitlements: CloudProjectEntitlements;
    actorId?: string;
  }): Promise<SaveCloudProjectStoreResult>;
  delete(ownerId: string, projectId: string, baseRevision: number): Promise<DeleteCloudProjectStoreResult>;
}

export type ResolvedCloudProjectEntitlements = {
  data: CloudProjectEntitlements;
  refreshedToken?: string;
  expiresAt?: string;
};

export type CloudProjectEntitlementResolveOptions = {
  allowStale?: boolean;
};

export interface CloudProjectEntitlementResolver {
  resolve(
    ownerId: string,
    token?: string,
    options?: CloudProjectEntitlementResolveOptions,
  ): Promise<ResolvedCloudProjectEntitlements>;

  /** Resolve a principal without borrowing another caller's bearer token. */
  resolveForPrincipal?(
    principalId: string,
    options?: CloudProjectEntitlementResolveOptions,
  ): Promise<ResolvedCloudProjectEntitlements>;
}

export type CloudProjectServiceResult<T> = {
  data: T;
  refreshedToken?: string;
  expiresAt?: string;
};

export type CloudProjectActorAccess = {
  ownerId: string;
  projectId: string;
  principalId: string;
  role: "owner" | "member";
};

export interface CloudProjectAccessResolver {
  findAccess(projectId: string, principalId: string, ownerId?: string): Promise<CloudProjectActorAccess | null>;
}

export type CloudProjectDocumentWrite = {
  document: CanvasDocument;
  documentBytes: number;
  checksum: string;
  localMediaCount: number;
};
