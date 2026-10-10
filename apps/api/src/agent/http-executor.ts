import {
  agentActionSchema,
  agentExecutionModeSchema,
  agentModelCatalogResponseSchema,
  agentProposalDraftSchema,
  type AgentModelCatalog,
} from "@kachang/contracts";
import { z } from "zod";

import { AgentExecutionError } from "./service.js";
import type { AgentExecutionRequest, AgentExecutor } from "./types.js";

const responseSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    content: z.string().trim().min(1).max(16_000),
    actions: z.array(agentActionSchema).max(32).default([]),
    executionMode: agentExecutionModeSchema.optional(),
    proposal: agentProposalDraftSchema.nullable().optional(),
  }),
});

export class HttpAgentExecutor implements AgentExecutor {
  private readonly runEndpoint: string;
  private readonly modelsEndpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private modelsCache: { value: AgentModelCatalog; expiresAt: number } | undefined;
  private modelsInflight: Promise<AgentModelCatalog> | undefined;

  constructor(
    baseUrl: string,
    private readonly token: string,
    private readonly timeoutMs = 5 * 60_000,
    options: { fetchImpl?: typeof fetch; now?: () => number } = {},
  ) {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    this.runEndpoint = new URL("/internal/v1/runs", normalizedBaseUrl).toString();
    this.modelsEndpoint = new URL("/internal/v1/models", normalizedBaseUrl).toString();
    if (!token.trim()) throw new Error("Agent runtime token is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
      throw new Error("Agent runtime timeout is invalid");
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async getModels() {
    const cached = this.modelsCache;
    if (cached && cached.expiresAt > this.now()) return structuredClone(cached.value);
    if (this.modelsInflight) {
      try {
        return structuredClone(await this.modelsInflight);
      } catch (cause) {
        if (cached) return structuredClone(cached.value);
        throw cause;
      }
    }

    const request = this.fetchModels().then((catalog) => {
      this.modelsCache = { value: structuredClone(catalog), expiresAt: this.now() + 5 * 60_000 };
      return catalog;
    });
    this.modelsInflight = request;
    try {
      return structuredClone(await request);
    } catch (cause) {
      // A transient Agent-runtime failure must not invalidate a catalog that
      // already allowed this API instance to serve requests successfully.
      if (cached) return structuredClone(cached.value);
      throw cause;
    } finally {
      if (this.modelsInflight === request) this.modelsInflight = undefined;
    }
  }

  async execute(value: AgentExecutionRequest, signal: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("Agent runtime timed out")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.runEndpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(value),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AgentExecutionError("AGENT_RUNTIME_UNAVAILABLE", "Agent 服务暂时不可用", response.status >= 500);
      }
      try {
        const data = responseSchema.parse(await response.json()).data;
        return {
          content: data.content,
          actions: data.actions,
          executionMode: data.executionMode ?? (data.actions.length ? "proposal" : "none"),
          proposal: data.proposal ?? null,
        };
      } catch {
        throw new AgentExecutionError("AGENT_RUNTIME_INVALID_RESPONSE", "Agent 返回了无法识别的结果", true);
      }
    } catch (cause) {
      if (cause instanceof AgentExecutionError) throw cause;
      if (signal.aborted) throw new AgentExecutionError("AGENT_RUN_CANCELLED", "Agent 任务已取消", false);
      throw new AgentExecutionError("AGENT_RUNTIME_UNAVAILABLE", "Agent 服务暂时不可用", true);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  private async fetchModels() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Agent runtime timed out")), this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.modelsEndpoint, {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AgentExecutionError(
          "AGENT_MODEL_CATALOG_UNAVAILABLE",
          "Agent model catalog is temporarily unavailable",
          response.status >= 500 || response.status === 429,
        );
      }
      try {
        return agentModelCatalogResponseSchema.parse(await response.json()).data;
      } catch {
        throw new AgentExecutionError(
          "AGENT_RUNTIME_INVALID_RESPONSE",
          "Agent returned an invalid model catalog",
          true,
        );
      }
    } catch (cause) {
      if (cause instanceof AgentExecutionError) throw cause;
      throw new AgentExecutionError(
        "AGENT_MODEL_CATALOG_UNAVAILABLE",
        "Agent model catalog is temporarily unavailable",
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function normalizeBaseUrl(value: string) {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Agent runtime URL must use HTTP or HTTPS");
  return url;
}
