import {
  agentCanvasContextSchema,
  agentActionSchema,
  agentConversationDetailSchema,
  agentConversationSchema,
  agentExecutionReceiptSchema,
  agentMessageSchema,
  agentProposalSchema,
  agentRunErrorSchema,
  agentRunSchema,
  type AgentCanvasContext,
  type AgentConversation,
  type AgentConversationDetail,
  type AgentExecutionReceipt,
  type AgentMessage,
  type AgentRunError,
} from "@weftcanvas/contracts";
import type { Pool, PoolClient } from "pg";

import type {
  AgentConversationRecord,
  AgentRunRecord,
  AgentStore,
  CompleteAgentRunInput,
  CreateAgentRunInput,
} from "./types.js";
import { ensureCloudPrincipal } from "../project/principal.js";

type ConversationRow = {
  id: string;
  owner_id: string;
  project_id: string;
  title: string;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: Date | string;
};

type RunRow = {
  id: string;
  owner_id: string;
  conversation_id: string;
  user_message_id: string;
  assistant_message_id: string | null;
  model_id: string | null;
  idempotency_key: string;
  status: AgentRunRecord["status"];
  canvas_context: unknown;
  actions: unknown;
  execution_mode: AgentRunRecord["executionMode"];
  proposal: unknown;
  proposal_status: AgentRunRecord["proposalStatus"];
  context_revision: string;
  receipt: unknown;
  error: unknown;
  created_at: Date | string;
  started_at: Date | string | null;
  completed_at: Date | string | null;
};

export class PostgresAgentStore implements AgentStore {
  constructor(private readonly pool: Pool) {}

  async createConversation(conversation: AgentConversationRecord) {
    await ensureCloudPrincipal(this.pool, conversation.ownerId, conversation.createdAt);
    await this.pool.query(
      `INSERT INTO canvas_agent_conversations (
        id, owner_id, project_id, title, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        conversation.id,
        conversation.ownerId,
        conversation.projectId,
        conversation.title,
        conversation.createdAt,
        conversation.updatedAt,
      ],
    );
  }

  async listConversations(ownerId: string, projectId: string, limit: number) {
    const result = await this.pool.query<ConversationRow>(
      `${conversationSelect()}
       WHERE owner_id = $1 AND project_id = $2
       ORDER BY updated_at DESC, id DESC
       LIMIT $3`,
      [ownerId, projectId, limit],
    );
    return result.rows.map(publicConversation);
  }

  async getConversation(ownerId: string, conversationId: string) {
    const result = await this.pool.query<ConversationRow>(
      `${conversationSelect()} WHERE owner_id = $1 AND id = $2`,
      [ownerId, conversationId],
    );
    return result.rows[0] ? conversationRecord(result.rows[0]) : null;
  }

  async getDetail(
    ownerId: string,
    conversationId: string,
  ): Promise<AgentConversationDetail | null> {
    const conversation = await this.getConversation(ownerId, conversationId);
    if (!conversation) return null;
    const [messages, runs] = await Promise.all([
      this.pool.query<MessageRow>(
        `SELECT * FROM (
          SELECT id, conversation_id, role, content, created_at
          FROM canvas_agent_messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 500
        ) recent
        ORDER BY created_at ASC, id ASC`,
        [conversationId],
      ),
      this.pool.query<RunRow>(
        `SELECT id, owner_id, conversation_id, user_message_id,
          assistant_message_id, model_id, idempotency_key, status, canvas_context,
          actions, execution_mode, proposal, proposal_status, context_revision, receipt,
          error, created_at, started_at, completed_at
         FROM canvas_agent_runs
         WHERE owner_id = $1 AND conversation_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [ownerId, conversationId],
      ),
    ]);
    return agentConversationDetailSchema.parse({
      conversation: publicConversation(conversation),
      messages: messages.rows.map(publicMessage),
      latestRun: runs.rows[0] ? publicRun(runs.rows[0]) : null,
    });
  }

  async getRunContext(ownerId: string, runId: string): Promise<AgentCanvasContext | null> {
    const result = await this.pool.query<{ canvas_context: unknown }>(
      `SELECT canvas_context FROM canvas_agent_runs WHERE owner_id = $1 AND id = $2`,
      [ownerId, runId],
    );
    return result.rows[0] ? agentCanvasContextSchema.parse(result.rows[0].canvas_context) : null;
  }

  async getRun(ownerId: string, runId: string) {
    const result = await this.pool.query<RunRow>(`${runSelect()} WHERE owner_id = $1 AND id = $2`, [
      ownerId,
      runId,
    ]);
    return result.rows[0] ? runRecord(result.rows[0]) : null;
  }

  async createRun(input: CreateAgentRunInput) {
    return withTransaction(this.pool, async (client) => {
      const locked = await client.query<ConversationRow>(
        `${conversationSelect()} WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
        [input.conversation.ownerId, input.conversation.id],
      );
      if (!locked.rows[0]) throw new Error("Agent conversation disappeared before run creation");
      const existing = await client.query<RunRow>(
        `${runSelect()} WHERE owner_id = $1 AND idempotency_key = $2`,
        [input.run.ownerId, input.run.idempotencyKey],
      );
      if (existing.rows[0]) return { run: runRecord(existing.rows[0]), created: false };

      await client.query(
        `INSERT INTO canvas_agent_messages (id, conversation_id, role, content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          input.userMessage.id,
          input.userMessage.conversationId,
          input.userMessage.role,
          input.userMessage.content,
          input.userMessage.createdAt,
        ],
      );
      await client.query(
        `INSERT INTO canvas_agent_runs (
          id, owner_id, conversation_id, user_message_id, assistant_message_id,
          model_id, idempotency_key, status, canvas_context, actions, execution_mode,
          proposal, proposal_status, context_revision, receipt, error,
          created_at, started_at, completed_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9::JSONB, $10::JSONB, $11,
          $12::JSONB, $13, $14, $15::JSONB, $16::JSONB, $17, $18, $19
        )`,
        [
          input.run.id,
          input.run.ownerId,
          input.run.conversationId,
          input.run.userMessageId,
          input.run.assistantMessageId,
          input.run.modelId,
          input.run.idempotencyKey,
          input.run.status,
          JSON.stringify(input.run.canvasContext),
          JSON.stringify(input.run.actions),
          input.run.executionMode,
          input.run.proposal ? JSON.stringify(input.run.proposal) : null,
          input.run.proposalStatus,
          input.run.contextRevision,
          input.run.receipt ? JSON.stringify(input.run.receipt) : null,
          input.run.error ? JSON.stringify(input.run.error) : null,
          input.run.createdAt,
          input.run.startedAt,
          input.run.completedAt,
        ],
      );
      await client.query(
        `UPDATE canvas_agent_conversations
         SET title = CASE WHEN title = '新对话' THEN $3 ELSE title END,
             updated_at = $4
         WHERE owner_id = $1 AND id = $2`,
        [input.run.ownerId, input.run.conversationId, input.suggestedTitle, input.run.createdAt],
      );
      return { run: input.run, created: true };
    });
  }

  async markRunning(ownerId: string, runId: string, startedAt: string) {
    const result = await this.pool.query(
      `UPDATE canvas_agent_runs
       SET status = 'running', started_at = COALESCE(started_at, $3)
       WHERE owner_id = $1 AND id = $2 AND status = 'queued'
       RETURNING id`,
      [ownerId, runId, startedAt],
    );
    return result.rowCount === 1;
  }

  async completeRun(
    ownerId: string,
    runId: string,
    message: AgentMessage,
    result: CompleteAgentRunInput,
    completedAt: string,
  ) {
    return withTransaction(this.pool, async (client) => {
      const run = await lockActiveRun(client, ownerId, runId);
      if (!run) return false;
      await client.query(
        `INSERT INTO canvas_agent_messages (id, conversation_id, role, content, created_at)
         VALUES ($1, $2, 'assistant', $3, $4)`,
        [message.id, run.conversation_id, message.content, message.createdAt],
      );
      await client.query(
        `UPDATE canvas_agent_runs
         SET status = 'completed', assistant_message_id = $3, actions = $4::JSONB,
             execution_mode = $5, proposal = $6::JSONB, proposal_status = $7,
             receipt = NULL, error = NULL, completed_at = $8
         WHERE owner_id = $1 AND id = $2`,
        [
          ownerId,
          runId,
          message.id,
          JSON.stringify(result.actions.map((action) => agentActionSchema.parse(action))),
          result.executionMode,
          result.proposal ? JSON.stringify(agentProposalSchema.parse(result.proposal)) : null,
          result.proposalStatus,
          completedAt,
        ],
      );
      await touchConversation(client, ownerId, run.conversation_id, completedAt);
      return true;
    });
  }

  async failRun(ownerId: string, runId: string, error: AgentRunError, completedAt: string) {
    const result = await this.pool.query<{ conversation_id: string }>(
      `UPDATE canvas_agent_runs
       SET status = 'failed', error = $3::JSONB, completed_at = $4
       WHERE owner_id = $1 AND id = $2 AND status IN ('queued', 'running')
       RETURNING conversation_id`,
      [ownerId, runId, JSON.stringify(agentRunErrorSchema.parse(error)), completedAt],
    );
    if (result.rows[0])
      await touchConversation(this.pool, ownerId, result.rows[0].conversation_id, completedAt);
    return result.rowCount === 1;
  }

  async cancelRun(ownerId: string, runId: string, completedAt: string) {
    const result = await this.pool.query<{ conversation_id: string }>(
      `UPDATE canvas_agent_runs
       SET status = 'cancelled', error = NULL, completed_at = $3
       WHERE owner_id = $1 AND id = $2 AND status IN ('queued', 'running')
       RETURNING conversation_id`,
      [ownerId, runId, completedAt],
    );
    if (result.rows[0])
      await touchConversation(this.pool, ownerId, result.rows[0].conversation_id, completedAt);
    return result.rowCount === 1;
  }

  async confirmProposal(ownerId: string, runId: string) {
    const result = await this.pool.query(
      `UPDATE canvas_agent_runs
       SET proposal_status = 'confirmed'
       WHERE owner_id = $1 AND id = $2 AND status = 'completed'
         AND execution_mode = 'proposal' AND proposal IS NOT NULL
         AND proposal_status = 'pending' AND receipt IS NULL
       RETURNING id`,
      [ownerId, runId],
    );
    return result.rowCount === 1;
  }

  async dismissProposal(ownerId: string, runId: string) {
    const result = await this.pool.query(
      `UPDATE canvas_agent_runs
       SET proposal_status = 'dismissed'
       WHERE owner_id = $1 AND id = $2 AND status = 'completed'
         AND execution_mode = 'proposal' AND proposal IS NOT NULL
         AND proposal_status = 'pending' AND receipt IS NULL
       RETURNING id`,
      [ownerId, runId],
    );
    return result.rowCount === 1;
  }

  async recordReceipt(ownerId: string, runId: string, receipt: AgentExecutionReceipt) {
    const result = await this.pool.query(
      `UPDATE canvas_agent_runs
       SET receipt = $3::JSONB
       WHERE owner_id = $1 AND id = $2 AND status = 'completed' AND receipt IS NULL
         AND (execution_mode = 'direct' OR (execution_mode = 'proposal' AND proposal_status = 'confirmed'))
       RETURNING id`,
      [ownerId, runId, JSON.stringify(agentExecutionReceiptSchema.parse(receipt))],
    );
    return result.rowCount === 1;
  }
}

function conversationSelect() {
  return `SELECT id, owner_id, project_id, title, created_at, updated_at
    FROM canvas_agent_conversations`;
}

function runSelect() {
  return `SELECT id, owner_id, conversation_id, user_message_id,
    assistant_message_id, model_id, idempotency_key, status, canvas_context,
    actions, execution_mode, proposal, proposal_status, context_revision, receipt,
    error, created_at, started_at, completed_at
    FROM canvas_agent_runs`;
}

function publicConversation(row: ConversationRow | AgentConversationRecord): AgentConversation {
  return agentConversationSchema.parse({
    schemaVersion: 1,
    id: row.id,
    projectId: "project_id" in row ? row.project_id : row.projectId,
    title: row.title,
    createdAt: "created_at" in row ? dateIso(row.created_at) : row.createdAt,
    updatedAt: "updated_at" in row ? dateIso(row.updated_at) : row.updatedAt,
  });
}

function conversationRecord(row: ConversationRow): AgentConversationRecord {
  return { ...publicConversation(row), ownerId: row.owner_id };
}

function publicMessage(row: MessageRow) {
  return agentMessageSchema.parse({
    schemaVersion: 1,
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: dateIso(row.created_at),
  });
}

function publicRun(row: RunRow) {
  return agentRunSchema.parse({
    schemaVersion: 1,
    id: row.id,
    conversationId: row.conversation_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    modelId: row.model_id,
    status: row.status,
    actions: Array.isArray(row.actions)
      ? row.actions.map((action) => agentActionSchema.parse(action))
      : [],
    executionMode: row.execution_mode ?? "none",
    proposal: row.proposal ? agentProposalSchema.parse(row.proposal) : null,
    proposalStatus: row.proposal_status ?? null,
    contextRevision: row.context_revision || "legacy",
    receipt: row.receipt ? agentExecutionReceiptSchema.parse(row.receipt) : null,
    error: row.error ? agentRunErrorSchema.parse(row.error) : null,
    createdAt: dateIso(row.created_at),
    startedAt: row.started_at ? dateIso(row.started_at) : null,
    completedAt: row.completed_at ? dateIso(row.completed_at) : null,
  });
}

function runRecord(row: RunRow): AgentRunRecord {
  return {
    ...publicRun(row),
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    canvasContext: agentCanvasContextSchema.parse(row.canvas_context),
  };
}

async function lockActiveRun(client: PoolClient, ownerId: string, runId: string) {
  const result = await client.query<RunRow>(
    `${runSelect()}
     WHERE owner_id = $1 AND id = $2 AND status IN ('queued', 'running')
     FOR UPDATE`,
    [ownerId, runId],
  );
  return result.rows[0] ?? null;
}

async function touchConversation(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  ownerId: string,
  conversationId: string,
  updatedAt: string,
) {
  await client.query(
    `UPDATE canvas_agent_conversations SET updated_at = $3 WHERE owner_id = $1 AND id = $2`,
    [ownerId, conversationId, updatedAt],
  );
}

async function withTransaction<T>(pool: Pool, action: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function dateIso(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Agent timestamp is invalid");
  return date.toISOString();
}
