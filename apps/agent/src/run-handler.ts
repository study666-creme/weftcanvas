import { ZodError } from "zod";

import { OpenAICompatibleClient, OpenAICompatibleError } from "./openai-compatible.js";
import { parseAgentModelOutput, type AgentModelOutput, type AgentToolCall } from "./agent-output.js";
import { readProfessionalBaselineStatus } from "./creative-guidance.js";
import type { AgentKnowledgeRetriever } from "./knowledge.js";
import type { AgentModelRegistry } from "./models.js";
import { buildChatMessages } from "./prompt.js";
import { parseAgentExecutionRequest, type AgentExecutionRequest } from "./request.js";
import { formatToolCatalog, type AgentTool } from "./tools.js";

export type RunHandlerResult =
  | { status: 200; body: { ok: true; data: AgentModelOutput } }
  | { status: 400 | 502 | 503; body: { ok: false; error: { code: string; message: string } } };

/** 最多两轮工具调用：先调用、看结果、再给最终回复。 */
const MAX_TOOL_ROUNDS = 2;
const MAX_TOOL_CALLS_PER_ROUND = 2;

export type AgentToolProvider = {
  buildTools(request: AgentExecutionRequest, signal?: AbortSignal): Promise<AgentTool[]>;
};

export class AgentRunHandler {
  constructor(
    private readonly model: Pick<OpenAICompatibleClient, "complete">,
    private readonly models: Pick<AgentModelRegistry, "allows">,
    private readonly knowledge?: AgentKnowledgeRetriever,
    private readonly tooling?: AgentToolProvider,
  ) {}

  async handle(value: unknown, signal?: AbortSignal): Promise<RunHandlerResult> {
    let request;
    try {
      request = parseAgentExecutionRequest(value);
    } catch (error) {
      return {
        status: 400,
        body: {
          ok: false,
          error: {
            code: "INVALID_REQUEST",
            message: error instanceof ZodError
              ? "请求体不符合 Agent 运行时契约"
              : "请求体无效",
          },
        },
      };
    }

    if (!this.models.allows(request.modelId)) {
      return {
        status: 400,
        body: {
          ok: false,
          error: {
            code: "MODEL_NOT_ALLOWED",
            message: "The selected model is not available",
          },
        },
      };
    }

    try {
      const latestQuery = request.messages.at(-1)?.content ?? "";
      const knowledgeContext = await this.retrieveKnowledge(latestQuery, signal);
      const tools = await this.loadTools(request, signal);
      const toolCatalog = tools.length ? formatToolCatalog(tools) : "";
      let messages = buildChatMessages(request.messages, request.canvasContext, knowledgeContext, toolCatalog);
      let output = parseAgentModelOutput("");

      for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
        const raw = await this.model.complete(messages, request.modelId, signal, request.reasoningEffort);
        output = enforceProfessionalBaseline(
          parseAgentModelOutput(raw),
          request.canvasContext.creativeGuidance,
        );
        // 画布操作与工具调用互斥：有画布操作时忽略工具调用，避免同一轮既有落盘又有本机副作用。
        const calls = output.actions.length ? [] : output.toolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
        if (!calls.length || round === MAX_TOOL_ROUNDS) break;
        const results = await Promise.all(calls.map((call) => runTool(tools, call, signal)));
        messages = [
          ...messages,
          { role: "assistant", content: raw },
          { role: "user", content: formatToolResults(calls, results) },
        ];
      }

      return {
        status: 200,
        body: {
          ok: true,
          data: { ...output, toolCalls: [] },
        },
      };
    } catch (error) {
      if (error instanceof OpenAICompatibleError) {
        return {
          status: error.retryable ? 503 : 502,
          body: {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
            },
          },
        };
      }
      return {
        status: 503,
        body: {
          ok: false,
          error: {
            code: "MODEL_UNAVAILABLE",
            message: "模型服务暂时不可用",
          },
        },
      };
    }
  }

  /**
   * 连接探测失败不应让整轮对话失败：拿不到工具就按"本轮没有本机工具"继续，
   * 模型不会因此以为 Blender 或 Codex 可用。
   */
  private async loadTools(request: AgentExecutionRequest, signal?: AbortSignal): Promise<AgentTool[]> {
    if (!this.tooling) return [];
    try {
      return await this.tooling.buildTools(request, signal);
    } catch {
      return [];
    }
  }

  private async retrieveKnowledge(query: string, signal?: AbortSignal) {
    if (!this.knowledge || !query.trim()) return "";
    try {
      return await this.knowledge.retrieve(query, signal);
    } catch {
      return "";
    }
  }
}

async function runTool(tools: readonly AgentTool[], call: AgentToolCall, signal?: AbortSignal) {
  const tool = tools.find((item) => item.name === call.name);
  if (!tool) return { ok: false, content: `未知工具 ${call.name}` };
  try {
    return await tool.run(call.arguments, { ...(signal ? { signal } : {}) });
  } catch (cause) {
    return { ok: false, content: cause instanceof Error ? cause.message : "工具执行失败" };
  }
}

function formatToolResults(
  calls: readonly AgentToolCall[],
  results: ReadonlyArray<{ ok: boolean; content: string }>,
) {
  const lines = ["本机工具执行结果："];
  calls.forEach((call, index) => {
    const result = results[index];
    lines.push(`- ${call.name}：${result?.ok ? "成功" : "失败"} ${result?.content ?? ""}`.trim());
  });
  lines.push("请基于以上结果给出最终 JSON 回复（本轮不要再调用工具）。");
  return lines.join("\n").slice(0, 12_000);
}

function enforceProfessionalBaseline(
  output: AgentModelOutput,
  guidance: ReturnType<typeof parseAgentExecutionRequest>["canvasContext"]["creativeGuidance"],
): AgentModelOutput {
  const status = readProfessionalBaselineStatus(guidance);
  if (!status.required || status.ready || (!output.actions.length && !output.toolCalls.length)) return output;
  return {
    content: `专业辅助会先定好创作基线。请先确认${status.missing.join("、")}，再继续创作。`,
    actions: [],
    toolCalls: [],
    executionMode: "none",
    proposal: null,
  };
}
