import { createHash } from "node:crypto";

import {
  canvasDocumentSchema,
  cloudProjectCreateRequestSchema,
  cloudProjectDeleteRequestSchema,
  cloudProjectSchema,
  cloudProjectSaveRequestSchema,
  cloudProjectSharedSummarySchema,
  cloudProjectSummarySchema,
  cloudProjectUsageSchema,
  type CloudProject,
  type CloudProjectDeleteRequest,
} from "@weftcanvas/contracts";
import { z } from "zod";

import { StaticCloudProjectEntitlementResolver } from "./entitlements.js";
import type { CloudProjectMediaValidator } from "./media-access.js";
import type {
  CloudProjectAccessResolver,
  CloudProjectEntitlementResolver,
  CloudProjectRecord,
  CloudProjectServiceResult,
  CloudProjectStore,
} from "./types.js";
import { CloudProjectAccessAmbiguousError } from "./collaboration-store.js";
import { COLLABORATION_FREE_ACCESS_ENABLED } from "./collaboration-seat-entitlements.js";

/** 会员降级后的存储调整期：7 天内不清理，贴士持续提醒。 */
const STORAGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** 存储宽限维护 + 读取（由 media 的 PostgresMetadataStore 提供）。 */
export type CloudProjectStorageGracePort = {
  maintainStorageGrace(
    ownerId: string,
    usedBytes: number,
    quotaBytes: number,
    fromTier: string,
    graceMs: number,
    now?: number,
  ): Promise<void>;
  readStorageGrace(
    ownerId: string,
  ): Promise<{ fromTier: string; quotaBytes: number; usageBytes: number; deadline: string } | null>;
};

const MAX_PROJECT_DOCUMENT_BYTES = 900 * 1024;
const MEDIA_ID_SCHEMA = z.string().uuid();

export type CloudProjectServiceErrorCode =
  | "CLOUD_PROJECT_NOT_FOUND"
  | "CLOUD_PROJECT_EXISTS"
  | "CLOUD_PROJECT_REVISION_CONFLICT"
  | "CLOUD_PROJECT_LIMIT_REACHED"
  | "CLOUD_PROJECT_STORAGE_LIMIT_REACHED"
  | "CLOUD_PROJECT_DOCUMENT_TOO_LARGE"
  | "CLOUD_PROJECT_ID_MISMATCH"
  | "CLOUD_PROJECT_OWNER_REQUIRED"
  | "CLOUD_PROJECT_MEDIA_INVALID"
  | "CLOUD_PROJECT_COLLABORATION_PRO_REQUIRED";

export class CloudProjectServiceError extends Error {
  constructor(
    readonly code: CloudProjectServiceErrorCode,
    message: string,
    readonly status: 403 | 404 | 409 | 413 | 422,
    readonly currentRevision: number | null = null,
  ) {
    super(message);
    this.name = "CloudProjectServiceError";
  }
}

export class CloudProjectService {
  private readonly now: () => number;
  private readonly access?: CloudProjectAccessResolver;
  private readonly mediaValidator?: CloudProjectMediaValidator;
  private readonly storageGrace?: CloudProjectStorageGracePort;

  constructor(
    private readonly store: CloudProjectStore,
    private readonly entitlements: CloudProjectEntitlementResolver = new StaticCloudProjectEntitlementResolver(),
    options: {
      now?: () => number;
      access?: CloudProjectAccessResolver;
      mediaValidator?: CloudProjectMediaValidator;
      storageGrace?: CloudProjectStorageGracePort;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.access = options.access;
    this.mediaValidator = options.mediaValidator;
    this.storageGrace = options.storageGrace;
  }

  async list(
    ownerId: string,
    token?: string,
  ): Promise<
    CloudProjectServiceResult<{
      projects: ReturnType<typeof cloudProjectSummarySchema.parse>[];
      sharedProjects: ReturnType<typeof cloudProjectSharedSummarySchema.parse>[];
      usage: ReturnType<typeof cloudProjectUsageSchema.parse>;
    }>
  > {
    const resolved = await this.entitlements.resolve(ownerId, token);
    const [projects, sharedProjects, usage] = await Promise.all([
      this.store.list(ownerId, 1_000),
      this.store.listForActor?.(ownerId, 1_000) ?? Promise.resolve([]),
      this.store.usage(ownerId),
    ]);
    // 宽限记录随 usage 一起维护与读取：超配额即建立/刷新 7 天调整期，回配
    // 额内即清除。写入失败不阻断 usage 返回（贴士缺数据好过列表不可用）。
    let storageGrace: z.infer<typeof cloudProjectUsageSchema>["storageGrace"] = null;
    if (this.storageGrace) {
      try {
        await this.storageGrace.maintainStorageGrace(
          ownerId,
          usage.mediaStorageBytes,
          resolved.data.mediaStorageBytes,
          resolved.data.tier,
          STORAGE_GRACE_MS,
          this.now(),
        );
        const grace = await this.storageGrace.readStorageGrace(ownerId);
        if (grace) {
          storageGrace = {
            fromTier: grace.fromTier,
            quotaBytes: grace.quotaBytes,
            usageBytes: grace.usageBytes,
            deadline: grace.deadline,
          };
        }
      } catch (error) {
        console.warn("storage grace maintenance failed", error);
      }
    }
    return withRefresh(
      {
        projects: projects.map((project) => cloudProjectSummarySchema.parse(project)),
        sharedProjects: sharedProjects.map((project) =>
          cloudProjectSharedSummarySchema.parse(project),
        ),
        usage: cloudProjectUsageSchema.parse({
          ...usage,
          entitlements: resolved.data,
          storageGrace,
        }),
      },
      resolved,
    );
  }

  async get(
    ownerId: string,
    projectId: string,
    token?: string,
  ): Promise<CloudProjectServiceResult<CloudProject>> {
    const resolved = await this.entitlements.resolve(ownerId, token);
    const project = await this.store.get(ownerId, projectId);
    if (!project) throw notFound();
    return withRefresh(publicProject(project), resolved);
  }

  /** Resolve an owner or accepted collaborator before exposing a document. */
  async getForActor(
    actorId: string,
    projectId: string,
    token?: string,
    ownerId?: string,
  ): Promise<CloudProjectServiceResult<CloudProject>> {
    if (!this.access) return this.get(actorId, projectId, token);
    const access = await this.findAccess(projectId, actorId, ownerId);
    if (!access) throw notFound();
    if (access.role === "owner") return this.get(actorId, projectId, token);
    const resolved = await this.requireCollaborationPro(actorId, token);
    await this.requireOwnerCollaborationPro(access.ownerId);
    const project = this.store.getForActor
      ? await this.store.getForActor(access.ownerId, projectId, actorId)
      : await this.store.get(access.ownerId, projectId);
    if (!project) throw notFound();
    return withRefresh(publicProject(project), resolved);
  }

  async resolveMediaAccess(
    actorId: string,
    projectId: string,
    token?: string,
  ): Promise<CloudProjectServiceResult<{ ownerId: string; mediaStorageBytes: number }>> {
    const access = this.access
      ? await this.findAccess(projectId, actorId)
      : await this.ownerAccess(actorId, projectId);
    if (!access) throw notFound();

    if (access.role === "owner") {
      if (access.ownerId !== actorId) throw notFound();
      const resolved = await this.entitlements.resolve(actorId, token, { allowStale: false });
      return withRefresh(
        {
          ownerId: access.ownerId,
          mediaStorageBytes: resolved.data.mediaStorageBytes,
        },
        resolved,
      );
    }

    const actorEntitlements = await this.requireCollaborationPro(actorId, token);
    const ownerEntitlements = await this.requireOwnerCollaborationPro(access.ownerId);
    return withRefresh(
      {
        ownerId: access.ownerId,
        mediaStorageBytes: ownerEntitlements.data.mediaStorageBytes,
      },
      actorEntitlements,
    );
  }

  async create(
    ownerId: string,
    value: unknown,
    token?: string,
  ): Promise<CloudProjectServiceResult<CloudProject>> {
    const input = cloudProjectCreateRequestSchema.parse(value);
    const resolved = await this.entitlements.resolve(ownerId, token, { allowStale: false });
    const write = documentWrite(input.document);
    await this.validateProjectMedia(ownerId, write.document.projectId, write.serverMediaIds);
    const timestamp = new Date(this.now()).toISOString();
    const project: CloudProjectRecord = {
      ownerId,
      schemaVersion: 1,
      id: write.document.projectId,
      title: write.document.title,
      revision: 1,
      documentBytes: write.documentBytes,
      localMediaCount: write.localMediaCount,
      document: write.document,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const result = await this.store.create(project, write.checksum, resolved.data);
    if (result.kind === "exists")
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_EXISTS",
        "This cloud project already exists",
        409,
      );
    if (result.kind === "project_limit") throw projectLimit();
    if (result.kind === "storage_limit") throw storageLimit();
    return withRefresh(publicProject(result.project), resolved);
  }

  async save(
    ownerId: string,
    projectId: string,
    value: unknown,
    token?: string,
  ): Promise<CloudProjectServiceResult<CloudProject>> {
    const input = cloudProjectSaveRequestSchema.parse(value);
    if (input.document.projectId !== projectId) {
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_ID_MISMATCH",
        "The path and document project ids differ",
        422,
      );
    }
    const resolved = await this.entitlements.resolve(ownerId, token, { allowStale: false });
    const existing = await this.store.get(ownerId, projectId);
    if (!existing) throw notFound();
    const write = documentWrite(input.document);
    await this.validateProjectMedia(ownerId, projectId, write.serverMediaIds);
    const project: CloudProjectRecord = {
      ...existing,
      title: write.document.title,
      revision: input.baseRevision + 1,
      documentBytes: write.documentBytes,
      localMediaCount: write.localMediaCount,
      document: write.document,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const result = await this.store.save({
      project,
      baseRevision: input.baseRevision,
      checksum: write.checksum,
      checkpoint: input.checkpoint,
      entitlements: resolved.data,
    });
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "revision_conflict") {
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_REVISION_CONFLICT",
        "The cloud project changed on another device",
        409,
        result.revision,
      );
    }
    if (result.kind === "storage_limit") throw storageLimit();
    return withRefresh(publicProject(result.project), resolved);
  }

  async saveForActor(
    actorId: string,
    projectId: string,
    value: unknown,
    token?: string,
    ownerId?: string,
  ): Promise<CloudProjectServiceResult<CloudProject>> {
    if (!this.access) return this.save(actorId, projectId, value, token);
    const access = await this.findAccess(projectId, actorId, ownerId);
    if (!access) throw notFound();
    if (access.role === "owner") return this.save(actorId, projectId, value, token);

    const input = cloudProjectSaveRequestSchema.parse(value);
    if (input.document.projectId !== projectId) {
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_ID_MISMATCH",
        "The path and document project ids differ",
        422,
      );
    }
    const actorEntitlements = await this.requireCollaborationPro(actorId, token);
    // A member's bearer token is not an authorization proof for the owner.
    // Resolve the owner independently, otherwise a high-tier collaborator
    // could spend the owner's lower-tier project quota.
    const resolved = await this.requireOwnerCollaborationPro(access.ownerId);
    const existing = await this.store.get(access.ownerId, projectId);
    if (!existing) throw notFound();
    const write = documentWrite(input.document);
    await this.validateProjectMedia(access.ownerId, projectId, write.serverMediaIds);
    const project: CloudProjectRecord = {
      ...existing,
      title: write.document.title,
      revision: input.baseRevision + 1,
      documentBytes: write.documentBytes,
      localMediaCount: write.localMediaCount,
      document: write.document,
      updatedAt: new Date(this.now()).toISOString(),
    };
    const result = await this.store.save({
      project,
      baseRevision: input.baseRevision,
      checksum: write.checksum,
      checkpoint: input.checkpoint,
      entitlements: resolved.data,
      actorId,
    });
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "revision_conflict") {
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_REVISION_CONFLICT",
        "The cloud project changed on another device",
        409,
        result.revision,
      );
    }
    if (result.kind === "storage_limit") throw storageLimit();
    return withRefresh(publicProject(result.project), actorEntitlements);
  }

  async delete(
    ownerId: string,
    projectId: string,
    value: CloudProjectDeleteRequest | unknown,
    token?: string,
  ) {
    const input = cloudProjectDeleteRequestSchema.parse(value);
    const resolved = await this.entitlements.resolve(ownerId, token);
    const result = await this.store.delete(ownerId, projectId, input.baseRevision);
    if (result.kind === "not_found") throw notFound();
    if (result.kind === "revision_conflict") {
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_REVISION_CONFLICT",
        "The cloud project changed on another device",
        409,
        result.revision,
      );
    }
    return withRefresh({ ok: true as const }, resolved);
  }

  private async requireCollaborationPro(actorId: string, token?: string) {
    const resolved = await this.entitlements.resolve(actorId, token, { allowStale: false });
    if (!COLLABORATION_FREE_ACCESS_ENABLED && !isProTier(resolved.data.tier)) {
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_COLLABORATION_PRO_REQUIRED",
        "Project collaboration requires a Pro membership",
        403,
      );
    }
    return resolved;
  }

  private async findAccess(projectId: string, actorId: string, ownerId?: string) {
    try {
      return await this.access!.findAccess(projectId, actorId, ownerId);
    } catch (error) {
      if (error instanceof CloudProjectAccessAmbiguousError) {
        throw new CloudProjectServiceError(
          "CLOUD_PROJECT_OWNER_REQUIRED",
          "Multiple shared projects use this id; specify the project owner",
          409,
        );
      }
      throw error;
    }
  }

  private async requireOwnerCollaborationPro(ownerId: string) {
    const resolved = this.entitlements.resolveForPrincipal
      ? await this.entitlements.resolveForPrincipal(ownerId, { allowStale: false })
      : await this.entitlements.resolve(ownerId, undefined, { allowStale: false });
    if (!COLLABORATION_FREE_ACCESS_ENABLED && !isProTier(resolved.data.tier)) {
      throw new CloudProjectServiceError(
        "CLOUD_PROJECT_COLLABORATION_PRO_REQUIRED",
        "Project collaboration requires an active Pro owner",
        403,
      );
    }
    return resolved;
  }

  private async ownerAccess(actorId: string, projectId: string) {
    const project = await this.store.get(actorId, projectId);
    return project
      ? {
          ownerId: actorId,
          projectId,
          principalId: actorId,
          role: "owner" as const,
        }
      : null;
  }

  private async validateProjectMedia(
    ownerId: string,
    projectId: string,
    mediaIds: readonly string[],
  ) {
    if (mediaIds.length === 0) return;
    if (!mediaIds.every((id) => MEDIA_ID_SCHEMA.safeParse(id).success)) throw invalidProjectMedia();
    if (
      !this.mediaValidator ||
      !(await this.mediaValidator.validateReadyMedia(ownerId, projectId, mediaIds))
    ) {
      throw invalidProjectMedia();
    }
  }
}

function documentWrite(value: unknown) {
  const document = canvasDocumentSchema.parse(value);
  const json = JSON.stringify(document);
  const documentBytes = Buffer.byteLength(json, "utf8");
  if (documentBytes > MAX_PROJECT_DOCUMENT_BYTES) {
    throw new CloudProjectServiceError(
      "CLOUD_PROJECT_DOCUMENT_TOO_LARGE",
      "The project document exceeds the current per-project limit",
      413,
    );
  }
  return {
    document,
    documentBytes,
    checksum: createHash("sha256").update(json, "utf8").digest("hex"),
    localMediaCount: document.nodes.reduce(
      (count, node) => (node.data.media?.source === "local" ? count + 1 : count),
      0,
    ),
    serverMediaIds: [
      ...new Set(
        document.nodes.flatMap((node) =>
          node.data.media?.serverId ? [node.data.media.serverId] : [],
        ),
      ),
    ],
  };
}

function publicProject(project: CloudProjectRecord) {
  const { ownerId: _ownerId, ...value } = project;
  return cloudProjectSchema.parse(value);
}

function withRefresh<T>(
  data: T,
  resolved: Awaited<ReturnType<CloudProjectEntitlementResolver["resolve"]>>,
) {
  return {
    data,
    ...(resolved.refreshedToken ? { refreshedToken: resolved.refreshedToken } : {}),
    ...(resolved.expiresAt ? { expiresAt: resolved.expiresAt } : {}),
  };
}

function notFound() {
  return new CloudProjectServiceError("CLOUD_PROJECT_NOT_FOUND", "Cloud project not found", 404);
}

function projectLimit() {
  return new CloudProjectServiceError(
    "CLOUD_PROJECT_LIMIT_REACHED",
    "The account cloud project limit has been reached",
    403,
  );
}

function storageLimit() {
  return new CloudProjectServiceError(
    "CLOUD_PROJECT_STORAGE_LIMIT_REACHED",
    "The account project storage limit has been reached",
    403,
  );
}

function invalidProjectMedia() {
  return new CloudProjectServiceError(
    "CLOUD_PROJECT_MEDIA_INVALID",
    "The project contains unavailable or invalid server media",
    422,
  );
}

function isProTier(tier: string) {
  return ["pro", "professional", "premium", "plus"].includes(tier.trim().toLowerCase());
}
