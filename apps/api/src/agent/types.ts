import type {
  AgentAction,
  AgentCanvasContext,
  AgentConversation,
  AgentConversationDetail,
  AgentExecutionMode,
  AgentExecutionPermission,
  AgentExecutionReceipt,
  AgentMessage,
  AgentMessageAttachmentInput,
  AgentModelCatalog,
  AgentProposal,
  AgentProposalDraft,
  AgentRun,
  AgentRunError,
  AgentSkill,
  AgentSkillRunContext,
} from "@weftcanvas/contracts";

export type AgentConversationRecord = AgentConversation & {
  ownerId: string;
};

export type AgentRunRecord = AgentRun & {
  ownerId: string;
  idempotencyKey: string;
  canvasContext: AgentCanvasContext;
};

export type CreateAgentRunInput = {
  conversation: AgentConversationRecord;
  userMessage: AgentMessage;
  run: AgentRunRecord;
  suggestedTitle: string;
};

export type CompleteAgentRunInput = {
  actions: AgentAction[];
  executionMode: AgentExecutionMode;
  proposal: AgentProposal | null;
  proposalStatus: AgentRun["proposalStatus"];
};

export interface AgentStore {
  createConversation(conversation: AgentConversationRecord): Promise<void>;
  listConversations(
    ownerId: string,
    projectId: string,
    limit: number,
  ): Promise<AgentConversation[]>;
  getConversation(ownerId: string, conversationId: string): Promise<AgentConversationRecord | null>;
  getDetail(ownerId: string, conversationId: string): Promise<AgentConversationDetail | null>;
  getRun(ownerId: string, runId: string): Promise<AgentRunRecord | null>;
  getRunContext(ownerId: string, runId: string): Promise<AgentCanvasContext | null>;
  createRun(input: CreateAgentRunInput): Promise<{ run: AgentRunRecord; created: boolean }>;
  markRunning(ownerId: string, runId: string, startedAt: string): Promise<boolean>;
  completeRun(
    ownerId: string,
    runId: string,
    message: AgentMessage,
    result: CompleteAgentRunInput,
    completedAt: string,
  ): Promise<boolean>;
  failRun(
    ownerId: string,
    runId: string,
    error: AgentRunError,
    completedAt: string,
  ): Promise<boolean>;
  cancelRun(ownerId: string, runId: string, completedAt: string): Promise<boolean>;
  confirmProposal(ownerId: string, runId: string): Promise<boolean>;
  dismissProposal(ownerId: string, runId: string): Promise<boolean>;
  recordReceipt(ownerId: string, runId: string, receipt: AgentExecutionReceipt): Promise<boolean>;
}

export type AgentExecutionRequest = {
  modelId: string;
  /** 思考强度档位，透传给运行时的 OpenAI 兼容请求。 */
  reasoningEffort?: string;
  /** 本轮执行权限档（已随运行冻结）。 */
  executionPermission: AgentExecutionPermission;
  /** 本轮启用的技能（正文由 API 侧从技能库读出并裁剪）。 */
  skills: AgentSkillRunContext[];
  /** 本轮用户显式附加的参考素材（仅本轮在内存中传递，不落库）。 */
  attachments: AgentMessageAttachmentInput[];
  conversation: AgentConversation;
  messages: AgentMessage[];
  canvasContext: AgentCanvasContext;
  /** 归属用户：运行时用它在 API 上派发"用户自己机器"上的任务。 */
  ownerId?: string;
  remoteConnectors?: { blender: boolean };
};

/**
 * Agent 只读技能库的最小面：技能存储由 `apps/api/src/skills` 提供，
 * 这里只声明服务层需要的那一个方法（子集接口，避免把存储实现耦合进 Agent）。
 */
export interface AgentSkillReader {
  read(ownerId: string, id: string): Promise<AgentSkill | null>;
}

export interface AgentExecutor {
  getModels(): Promise<AgentModelCatalog>;
  execute(
    value: AgentExecutionRequest,
    signal: AbortSignal,
  ): Promise<{
    content: string;
    actions: AgentAction[];
    executionMode: AgentExecutionMode;
    proposal: AgentProposalDraft | null;
  }>;
}
