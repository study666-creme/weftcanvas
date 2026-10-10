import { z } from "zod";

import {
  canvasEdgeRecordSchema,
  canvasGroupSchema,
  canvasNodeDataSchema,
  canvasNodeKindSchema,
  canvasViewportSchema,
} from "./canvas.js";

export const CANVAS_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const CLOUD_PROJECT_API_VERSION = 1 as const;

const cloudProjectIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export const cloudProjectPrincipalIdSchema = z.string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);
export type CloudProjectPrincipalId = z.infer<typeof cloudProjectPrincipalIdSchema>;
const cloudNodeIdSchema = z.string().trim().min(1).max(128);
const cloudCoordinateSchema = z.number().finite().min(-1_000_000).max(1_000_000);
const cloudDimensionSchema = z.number().finite().positive().max(100_000);

const canvasDocumentNodeDataSchema = canvasNodeDataSchema.omit({
  kind: true,
  status: true,
  progress: true,
});

export const canvasDocumentNodeSchema = z.object({
  id: cloudNodeIdSchema,
  kind: canvasNodeKindSchema,
  position: z.object({
    x: cloudCoordinateSchema,
    y: cloudCoordinateSchema,
  }).strict(),
  size: z.object({
    width: cloudDimensionSchema,
    height: cloudDimensionSchema,
  }).strict().nullable().default(null),
  data: canvasDocumentNodeDataSchema,
}).strict();
export type CanvasDocumentNode = z.infer<typeof canvasDocumentNodeSchema>;

export const canvasDocumentEdgeSchema = canvasEdgeRecordSchema.omit({
  selected: true,
}).omit({
  sourceHandle: true,
  targetHandle: true,
}).extend({
  id: cloudNodeIdSchema,
  source: cloudNodeIdSchema,
  target: cloudNodeIdSchema,
  sourcePort: z.string().min(1).max(128).nullable().default(null),
  targetPort: z.string().min(1).max(128).nullable().default(null),
}).strict();
export type CanvasDocumentEdge = z.infer<typeof canvasDocumentEdgeSchema>;

export const canvasDocumentSchema = z.object({
  schemaVersion: z.literal(CANVAS_DOCUMENT_SCHEMA_VERSION),
  projectId: cloudProjectIdSchema,
  title: z.string().trim().min(1).max(64),
  nodes: z.array(canvasDocumentNodeSchema).max(2_000),
  edges: z.array(canvasDocumentEdgeSchema).max(4_000),
  groups: z.array(canvasGroupSchema).max(500).default([]),
  viewport: canvasViewportSchema,
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict().superRefine((document, context) => {
  const nodeIds = new Set<string>();
  document.nodes.forEach((node, index) => {
    if (nodeIds.has(node.id)) {
      context.addIssue({ code: "custom", message: "Node ids must be unique", path: ["nodes", index, "id"] });
    }
    nodeIds.add(node.id);
  });

  const edgeIds = new Set<string>();
  document.edges.forEach((edge, index) => {
    if (edgeIds.has(edge.id)) {
      context.addIssue({ code: "custom", message: "Edge ids must be unique", path: ["edges", index, "id"] });
    }
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
      context.addIssue({ code: "custom", message: "Edges must reference document nodes", path: ["edges", index] });
    }
  });

  const groupIds = new Set<string>();
  document.groups.forEach((group, index) => {
    if (groupIds.has(group.id)) {
      context.addIssue({ code: "custom", message: "Group ids must be unique", path: ["groups", index, "id"] });
    }
    groupIds.add(group.id);
    if (new Set(group.nodeIds).size !== group.nodeIds.length || group.nodeIds.some((id) => !nodeIds.has(id))) {
      context.addIssue({ code: "custom", message: "Groups must reference unique document nodes", path: ["groups", index, "nodeIds"] });
    }
  });
});
export type CanvasDocument = z.infer<typeof canvasDocumentSchema>;

export const cloudProjectEntitlementsSchema = z.object({
  tier: z.string().trim().min(1).max(32),
  cloudProjectLimit: z.number().int().nonnegative(),
  projectStorageBytes: z.number().int().nonnegative(),
  mediaStorageBytes: z.number().int().nonnegative(),
  revisionRetentionCount: z.number().int().min(1).max(1_000),
  multiDeviceSync: z.boolean(),
}).strict();
export type CloudProjectEntitlements = z.infer<typeof cloudProjectEntitlementsSchema>;

/**
 * 会员降级后的存储宽限：用量超过新配额时服务端记录 7 天调整期。到期前
 * 不清理（用户可整理/续费），到期后按最旧未绑定素材优先的顺序清回配额内。
 */
export const cloudStorageGraceSchema = z.object({
  fromTier: z.string().trim().min(1).max(32),
  quotaBytes: z.number().int().positive(),
  usageBytes: z.number().int().nonnegative(),
  deadline: z.string().datetime(),
}).strict();
export type CloudStorageGrace = z.infer<typeof cloudStorageGraceSchema>;

export const cloudProjectUsageSchema = z.object({
  projectCount: z.number().int().nonnegative(),
  projectStorageBytes: z.number().int().nonnegative(),
  mediaStorageBytes: z.number().int().nonnegative(),
  entitlements: cloudProjectEntitlementsSchema,
  storageGrace: cloudStorageGraceSchema.nullable().optional(),
}).strict();
export type CloudProjectUsage = z.infer<typeof cloudProjectUsageSchema>;

export const cloudProjectSummarySchema = z.object({
  schemaVersion: z.literal(CLOUD_PROJECT_API_VERSION),
  id: cloudProjectIdSchema,
  title: z.string().trim().min(1).max(64),
  revision: z.number().int().positive(),
  documentBytes: z.number().int().nonnegative(),
  localMediaCount: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
}).strict();
export type CloudProjectSummary = z.infer<typeof cloudProjectSummarySchema>;

export const cloudProjectSharedSummarySchema = cloudProjectSummarySchema.extend({
  ownerId: cloudProjectPrincipalIdSchema,
  role: z.literal("member"),
}).strict();
export type CloudProjectSharedSummary = z.infer<typeof cloudProjectSharedSummarySchema>;

export const cloudProjectSchema = cloudProjectSummarySchema.extend({
  document: canvasDocumentSchema,
}).strict();
export type CloudProject = z.infer<typeof cloudProjectSchema>;

export const cloudProjectCreateRequestSchema = z.object({
  document: canvasDocumentSchema,
}).strict();
export type CloudProjectCreateRequest = z.infer<typeof cloudProjectCreateRequestSchema>;

export const cloudProjectSaveRequestSchema = z.object({
  baseRevision: z.number().int().positive(),
  document: canvasDocumentSchema,
  checkpoint: z.boolean().default(false),
}).strict();
export type CloudProjectSaveRequest = z.infer<typeof cloudProjectSaveRequestSchema>;

export const cloudProjectDeleteRequestSchema = z.object({
  baseRevision: z.number().int().positive(),
}).strict();
export type CloudProjectDeleteRequest = z.infer<typeof cloudProjectDeleteRequestSchema>;

export const cloudProjectMemberRoleSchema = z.enum(["owner", "member"]);
export type CloudProjectMemberRole = z.infer<typeof cloudProjectMemberRoleSchema>;

export const cloudProjectMemberSchema = z.object({
  projectId: cloudProjectIdSchema,
  principalId: cloudProjectPrincipalIdSchema,
  role: cloudProjectMemberRoleSchema,
  createdAt: z.string().datetime({ offset: true }),
}).strict();
export type CloudProjectMember = z.infer<typeof cloudProjectMemberSchema>;

export const cloudProjectInviteRequestSchema = z.object({
  inviteeId: cloudProjectPrincipalIdSchema,
}).strict();
export type CloudProjectInviteRequest = z.infer<typeof cloudProjectInviteRequestSchema>;

export const cloudProjectInvitationStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export type CloudProjectInvitationStatus = z.infer<typeof cloudProjectInvitationStatusSchema>;

export const cloudProjectInvitationSchema = z.object({
  id: z.string().uuid(),
  projectId: cloudProjectIdSchema,
  inviterId: cloudProjectPrincipalIdSchema,
  inviteeId: cloudProjectPrincipalIdSchema,
  role: z.literal("member"),
  status: cloudProjectInvitationStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  acceptedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
export type CloudProjectInvitation = z.infer<typeof cloudProjectInvitationSchema>;

export const cloudProjectMemberListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    members: z.array(cloudProjectMemberSchema).max(100),
    invitations: z.array(cloudProjectInvitationSchema).max(100),
    seatUsage: z.object({
      limit: z.number().int().min(1),
      used: z.number().int().nonnegative(),
    }).strict().nullable().optional(),
  }).strict(),
}).strict();

export const cloudProjectMemberResponseSchema = z.object({
  ok: z.literal(true),
  data: cloudProjectMemberSchema,
}).strict();

export const cloudProjectInvitationResponseSchema = z.object({
  ok: z.literal(true),
  data: cloudProjectInvitationSchema,
}).strict();

export const cloudProjectInvitationListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ invitations: z.array(cloudProjectInvitationSchema).max(100) }).strict(),
}).strict();

export const cloudProjectListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    projects: z.array(cloudProjectSummarySchema),
    sharedProjects: z.array(cloudProjectSharedSummarySchema).default([]),
    usage: cloudProjectUsageSchema,
  }).strict(),
}).strict();

export const cloudProjectResponseSchema = z.object({
  ok: z.literal(true),
  data: cloudProjectSchema,
}).strict();

export const cloudProjectDeleteResponseSchema = z.object({
  ok: z.literal(true),
}).strict();
