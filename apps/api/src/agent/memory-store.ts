import {
  agentCanvasContextSchema,
  agentActionSchema,
  agentConversationDetailSchema,
  agentConversationSchema,
  agentExecutionReceiptSchema,
  agentMessageSchema,
  agentRunErrorSchema,
  agentRunSchema,
  type AgentCanvasContext,
  type AgentAction,
  type AgentConversation,
  type AgentConversationDetail,
  type AgentExecutionReceipt,
  type AgentMessage,
  type AgentRun,
  type AgentRunError,
} from "@kachang/contracts";

import type {
  AgentConversationRecord,
  AgentRunRecord,
  AgentStore,
  CompleteAgentRunInput,
  CreateAgentRunInput,
} from "./types.js";

const DEFAULT_CONVERSATION_TITLE = "\u65b0\u5bf9\u8bdd";
const DETAIL_MESSAGE_LIMIT = 500;
const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CONVERSATIONS = 2_000;

export type MemoryAgentStoreOptions = {
  now?: () => number;
  retentionMs?: number;
  maxConversations?: number;
};

export class MemoryAgentStore implements AgentStore {
  private readonly conversations = new Map<string, AgentConversationRecord>();
  private readonly messages = new Map<string, AgentMessage>();
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxConversations: number;

  constructor(options: MemoryAgentStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = positiveNumber(options.retentionMs ?? DEFAULT_RETENTION_MS, "retentionMs");
    this.maxConversations = positiveInteger(
      options.maxConversations ?? DEFAULT_MAX_CONVERSATIONS,
      "maxConversations",
    );
  }

  async createConversation(conversation: AgentConversationRecord) {
    this.cleanup();
    if (this.conversations.has(conversation.id)) {
      throw new Error(`Agent conversation already exists: ${conversation.id}`);
    }
    this.conversations.set(conversation.id, conversationRecord(conversation));
    this.cleanup();
  }

  async listConversations(ownerId: string, projectId: string, limit: number) {
    this.cleanup();
    return [...this.conversations.values()]
      .filter((conversation) => conversation.ownerId === ownerId && conversation.projectId === projectId)
      .sort((left, right) => compareTimestampAndId(right, left))
      .slice(0, limit)
      .map(publicConversation);
  }

  async getConversation(ownerId: string, conversationId: string) {
    const conversation = this.conversations.get(conversationId);
    return conversation?.ownerId === ownerId ? clone(conversation) : null;
  }

  async getDetail(ownerId: string, conversationId: string): Promise<AgentConversationDetail | null> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || conversation.ownerId !== ownerId) return null;

    const messages = [...this.messages.values()]
      .filter((message) => message.conversationId === conversationId)
      .sort((left, right) => compareTimestampAndId(right, left))
      .slice(0, DETAIL_MESSAGE_LIMIT)
      .sort(compareTimestampAndId)
      .map(publicMessage);
    const latestRun = [...this.runs.values()]
      .filter((run) => run.ownerId === ownerId && run.conversationId === conversationId)
      .sort((left, right) => compareTimestampAndId(right, left))[0];

    return agentConversationDetailSchema.parse({
      conversation: publicConversation(conversation),
      messages,
      latestRun: latestRun ? publicRun(latestRun) : null,
    });
  }

  async getRunContext(ownerId: string, runId: string): Promise<AgentCanvasContext | null> {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId ? agentCanvasContextSchema.parse(clone(run.canvasContext)) : null;
  }

  async getRun(ownerId: string, runId: string) {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId ? runRecord(run) : null;
  }

  async createRun(input: CreateAgentRunInput) {
    this.cleanup();
    const conversation = this.conversations.get(input.conversation.id);
    if (!conversation || conversation.ownerId !== input.conversation.ownerId) {
      throw new Error("Agent conversation disappeared before run creation");
    }

    assertRunRelationships(input, conversation);
    const existing = [...this.runs.values()].find(
      (run) => run.ownerId === input.run.ownerId && run.idempotencyKey === input.run.idempotencyKey,
    );
    if (existing) return { run: clone(existing), created: false };

    if (this.messages.has(input.userMessage.id)) {
      throw new Error(`Agent message already exists: ${input.userMessage.id}`);
    }
    if (this.runs.has(input.run.id)) {
      throw new Error(`Agent run already exists: ${input.run.id}`);
    }

    const userMessage = agentMessageSchema.parse(clone(input.userMessage));
    const run = runRecord(input.run);
    const updatedConversation = conversationRecord({
      ...conversation,
      title: conversation.title === DEFAULT_CONVERSATION_TITLE ? input.suggestedTitle : conversation.title,
      updatedAt: run.createdAt,
    });

    this.messages.set(userMessage.id, userMessage);
    this.runs.set(run.id, run);
    this.conversations.set(updatedConversation.id, updatedConversation);
    this.cleanup();
    return { run: clone(run), created: true };
  }

  async markRunning(ownerId: string, runId: string, startedAt: string) {
    this.cleanup();
    const run = this.activeRun(ownerId, runId);
    if (!run || run.status !== "queued") return false;
    run.status = "running";
    run.startedAt ??= startedAt;
    return true;
  }

  async completeRun(ownerId: string, runId: string, message: AgentMessage, result: CompleteAgentRunInput, completedAt: string) {
    this.cleanup();
    const run = this.activeRun(ownerId, runId);
    if (!run) return false;
    if (this.messages.has(message.id)) {
      throw new Error(`Agent message already exists: ${message.id}`);
    }

    const assistantMessage = agentMessageSchema.parse({
      ...clone(message),
      conversationId: run.conversationId,
      role: "assistant",
    });
    this.messages.set(assistantMessage.id, assistantMessage);
    run.status = "completed";
    run.assistantMessageId = assistantMessage.id;
    run.actions = result.actions.map((action) => agentActionSchema.parse(clone(action)));
    run.executionMode = result.executionMode;
    run.proposal = result.proposal ? clone(result.proposal) : null;
    run.proposalStatus = result.proposalStatus;
    run.receipt = null;
    run.error = null;
    run.completedAt = completedAt;
    this.touchConversation(ownerId, run.conversationId, completedAt);
    this.cleanup();
    return true;
  }

  async failRun(ownerId: string, runId: string, error: AgentRunError, completedAt: string) {
    const parsedError = agentRunErrorSchema.parse(clone(error));
    this.cleanup();
    const run = this.activeRun(ownerId, runId);
    if (!run) return false;
    run.status = "failed";
    run.error = parsedError;
    run.completedAt = completedAt;
    this.touchConversation(ownerId, run.conversationId, completedAt);
    this.cleanup();
    return true;
  }

  async cancelRun(ownerId: string, runId: string, completedAt: string) {
    this.cleanup();
    const run = this.activeRun(ownerId, runId);
    if (!run) return false;
    run.status = "cancelled";
    run.error = null;
    run.completedAt = completedAt;
    this.touchConversation(ownerId, run.conversationId, completedAt);
    this.cleanup();
    return true;
  }

  async confirmProposal(ownerId: string, runId: string) {
    const run = this.runs.get(runId);
    if (!canResolveProposal(run, ownerId) || run.proposalStatus !== "pending") return false;
    run.proposalStatus = "confirmed";
    return true;
  }

  async dismissProposal(ownerId: string, runId: string) {
    const run = this.runs.get(runId);
    if (!canResolveProposal(run, ownerId) || run.proposalStatus !== "pending") return false;
    run.proposalStatus = "dismissed";
    return true;
  }

  async recordReceipt(ownerId: string, runId: string, receipt: AgentExecutionReceipt) {
    const run = this.runs.get(runId);
    if (!canRecordReceipt(run, ownerId)) return false;
    run.receipt = agentExecutionReceiptSchema.parse(clone(receipt));
    return true;
  }

  private activeRun(ownerId: string, runId: string) {
    const run = this.runs.get(runId);
    return run?.ownerId === ownerId && (run.status === "queued" || run.status === "running")
      ? run
      : null;
  }

  private touchConversation(ownerId: string, conversationId: string, updatedAt: string) {
    const conversation = this.conversations.get(conversationId);
    if (conversation?.ownerId === ownerId) conversation.updatedAt = updatedAt;
  }

  private cleanup() {
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error("MemoryAgentStore now() must return a finite timestamp");
    const expiresBefore = now - this.retentionMs;

    for (const conversation of this.conversations.values()) {
      if (Date.parse(conversation.updatedAt) < expiresBefore) this.deleteConversation(conversation.id);
    }

    const overflow = this.conversations.size - this.maxConversations;
    if (overflow <= 0) return;
    const oldest = [...this.conversations.values()].sort(compareTimestampAndId).slice(0, overflow);
    for (const conversation of oldest) this.deleteConversation(conversation.id);
  }

  private deleteConversation(conversationId: string) {
    this.conversations.delete(conversationId);
    for (const message of this.messages.values()) {
      if (message.conversationId === conversationId) this.messages.delete(message.id);
    }
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) this.runs.delete(run.id);
    }
  }
}

function canResolveProposal(run: AgentRunRecord | undefined, ownerId: string): run is AgentRunRecord {
  return Boolean(
    run
    && run.ownerId === ownerId
    && run.status === "completed"
    && run.executionMode === "proposal"
    && run.proposal
    && !run.receipt,
  );
}

function canRecordReceipt(run: AgentRunRecord | undefined, ownerId: string): run is AgentRunRecord {
  return Boolean(
    run
    && run.ownerId === ownerId
    && run.status === "completed"
    && !run.receipt
    && (run.executionMode === "direct" || (run.executionMode === "proposal" && run.proposalStatus === "confirmed")),
  );
}

function assertRunRelationships(input: CreateAgentRunInput, conversation: AgentConversationRecord) {
  if (
    input.run.ownerId !== conversation.ownerId
    || input.run.conversationId !== conversation.id
    || input.userMessage.conversationId !== conversation.id
    || input.run.userMessageId !== input.userMessage.id
    || input.run.canvasContext.projectId !== conversation.projectId
  ) {
    throw new Error("Agent run does not belong to its conversation and project");
  }
}

function conversationRecord(value: AgentConversationRecord): AgentConversationRecord {
  return { ...agentConversationSchema.parse(clone(value)), ownerId: value.ownerId };
}

function runRecord(value: AgentRunRecord): AgentRunRecord {
  return {
    ...agentRunSchema.parse(clone(value)),
    ownerId: value.ownerId,
    idempotencyKey: value.idempotencyKey,
    canvasContext: agentCanvasContextSchema.parse(clone(value.canvasContext)),
  };
}

function publicConversation(value: AgentConversationRecord): AgentConversation {
  return agentConversationSchema.parse(clone(value));
}

function publicMessage(value: AgentMessage): AgentMessage {
  return agentMessageSchema.parse(clone(value));
}

function publicRun(value: AgentRunRecord): AgentRun {
  return agentRunSchema.parse(clone(value));
}

function compareTimestampAndId(
  left: { createdAt: string; id: string; updatedAt?: string },
  right: { createdAt: string; id: string; updatedAt?: string },
) {
  const leftTimestamp = Date.parse(left.updatedAt ?? left.createdAt);
  const rightTimestamp = Date.parse(right.updatedAt ?? right.createdAt);
  if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
  return compareText(left.id, right.id);
}

function compareText(left: string, right: string) {
  return left === right ? 0 : left < right ? -1 : 1;
}

function positiveNumber(value: number, name: string) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive number`);
  return value;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}
