import { randomUUID } from "node:crypto";

import {
  agentCanvasContextSchema,
  agentConversationCreateRequestSchema,
  agentConversationDetailSchema,
  agentConversationSchema,
  agentExecutionReceiptCreateRequestSchema,
  agentExecutionReceiptSchema,
  agentMessageCreateRequestSchema,
  agentMessageSchema,
  agentModelCatalogSchema,
  agentModelIdSchema,
  MAX_AGENT_MESSAGE_CHARS,
  agentProposalConfirmRequestSchema,
  agentProposalSchema,
  agentRunSchema,
  agentThinkingSchema,
  agentSkillLimits,
  type AgentAction,
  type AgentExecutionMode,
  type AgentExecutionPermission,
  type AgentModelCatalog,
  type AgentProposalDraft,
  type AgentRunError,
  type AgentSkillRunContext,
} from "@weftcanvas/contracts";
import { z } from "zod";

import type { AgentConnectorId } from "@weftcanvas/contracts";
import type { AgentExecutor, AgentSkillReader, AgentStore } from "./types.js";

const MAX_AGENT_MODELS = 64;
const projectIdSchema = z.string().trim().min(1).max(128);
const conversationIdSchema = z.string().uuid();
const runIdSchema = z.string().uuid();

/** 每次 Agent 对话轮次的固定价格（积分，非微积分）。 */
export const AGENT_TURN_CREDITS = 2;
/** 扣费/退款在 Prompt Hub 积分流水里的 reason。 */
export const AGENT_TURN_REASON = "agent_run";
export const AGENT_TURN_REFUND_REASON = "agent_run_refund";

export type AgentBillingCharge = {
  token: string | undefined;
  amount: number;
  reason: string;
  refId: string;
};

export type AgentBillingResult = {
  balance: number;
  replayed: boolean;
};

/**
 * Agent 计费依赖：由 server 侧用真实钱包 provider 适配。
 * consume/refund 都以 refId 幂等（钱包侧保证同一 refId 不重复扣/退）。
 * 保持可选，未注入时 Agent 不扣费（测试与本地无钱包场景）。
 */
export type AgentBilling = {
  consume(input: AgentBillingCharge): Promise<AgentBillingResult>;
  refund(input: AgentBillingCharge): Promise<AgentBillingResult>;
};

function isInsufficientCreditsError(cause: unknown): boolean {
  if (!cause || typeof cause !== "object") return false;
  const code = "code" in cause ? String((cause as { code?: unknown }).code ?? "") : "";
  const status = "status" in cause ? Number((cause as { status?: unknown }).status) : Number.NaN;
  return code.toUpperCase() === "INSUFFICIENT_CREDITS" || status === 402;
}

export class AgentServiceError extends Error {
  constructor(
    readonly code:
      | "CONVERSATION_NOT_FOUND"
      | "RUN_NOT_FOUND"
      | "PROJECT_CONTEXT_MISMATCH"
      | "PROJECT_CONTEXT_STALE"
      | "PROPOSAL_NOT_AVAILABLE"
      | "RUN_STATE_CONFLICT"
      | "EXECUTION_RECEIPT_INVALID"
      | "MODEL_NOT_AVAILABLE"
      | "MODEL_CATALOG_UNAVAILABLE"
      | "INSUFFICIENT_CREDITS"
      | "AGENT_UNAVAILABLE",
    message: string,
  ) {
    super(message);
    this.name = "AgentServiceError";
  }
}

type AgentServiceOptions = {
  now?: () => number;
  createId?: () => string;
  executor?: AgentExecutor;
  /**
   * 平台公共模型目录里的文本模型。Agent 运行时只声明一个默认模型（以及可选的
   * 白名单），但产品侧希望 Agent 模型选择器和图片/视频选择器一样列出全部可用模型，
   * 因此这里把平台目录里的文本模型合并进 Agent 模型目录。
   */
  textModels?: () => Promise<
    ReadonlyArray<{
      id: string;
      label: string;
      description?: string;
      group?: string;
      meta?: string;
      billing?: "request" | "token";
      thinking?: { levels: string[]; default: string };
    }>
  >;
  /**
   * 用户自己机器上的外部连接是否在线。托管站点上运行时在服务器上，
   * 只有把"该用户有在线 Blender"告诉运行时，它才会走配对通道，而不是去连本机的 Blender。
   */
  connectorClients?: {
    listStatus(
      ownerId: string,
      connectorIds: readonly AgentConnectorId[],
    ): ReadonlyArray<{ connectorId: AgentConnectorId; connected: boolean }>;
  };
  /** Agent 每轮固定计费依赖；缺省时不扣费（测试/本地）。 */
  billing?: AgentBilling;
  /** 技能库只读面；未配置时本轮启用的技能会被忽略（不伪造内容）。 */
  skills?: AgentSkillReader;
};

export class AgentService {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly executor?: AgentExecutor;
  private readonly textModels?: AgentServiceOptions["textModels"];
  private readonly connectorClients?: AgentServiceOptions["connectorClients"];
  private readonly billing?: AgentBilling;
  private readonly skills?: AgentSkillReader;
  private readonly activeRuns = new Map<string, AbortController>();

  constructor(
    private readonly store: AgentStore,
    options: AgentServiceOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.executor = options.executor;
    this.textModels = options.textModels;
    this.connectorClients = options.connectorClients;
    this.billing = options.billing;
    this.skills = options.skills;
  }

  /**
   * 读出本轮启用的技能正文。技能是用户自己导入的工作流说明，正文直接进上下文，
   * 所以这里收两道上限：条数（契约的 enabledPerRun）与合计字符数；读不到的
   * 技能（已删除/存储不可用）直接跳过，绝不编造内容顶上。
   */
  private async loadSkillContext(
    ownerId: string,
    skillIds: readonly string[],
  ): Promise<AgentSkillRunContext[]> {
    if (!this.skills || !skillIds.length) return [];
    const unique = [...new Set(skillIds)].slice(0, agentSkillLimits.enabledPerRun);
    const loaded = await Promise.all(
      unique.map((id) => this.skills!.read(ownerId, id).catch(() => null)),
    );
    const contexts: AgentSkillRunContext[] = [];
    let budget = agentSkillLimits.promptCharsPerRun;
    for (const skill of loaded) {
      if (!skill || budget <= 0) continue;
      const body = skill.body.slice(0, Math.min(budget, 8_000));
      if (!body.trim()) continue;
      budget -= body.length;
      contexts.push({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        body,
      });
    }
    return contexts;
  }

  private remoteBlenderOnline(ownerId: string) {
    try {
      return this.connectorClients?.listStatus(ownerId, ["blender"])[0]?.connected === true;
    } catch {
      // 连接状态读不到时按"不在线"处理：运行时于是退回本机通道，不会假称能远程执行。
      return false;
    }
  }

  async createConversation(ownerId: string, value: unknown) {
    const input = agentConversationCreateRequestSchema.parse(value);
    const timestamp = this.timestamp();
    const conversation = agentConversationSchema.parse({
      schemaVersion: 1,
      id: this.createId(),
      projectId: input.projectId,
      title: input.title ?? "新对话",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.store.createConversation({ ...conversation, ownerId });
    return conversation;
  }

  async listConversations(ownerId: string, projectIdValue: string, limit = 30) {
    const projectId = projectIdSchema.parse(projectIdValue);
    const boundedLimit = z.number().int().min(1).max(100).parse(limit);
    return this.store.listConversations(ownerId, projectId, boundedLimit);
  }

  async getDetail(ownerId: string, conversationIdValue: string) {
    const conversationId = conversationIdSchema.parse(conversationIdValue);
    const detail = await this.store.getDetail(ownerId, conversationId);
    if (!detail) throw new AgentServiceError("CONVERSATION_NOT_FOUND", "没有找到这个 Agent 对话");
    return agentConversationDetailSchema.parse(detail);
  }

  async getModels(_ownerId?: string) {
    if (!this.executor) {
      throw new AgentServiceError("AGENT_UNAVAILABLE", "Agent 服务暂未配置");
    }
    let runtimeCatalog: Awaited<ReturnType<AgentExecutor["getModels"]>>;
    try {
      runtimeCatalog = agentModelCatalogSchema.parse(await this.executor.getModels());
    } catch (cause) {
      if (cause instanceof AgentServiceError) throw cause;
      throw new AgentServiceError("MODEL_CATALOG_UNAVAILABLE", "Agent 模型列表暂时不可用");
    }
    return this.mergeTextModels(runtimeCatalog);
  }

  /**
   * 把平台文本模型合并到运行时目录：运行时目录的默认模型优先，其次是平台目录顺序。
   * 平台目录读取失败时退回运行时目录，避免模型选择器整体不可用。
   */
  private async mergeTextModels(runtimeCatalog: AgentModelCatalog): Promise<AgentModelCatalog> {
    if (!this.textModels) return runtimeCatalog;
    let platformModels: Awaited<ReturnType<NonNullable<AgentServiceOptions["textModels"]>>>;
    try {
      platformModels = await this.textModels();
    } catch {
      return runtimeCatalog;
    }
    const merged = new Map<string, AgentModelCatalog["models"][number]>();
    for (const model of runtimeCatalog.models) {
      merged.set(model.id, model);
    }
    for (const model of platformModels) {
      const parsed = agentModelIdSchema.safeParse(model.id);
      if (!parsed.success) continue;
      const group = model.group ? model.group.slice(0, 64) : undefined;
      const detail = model.description ? model.description.slice(0, 240) : undefined;
      const thinking = sanitizeThinking(model.thinking);
      const meta = model.meta ? model.meta.slice(0, 64) : undefined;
      const billing = model.billing;
      const existing = merged.get(parsed.data);
      if (existing) {
        // 运行时目录里的同名模型保留自己的标签，但补上平台目录的分组/描述/思考强度，避免
        // 默认模型在选择器里显得"没有来源"。
        merged.set(parsed.data, {
          ...existing,
          ...(group && !existing.group ? { group } : {}),
          ...(detail && !existing.detail ? { detail } : {}),
          ...(thinking ? { thinking } : {}),
          ...(billing ? { billing } : {}),
          ...(existing.meta ? {} : meta ? { meta } : { meta: "按 Token 计费" }),
        });
        continue;
      }
      merged.set(parsed.data, {
        id: parsed.data,
        label: model.label.slice(0, 128),
        ...(group ? { group } : {}),
        ...(detail ? { detail } : {}),
        ...(thinking ? { thinking } : {}),
        ...(billing ? { billing } : {}),
        meta: meta ?? "按 Token 计费",
      });
      if (merged.size >= MAX_AGENT_MODELS) break;
    }
    const defaultModelId = runtimeCatalog.defaultModelId;
    const models = [...merged.values()].sort((left, right) => {
      if (left.id === defaultModelId) return -1;
      if (right.id === defaultModelId) return 1;
      return 0;
    });
    return agentModelCatalogSchema.parse({ defaultModelId, models });
  }

  async submitMessage(
    ownerId: string,
    conversationIdValue: string,
    value: unknown,
    token?: string,
  ) {
    const conversationId = conversationIdSchema.parse(conversationIdValue);
    const input = agentMessageCreateRequestSchema.parse(value);
    const conversation = await this.store.getConversation(ownerId, conversationId);
    if (!conversation)
      throw new AgentServiceError("CONVERSATION_NOT_FOUND", "没有找到这个 Agent 对话");
    if (conversation.projectId !== input.canvasContext.projectId) {
      throw new AgentServiceError("PROJECT_CONTEXT_MISMATCH", "对话与当前画布不匹配");
    }
    const modelId = await this.resolveModelId(input.modelId);
    const reasoningEffort = await this.resolveReasoningEffort(modelId, input.reasoningEffort);
    // 执行权限档随运行冻结：这一轮发出后再改设置，不会改变已经排队的这一轮。
    const executionPermission = input.executionPermission ?? "request_approval";
    const skills = await this.loadSkillContext(ownerId, input.skillIds ?? []);

    // 先确定 runId，再以 agent-run:<runId> 作为幂等 refId 预扣本轮积分；
    // 扣费失败（余额不足）时不落任何消息/任务，直接抛出。
    const runId = this.createId();
    const refId = `agent-run:${runId}`;
    await this.chargeRun(ownerId, token, refId);

    const createdAt = this.timestamp();
    const userMessage = agentMessageSchema.parse({
      schemaVersion: 1,
      id: this.createId(),
      conversationId,
      role: "user",
      content: input.content,
      createdAt,
    });
    const run = {
      ...agentRunSchema.parse({
        schemaVersion: 1,
        id: runId,
        conversationId,
        userMessageId: userMessage.id,
        assistantMessageId: null,
        modelId,
        status: "queued",
        actions: [],
        executionMode: "none",
        executionPermission,
        skillIds: skills.map((skill) => skill.id),
        proposal: null,
        proposalStatus: null,
        contextRevision: input.canvasContext.contextRevision,
        receipt: null,
        error: null,
        createdAt,
        startedAt: null,
        completedAt: null,
      }),
      ownerId,
      idempotencyKey: input.idempotencyKey,
      canvasContext: input.canvasContext,
    };
    let result: Awaited<ReturnType<AgentStore["createRun"]>>;
    try {
      result = await this.store.createRun({
        conversation,
        userMessage,
        run,
        suggestedTitle:
          conversation.title === "新对话" ? messageTitle(input.content) : conversation.title,
      });
    } catch (error) {
      // 落库失败：把刚扣的这轮积分原样退回（refId 幂等，重试安全）。
      await this.refundRun(ownerId, token, refId);
      throw error;
    }
    if (!result.created) {
      // idempotencyKey 命中已有 run（客户端重试）：这次生成的 runId 没有对应任务，
      // 退回这次的新扣费，避免"重试即重复扣费"。
      await this.refundRun(ownerId, token, refId);
      return this.getDetail(ownerId, conversationId);
    }

    if (!this.executor) {
      await this.store.failRun(
        ownerId,
        run.id,
        {
          code: "AGENT_UNAVAILABLE",
          message: "Agent 服务暂未配置",
          retryable: true,
        },
        this.timestamp(),
      );
      await this.refundRun(ownerId, token, refId);
      return this.getDetail(ownerId, conversationId);
    }

    void this.execute(ownerId, run.id, conversationId, modelId!, reasoningEffort, token).catch(
      () => undefined,
    );
    return this.getDetail(ownerId, conversationId);
  }

  async cancelRun(ownerId: string, runIdValue: string, token?: string) {
    const runId = runIdSchema.parse(runIdValue);
    const cancelled = await this.store.cancelRun(ownerId, runId, this.timestamp());
    if (!cancelled) throw new AgentServiceError("RUN_NOT_FOUND", "这个 Agent 任务已经结束或不存在");
    // 未完成就被取消的任务退还本轮积分；refId 幂等，重复取消不会重复退款。
    await this.refundRun(ownerId, token, `agent-run:${runId}`);
    this.activeRuns.get(runId)?.abort();
  }

  async confirmProposal(
    ownerId: string,
    conversationIdValue: string,
    runIdValue: string,
    value: unknown,
  ) {
    const conversationId = conversationIdSchema.parse(conversationIdValue);
    const runId = runIdSchema.parse(runIdValue);
    const input = agentProposalConfirmRequestSchema.parse(value);
    const run = await this.requireRun(ownerId, conversationId, runId);
    if (!isPendingProposal(run)) {
      throw new AgentServiceError("PROPOSAL_NOT_AVAILABLE", "这项提案已处理或当前不可确认");
    }
    if (run.contextRevision !== input.contextRevision) {
      throw new AgentServiceError(
        "PROJECT_CONTEXT_STALE",
        "画布已发生变化，请让 Agent 基于最新内容重新提案",
      );
    }
    if (!(await this.store.confirmProposal(ownerId, runId))) {
      throw new AgentServiceError("RUN_STATE_CONFLICT", "提案状态刚刚发生变化，请刷新后重试");
    }
    return this.getDetail(ownerId, conversationId);
  }

  async dismissProposal(ownerId: string, conversationIdValue: string, runIdValue: string) {
    const conversationId = conversationIdSchema.parse(conversationIdValue);
    const runId = runIdSchema.parse(runIdValue);
    const run = await this.requireRun(ownerId, conversationId, runId);
    if (!isPendingProposal(run)) {
      throw new AgentServiceError("PROPOSAL_NOT_AVAILABLE", "这项提案已处理或当前不可取消");
    }
    if (!(await this.store.dismissProposal(ownerId, runId))) {
      throw new AgentServiceError("RUN_STATE_CONFLICT", "提案状态刚刚发生变化，请刷新后重试");
    }
    return this.getDetail(ownerId, conversationId);
  }

  async recordReceipt(
    ownerId: string,
    conversationIdValue: string,
    runIdValue: string,
    value: unknown,
  ) {
    const conversationId = conversationIdSchema.parse(conversationIdValue);
    const runId = runIdSchema.parse(runIdValue);
    const input = agentExecutionReceiptCreateRequestSchema.parse(value);
    const run = await this.requireRun(ownerId, conversationId, runId);
    if (run.receipt) return this.getDetail(ownerId, conversationId);
    if (!canReceiveReceipt(run)) {
      throw new AgentServiceError("PROPOSAL_NOT_AVAILABLE", "这项操作尚未确认，不能记录执行结果");
    }
    validateReceipt(run.actions.length, run.contextRevision, input);
    const receipt = agentExecutionReceiptSchema.parse({
      schemaVersion: 1,
      ...input,
      createdAt: this.timestamp(),
    });
    if (!(await this.store.recordReceipt(ownerId, runId, receipt))) {
      throw new AgentServiceError("RUN_STATE_CONFLICT", "执行结果已经更新，请刷新后查看");
    }
    return this.getDetail(ownerId, conversationId);
  }

  private async execute(
    ownerId: string,
    runId: string,
    conversationId: string,
    modelId: string,
    reasoningEffort?: string,
    token?: string,
  ) {
    const controller = new AbortController();
    this.activeRuns.set(runId, controller);
    try {
      if (!(await this.store.markRunning(ownerId, runId, this.timestamp()))) return;
      const detail = await this.store.getDetail(ownerId, conversationId);
      if (!detail) return;
      if (controller.signal.aborted) return;
      // 权限档与技能清单以运行记录为准（提交时已冻结），技能正文此刻从库里现读。
      const frozen = await this.store.getRun(ownerId, runId);
      const executionPermission = frozen?.executionPermission ?? "request_approval";
      const skills = await this.loadSkillContext(ownerId, frozen?.skillIds ?? []);
      const result = await this.executor!.execute(
        {
          modelId,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          executionPermission,
          skills,
          conversation: detail.conversation,
          messages: detail.messages,
          canvasContext: await this.runContext(ownerId, runId),
          ownerId,
          ...(this.connectorClients
            ? { remoteConnectors: { blender: this.remoteBlenderOnline(ownerId) } }
            : {}),
        },
        controller.signal,
      );
      const content = z.string().trim().min(1).max(MAX_AGENT_MESSAGE_CHARS).parse(result.content);
      const message = agentMessageSchema.parse({
        schemaVersion: 1,
        id: this.createId(),
        conversationId,
        role: "assistant",
        content,
        createdAt: this.timestamp(),
      });
      const execution = normalizeExecutionResult(result, this.createId, executionPermission);
      await this.store.completeRun(ownerId, runId, message, execution, this.timestamp());
    } catch (cause) {
      if (!controller.signal.aborted) {
        await this.store
          .failRun(ownerId, runId, publicExecutionError(cause), this.timestamp())
          .catch(() => undefined);
        // 任务真正失败才退款；被取消（aborted）时由 cancelRun 负责退款，避免重复。
        await this.refundRun(ownerId, token, `agent-run:${runId}`);
      }
    } finally {
      this.activeRuns.delete(runId);
    }
  }

  /** 预扣一轮积分；余额不足统一抛 AgentServiceError(INSUFFICIENT_CREDITS)。 */
  private async chargeRun(_ownerId: string, token: string | undefined, refId: string) {
    if (!this.billing) return;
    try {
      await this.billing.consume({
        token,
        amount: AGENT_TURN_CREDITS,
        reason: AGENT_TURN_REASON,
        refId,
      });
    } catch (cause) {
      if (isInsufficientCreditsError(cause)) {
        throw new AgentServiceError("INSUFFICIENT_CREDITS", "积分不足，请充值后重试");
      }
      throw cause;
    }
  }

  /** 退回一轮积分；退款失败只记日志，绝不覆盖原始的失败原因。 */
  private async refundRun(ownerId: string, token: string | undefined, refId: string) {
    if (!this.billing) return;
    try {
      await this.billing.refund({
        token,
        amount: AGENT_TURN_CREDITS,
        reason: AGENT_TURN_REFUND_REASON,
        refId,
      });
    } catch (cause) {
      console.error("[agent] credit refund failed", {
        ownerId,
        refId,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private async resolveModelId(requestedModelId: string | undefined) {
    if (!this.executor) {
      if (requestedModelId) throw new AgentServiceError("AGENT_UNAVAILABLE", "Agent 服务暂未配置");
      return null;
    }
    const catalog = await this.getModels();
    const modelId = requestedModelId ?? catalog.defaultModelId;
    if (!catalog.models.some((model) => model.id === modelId)) {
      throw new AgentServiceError("MODEL_NOT_AVAILABLE", "所选 Agent 模型当前不可用");
    }
    return modelId;
  }

  private async resolveReasoningEffort(modelId: string | null, requested: string | undefined) {
    if (!requested || !modelId) return undefined;
    const catalog = await this.getModels();
    const thinking = catalog.models.find((model) => model.id === modelId)?.thinking;
    if (!thinking) return undefined;
    return thinking.levels.includes(requested) ? requested : thinking.default;
  }

  private async runContext(ownerId: string, runId: string) {
    const context = await this.store.getRunContext(ownerId, runId);
    if (!context) throw new AgentServiceError("RUN_NOT_FOUND", "Agent 任务状态已经变化");
    return agentCanvasContextSchema.parse(context);
  }

  private async requireRun(ownerId: string, conversationId: string, runId: string) {
    const run = await this.store.getRun(ownerId, runId);
    if (!run || run.conversationId !== conversationId) {
      throw new AgentServiceError("RUN_NOT_FOUND", "没有找到这项 Agent 任务");
    }
    return run;
  }

  private timestamp() {
    return new Date(this.now()).toISOString();
  }
}

/**
 * 执行权限档决定动作怎么落地：
 * - 只读：动作一个都不留（模型仍可在 content 里解释它想做什么）；
 * - 自动执行：画布写入类动作也允许 direct，直接落地；
 * - 请求审批（默认）：只有无破坏性的低风险动作 direct，其余转成待确认提案。
 *
 * 生成类动作不在本仓库的动作集里（Agent 不触发生成），所以"自动执行"放开的只是
 * 画布结构写入；模型与积分始终由创作者自己决定。
 */
function normalizeExecutionResult(
  result: {
    actions: AgentAction[];
    executionMode?: AgentExecutionMode;
    proposal?: AgentProposalDraft | null;
  },
  createId: () => string,
  permission: AgentExecutionPermission = "request_approval",
) {
  const actions = result.actions;
  if (!actions.length) {
    return { actions, executionMode: "none" as const, proposal: null, proposalStatus: null };
  }
  if (permission === "read_only") {
    return { actions: [], executionMode: "none" as const, proposal: null, proposalStatus: null };
  }
  const allowedDirect = (action: AgentAction) =>
    permission === "auto" ? isAutoDirectAction(action) : isDirectAction(action);
  if (result.executionMode === "direct" && actions.every(allowedDirect)) {
    return { actions, executionMode: "direct" as const, proposal: null, proposalStatus: null };
  }
  const draft = result.proposal ?? {
    title: "应用建议的画布调整",
    reason: "这些操作会修改当前项目，执行前需要由你确认。",
    successCriteria: ["所列操作成功应用，无法应用的项目会显示原因"],
  };
  return {
    actions,
    executionMode: "proposal" as const,
    proposal: agentProposalSchema.parse({ schemaVersion: 1, id: createId(), ...draft }),
    proposalStatus: "pending" as const,
  };
}

/** 目录里的思考强度档位；去重并保证 default 合法，非法/空值一律丢弃。 */
function sanitizeThinking(value: { levels: string[]; default: string } | undefined) {
  if (!value || !Array.isArray(value.levels)) return undefined;
  const levels = [
    ...new Set(
      value.levels
        .filter((level): level is string => typeof level === "string")
        .map((level) => level.trim())
        .filter((level) => level.length > 0 && level.length <= 24),
    ),
  ].slice(0, 8);
  if (!levels.length) return undefined;
  const fallback = levels.includes("medium") ? "medium" : levels[0]!;
  const requested = typeof value.default === "string" ? value.default.trim() : "";
  const parsed = agentThinkingSchema.safeParse({
    levels,
    default: levels.includes(requested) ? requested : fallback,
  });
  return parsed.success ? parsed.data : undefined;
}

function isDirectAction(action: AgentAction) {
  return (
    action.type === "canvas_connect_nodes" ||
    action.type === "canvas_select_nodes" ||
    action.type === "canvas_group_nodes" ||
    action.type === "canvas_set_viewport" ||
    action.type === "canvas_director_open" ||
    action.type === "canvas_director_select_shot" ||
    action.type === "canvas_director_update_entity" ||
    // 外壳面板开合/主题/配色是无破坏性的 UI 导航，允许直接执行。
    action.type === "ui_open_panel" ||
    action.type === "ui_close_panel" ||
    action.type === "ui_set_theme" ||
    action.type === "ui_set_color_scheme"
  );
}

/**
 * 自动执行档下允许 direct 的动作：在上面那组低风险动作之外，再加上画布结构写入
 * （建节点、改正文、建组/解组已在其中）。不做删除：动作集里本来就没有删除动作。
 */
function isAutoDirectAction(action: AgentAction) {
  return (
    isDirectAction(action) ||
    action.type === "canvas_add_node" ||
    action.type === "canvas_update_node"
  );
}

function isPendingProposal(
  run: Awaited<ReturnType<AgentStore["getRun"]>>,
): run is NonNullable<typeof run> {
  return Boolean(
    run &&
    run.status === "completed" &&
    run.executionMode === "proposal" &&
    run.proposal &&
    run.proposalStatus === "pending" &&
    !run.receipt,
  );
}

function canReceiveReceipt(run: NonNullable<Awaited<ReturnType<AgentStore["getRun"]>>>) {
  return (
    run.status === "completed" &&
    run.actions.length > 0 &&
    (run.executionMode === "direct" ||
      (run.executionMode === "proposal" && run.proposalStatus === "confirmed"))
  );
}

function validateReceipt(
  actionCount: number,
  expectedRevision: string,
  receipt: z.infer<typeof agentExecutionReceiptCreateRequestSchema>,
) {
  const accounted = receipt.appliedActions + receipt.skippedActions.length;
  const skippedIndexes = receipt.skippedActions.map((item) => item.index);
  const invalidCount =
    accounted !== actionCount ||
    skippedIndexes.some((index) => index >= actionCount) ||
    new Set(skippedIndexes).size !== skippedIndexes.length ||
    (receipt.status === "applied" &&
      (receipt.appliedActions !== actionCount || receipt.skippedActions.length > 0)) ||
    (receipt.status === "partial" &&
      (receipt.appliedActions === 0 || receipt.skippedActions.length === 0)) ||
    (receipt.status === "rejected" && receipt.appliedActions !== 0);
  if (invalidCount) {
    throw new AgentServiceError("EXECUTION_RECEIPT_INVALID", "执行回执与提案动作数量不一致");
  }
  if (receipt.status !== "rejected" && receipt.contextRevisionBefore !== expectedRevision) {
    throw new AgentServiceError("PROJECT_CONTEXT_STALE", "画布已发生变化，不能应用这项旧提案");
  }
}

function messageTitle(content: string) {
  return content.replace(/\s+/g, " ").trim().slice(0, 28) || "新对话";
}

function publicExecutionError(cause: unknown): AgentRunError {
  if (cause instanceof AgentExecutionError) {
    return { code: cause.code, message: cause.message, retryable: cause.retryable };
  }
  return { code: "AGENT_RUN_FAILED", message: "Agent 暂时无法完成这次任务", retryable: true };
}

export class AgentExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}
