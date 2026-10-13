import { z } from "zod";

import { canvasNodeKindSchema } from "./canvas.js";

export const AGENT_SCHEMA_VERSION = 1 as const;
/** 单条消息正文上限：只防极端内存问题，不限制模型能输出多长的剧本。 */
export const MAX_AGENT_MESSAGE_CHARS = 200_000;
export const AGENT_CANVAS_CONTEXT_SCHEMA_VERSION = 1 as const;
export const AGENT_PROPOSAL_SCHEMA_VERSION = 1 as const;
export const AGENT_EXECUTION_RECEIPT_SCHEMA_VERSION = 1 as const;

export const agentRunStatuses = ["queued", "running", "completed", "failed", "cancelled"] as const;
export const agentRunStatusSchema = z.enum(agentRunStatuses);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentMessageRoleSchema = z.enum(["user", "assistant"]);
export type AgentMessageRole = z.infer<typeof agentMessageRoleSchema>;

export const agentModelIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[^\s,\u0000-\u001F\u007F]+$/);
export type AgentModelId = z.infer<typeof agentModelIdSchema>;

export const agentThinkingSchema = z
  .object({
    levels: z.array(z.string().trim().min(1).max(24)).min(1).max(8),
    default: z.string().trim().min(1).max(24),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.levels.includes(value.default)) {
      context.addIssue({
        code: "custom",
        message: "Default thinking level must be included in levels",
        path: ["default"],
      });
    }
    if (new Set(value.levels).size !== value.levels.length) {
      context.addIssue({
        code: "custom",
        message: "Thinking levels must be unique",
        path: ["levels"],
      });
    }
  });
export type AgentThinking = z.infer<typeof agentThinkingSchema>;

export const agentModelBillingSchema = z.enum(["request", "token"]);
export type AgentModelBilling = z.infer<typeof agentModelBillingSchema>;

export const agentModelSchema = z
  .object({
    id: agentModelIdSchema,
    label: z.string().trim().min(1).max(128),
    // 展示元数据：Agent 模型选择器按这些字段分组和标注，和图片/视频选择器保持同一套信息密度。
    group: z.string().trim().min(1).max(64).optional(),
    detail: z.string().trim().min(1).max(240).optional(),
    meta: z.string().trim().min(1).max(64).optional(),
    /** 计费方式：按次（request）或按量（token）。缺省按次。 */
    billing: agentModelBillingSchema.optional(),
    /** 目录声明的思考强度档位；没有该字段表示模型不支持调节。 */
    thinking: agentThinkingSchema.optional(),
  })
  .strict();
export type AgentModel = z.infer<typeof agentModelSchema>;

export const agentModelCatalogSchema = z
  .object({
    defaultModelId: agentModelIdSchema,
    models: z.array(agentModelSchema).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = value.models.map((model) => model.id);
    if (!ids.includes(value.defaultModelId)) {
      context.addIssue({
        code: "custom",
        message: "Default model must be included in models",
        path: ["defaultModelId"],
      });
    }
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "Model ids must be unique", path: ["models"] });
    }
  });
export type AgentModelCatalog = z.infer<typeof agentModelCatalogSchema>;

export const agentCreativeModes = ["freeform", "professional", "baseline"] as const;
export const agentCreativeModeSchema = z.enum(agentCreativeModes);
export type AgentCreativeMode = z.infer<typeof agentCreativeModeSchema>;

const defaultCreativeGuidance = {
  mode: "freeform" as const,
  baseline: {
    aspectRatio: null,
    visualStyle: null,
    targetDuration: null,
    locked: false,
  },
};

export const DEFAULT_AGENT_CREATIVE_GUIDANCE = defaultCreativeGuidance;

export const agentCreativeBaselineSchema = z
  .object({
    aspectRatio: z.string().trim().min(1).max(48).nullable().default(null),
    visualStyle: z.string().trim().min(1).max(240).nullable().default(null),
    targetDuration: z.string().trim().min(1).max(96).nullable().default(null),
    locked: z.boolean().default(false),
  })
  .strict();
export type AgentCreativeBaseline = z.infer<typeof agentCreativeBaselineSchema>;

export const agentCreativeGuidanceSchema = z
  .object({
    mode: agentCreativeModeSchema.default(defaultCreativeGuidance.mode),
    baseline: agentCreativeBaselineSchema.default(defaultCreativeGuidance.baseline),
  })
  .strict();
export type AgentCreativeGuidance = z.infer<typeof agentCreativeGuidanceSchema>;

const agentNodeReferenceSchema = z.string().trim().min(1).max(128);
const agentClientNodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/);
const agentCoordinateSchema = z.number().min(-100_000).max(100_000);
const agentPositionSchema = z
  .object({
    x: agentCoordinateSchema,
    y: agentCoordinateSchema,
  })
  .strict();
const agentDirectorEntityPatchSchema = z
  .object({
    x: z.number().min(-20).max(20).optional(),
    y: z.number().min(-2).max(10).optional(),
    z: z.number().min(-20).max(20).optional(),
    rotationY: z.number().min(-360).max(360).optional(),
    scale: z.number().min(0.2).max(5).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, "导演台对象至少需要一项变更");

/**
 * Agent 可以开合/切换的画布外壳面板（不含内容读写）。这些是**无破坏性**的
 * UI 导航动作：只是把某个已存在的面板打开、切到某个板块、或切换主题/配色，
 * 不新增/删除节点、不触发生成、不上传媒体，因此允许 direct 执行。
 */
export const agentUiPanels = [
  "settings",
  "resource-drawer",
  "asset-library",
  "project-library",
  "activity",
  "shortcuts",
] as const;
export const agentUiPanelSchema = z.enum(agentUiPanels);
export type AgentUiPanel = z.infer<typeof agentUiPanelSchema>;

/** 设置中心的一级板块，与 appearance-toolbar 的 SettingsSection 对齐。 */
export const agentSettingsSections = [
  "ui",
  "apis",
  "models",
  "local",
  "collaboration",
  "plugins",
] as const;
export const agentSettingsSectionSchema = z.enum(agentSettingsSections);
export type AgentSettingsSection = z.infer<typeof agentSettingsSectionSchema>;

/** 资源抽屉的两个页签：卡片库 / 资产库。 */
export const agentResourceTabs = ["cards", "assets"] as const;
export const agentResourceTabSchema = z.enum(agentResourceTabs);
export type AgentResourceTab = z.infer<typeof agentResourceTabSchema>;

export const agentThemes = ["light", "dark", "auto", "toggle"] as const;
export const agentThemeSchema = z.enum(agentThemes);
export type AgentTheme = z.infer<typeof agentThemeSchema>;

export const agentColorSchemes = ["graphite", "ink", "onyx"] as const;
export const agentColorSchemeSchema = z.enum(agentColorSchemes);
export type AgentColorScheme = z.infer<typeof agentColorSchemeSchema>;

export const agentActionSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("canvas_add_node"),
      clientId: agentClientNodeIdSchema,
      kind: canvasNodeKindSchema,
      body: z.string().max(16_000).default(""),
      position: agentPositionSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_update_node"),
      nodeId: agentNodeReferenceSchema,
      body: z.string().max(16_000).optional(),
      position: agentPositionSchema.optional(),
    })
    .strict()
    .refine(
      (value) => value.body !== undefined || value.position !== undefined,
      "节点至少需要一项变更",
    ),
  z
    .object({
      type: z.literal("canvas_connect_nodes"),
      sourceNodeId: agentNodeReferenceSchema,
      targetNodeId: agentNodeReferenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_select_nodes"),
      nodeIds: z.array(agentNodeReferenceSchema).max(120),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_group_nodes"),
      nodeIds: z.array(agentNodeReferenceSchema).min(2).max(120),
      name: z.string().trim().min(1).max(32).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_set_viewport"),
      viewport: z
        .object({
          x: agentCoordinateSchema,
          y: agentCoordinateSchema,
          zoom: z.number().min(0.05).max(8),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_director_open"),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_director_load_packet"),
      packet: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_director_select_shot"),
      shotId: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      type: z.literal("canvas_director_update_entity"),
      shotId: z.string().trim().min(1).max(128),
      entityId: z.string().trim().min(1).max(128),
      entityKind: z.enum(["actor", "prop"]),
      patch: agentDirectorEntityPatchSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ui_open_panel"),
      panel: agentUiPanelSchema,
      section: agentSettingsSectionSchema.optional(),
      tab: agentResourceTabSchema.optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("ui_close_panel"),
      panel: agentUiPanelSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ui_set_theme"),
      theme: agentThemeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("ui_set_color_scheme"),
      scheme: agentColorSchemeSchema,
    })
    .strict(),
]);
export type AgentAction = z.infer<typeof agentActionSchema>;

export const agentExecutionModes = ["none", "direct", "proposal"] as const;
export const agentExecutionModeSchema = z.enum(agentExecutionModes);
export type AgentExecutionMode = z.infer<typeof agentExecutionModeSchema>;

export const agentProposalStatuses = ["pending", "confirmed", "dismissed"] as const;
export const agentProposalStatusSchema = z.enum(agentProposalStatuses);
export type AgentProposalStatus = z.infer<typeof agentProposalStatusSchema>;

export const agentContextRevisionSchema = z.string().trim().min(1).max(128).default("legacy");
export type AgentContextRevision = z.infer<typeof agentContextRevisionSchema>;

export const agentProposalSchema = z
  .object({
    schemaVersion: z.literal(AGENT_PROPOSAL_SCHEMA_VERSION),
    id: z.string().uuid(),
    title: z.string().trim().min(1).max(120),
    reason: z.string().trim().min(1).max(1_000),
    successCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(8),
  })
  .strict();
export type AgentProposal = z.infer<typeof agentProposalSchema>;

export const agentProposalDraftSchema = agentProposalSchema.omit({
  schemaVersion: true,
  id: true,
});
export type AgentProposalDraft = z.infer<typeof agentProposalDraftSchema>;

export const agentExecutionReceiptStatuses = ["applied", "partial", "rejected"] as const;
export const agentExecutionReceiptStatusSchema = z.enum(agentExecutionReceiptStatuses);
export type AgentExecutionReceiptStatus = z.infer<typeof agentExecutionReceiptStatusSchema>;

export const agentSkippedActionSchema = z
  .object({
    index: z.number().int().nonnegative().max(31),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
export type AgentSkippedAction = z.infer<typeof agentSkippedActionSchema>;

export const agentExecutionReceiptSchema = z
  .object({
    schemaVersion: z.literal(AGENT_EXECUTION_RECEIPT_SCHEMA_VERSION),
    contextRevisionBefore: agentContextRevisionSchema,
    contextRevisionAfter: agentContextRevisionSchema,
    appliedActions: z.number().int().nonnegative().max(32),
    skippedActions: z.array(agentSkippedActionSchema).max(32),
    status: agentExecutionReceiptStatusSchema,
    reason: z.string().trim().min(1).max(500).nullable().default(null),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AgentExecutionReceipt = z.infer<typeof agentExecutionReceiptSchema>;

export const agentExecutionReceiptCreateRequestSchema = agentExecutionReceiptSchema.omit({
  schemaVersion: true,
  createdAt: true,
});
export type AgentExecutionReceiptCreateRequest = z.infer<
  typeof agentExecutionReceiptCreateRequestSchema
>;

export const agentProposalConfirmRequestSchema = z
  .object({
    contextRevision: agentContextRevisionSchema,
  })
  .strict();
export type AgentProposalConfirmRequest = z.infer<typeof agentProposalConfirmRequestSchema>;

export const agentRunErrorSchema = z.object({
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(500),
  retryable: z.boolean(),
});
export type AgentRunError = z.infer<typeof agentRunErrorSchema>;

export const agentConversationSchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  id: z.string().uuid(),
  projectId: z.string().min(1).max(128),
  title: z.string().min(1).max(60),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type AgentConversation = z.infer<typeof agentConversationSchema>;

export const agentMessageSchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  role: agentMessageRoleSchema,
  content: z.string().min(1).max(MAX_AGENT_MESSAGE_CHARS),
  createdAt: z.string().datetime({ offset: true }),
});
export type AgentMessage = z.infer<typeof agentMessageSchema>;

export const agentRunSchema = z.object({
  schemaVersion: z.literal(AGENT_SCHEMA_VERSION),
  id: z.string().uuid(),
  conversationId: z.string().uuid(),
  userMessageId: z.string().uuid(),
  assistantMessageId: z.string().uuid().nullable(),
  modelId: agentModelIdSchema.nullable().default(null),
  status: agentRunStatusSchema,
  actions: z.array(agentActionSchema).max(32).default([]),
  executionMode: agentExecutionModeSchema.default("none"),
  proposal: agentProposalSchema.nullable().default(null),
  proposalStatus: agentProposalStatusSchema.nullable().default(null),
  contextRevision: agentContextRevisionSchema,
  receipt: agentExecutionReceiptSchema.nullable().default(null),
  error: agentRunErrorSchema.nullable(),
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

export const agentCanvasMediaSummarySchema = z.object({
  kind: z.enum(["image", "video", "audio"]),
  mimeType: z.string().min(1).max(128),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  durationMs: z.number().int().positive().nullable(),
});
export type AgentCanvasMediaSummary = z.infer<typeof agentCanvasMediaSummarySchema>;

export const agentCanvasNodeSummarySchema = z.object({
  id: z.string().min(1).max(128),
  kind: canvasNodeKindSchema,
  text: z.string().max(4_000),
  selected: z.boolean(),
  media: agentCanvasMediaSummarySchema.nullable(),
});
export type AgentCanvasNodeSummary = z.infer<typeof agentCanvasNodeSummarySchema>;

export const agentCanvasEdgeSummarySchema = z.object({
  source: z.string().min(1).max(128),
  target: z.string().min(1).max(128),
});

export const agentCanvasGroupSummarySchema = z.object({
  name: z.string().min(1).max(32),
  nodeIds: z.array(z.string().min(1).max(128)).min(2).max(120),
});

export const agentDirectorEntitySummarySchema = z.object({
  id: z.string().min(1).max(128),
  kind: z.enum(["actor", "prop"]),
  label: z.string().min(1).max(128),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  rotationY: z.number(),
  scale: z.number().positive(),
});

export const agentDirectorShotSummarySchema = z.object({
  shotId: z.string().min(1).max(128),
  title: z.string().max(500),
  entities: z.array(agentDirectorEntitySummarySchema).max(32),
});

export const agentDirectorStageSummarySchema = z
  .object({
    open: z.boolean(),
    shots: z.array(agentDirectorShotSummarySchema).max(24),
  })
  .nullable()
  .default(null);
export type AgentDirectorStageSummary = z.infer<typeof agentDirectorStageSummarySchema>;

export const agentCanvasContextSchema = z
  .object({
    schemaVersion: z.literal(AGENT_CANVAS_CONTEXT_SCHEMA_VERSION),
    contextRevision: agentContextRevisionSchema,
    projectId: z.string().min(1).max(128),
    projectName: z.string().min(1).max(128),
    nodeCount: z.number().int().nonnegative(),
    edgeCount: z.number().int().nonnegative(),
    groupCount: z.number().int().nonnegative(),
    omittedNodeCount: z.number().int().nonnegative(),
    omittedEdgeCount: z.number().int().nonnegative(),
    nodes: z.array(agentCanvasNodeSummarySchema).max(120),
    edges: z.array(agentCanvasEdgeSummarySchema).max(240),
    groups: z.array(agentCanvasGroupSummarySchema).max(60),
    directorStage: agentDirectorStageSummarySchema,
    // Optional for older persisted run contexts. New browser requests always send it.
    creativeGuidance: agentCreativeGuidanceSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.nodeCount !== value.nodes.length + value.omittedNodeCount) {
      context.addIssue({ code: "custom", message: "节点摘要计数无效", path: ["nodeCount"] });
    }
    if (value.edgeCount !== value.edges.length + value.omittedEdgeCount) {
      context.addIssue({ code: "custom", message: "连线摘要计数无效", path: ["edgeCount"] });
    }
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    value.edges.forEach((edge, index) => {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({
          code: "custom",
          message: "连线引用了未包含的节点",
          path: ["edges", index],
        });
      }
    });
    value.groups.forEach((group, groupIndex) => {
      if (
        group.nodeIds.some((id) => !nodeIds.has(id)) ||
        new Set(group.nodeIds).size !== group.nodeIds.length
      ) {
        context.addIssue({
          code: "custom",
          message: "组合节点摘要无效",
          path: ["groups", groupIndex, "nodeIds"],
        });
      }
    });
  });
export type AgentCanvasContext = z.infer<typeof agentCanvasContextSchema>;

export const agentConversationDetailSchema = z.object({
  conversation: agentConversationSchema,
  messages: z.array(agentMessageSchema).max(500),
  latestRun: agentRunSchema.nullable(),
});
export type AgentConversationDetail = z.infer<typeof agentConversationDetailSchema>;

export const agentConversationCreateRequestSchema = z
  .object({
    projectId: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type AgentConversationCreateRequest = z.infer<typeof agentConversationCreateRequestSchema>;

export const agentMessageCreateRequestSchema = z
  .object({
    content: z.string().trim().min(1).max(MAX_AGENT_MESSAGE_CHARS),
    idempotencyKey: z
      .string()
      .min(8)
      .max(128)
      .regex(/^[A-Za-z0-9._:-]+$/),
    modelId: agentModelIdSchema.optional(),
    /** 思考强度档位，取值必须来自所选模型的 thinking.levels。 */
    reasoningEffort: z.string().trim().min(1).max(24).optional(),
    canvasContext: agentCanvasContextSchema,
  })
  .strict();
export type AgentMessageCreateRequest = z.infer<typeof agentMessageCreateRequestSchema>;

export const agentConversationResponseSchema = z.object({
  ok: z.literal(true),
  data: agentConversationSchema,
});

export const agentConversationListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(agentConversationSchema),
});

export const agentConversationDetailResponseSchema = z.object({
  ok: z.literal(true),
  data: agentConversationDetailSchema,
});

export const agentModelCatalogResponseSchema = z
  .object({
    ok: z.literal(true),
    data: agentModelCatalogSchema,
  })
  .strict();
