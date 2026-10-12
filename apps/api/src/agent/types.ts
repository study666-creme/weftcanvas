import type {
  AgentAction,
  AgentCanvasContext,
  AgentConversation,
  AgentConversationDetail,
  AgentExecutionMode,
  AgentExecutionReceipt,
  AgentMessage,
  AgentModelCatalog,
  AgentProposal,
  AgentProposalDraft,
  AgentRun,
  AgentRunError,
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
  conversation: AgentConversation;
  messages: AgentMessage[];
  canvasContext: AgentCanvasContext;
  /** 归属用户：运行时用它在 API 上派发"用户自己机器"上的任务。 */
  ownerId?: string;
  remoteConnectors?: { blender: boolean };
};

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
