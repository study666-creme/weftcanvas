import {
  agentConnectorListResponseSchema,
  agentConnectorResponseSchema,
  canvasControlPendingResponseSchema,
  canvasControlReceiptResponseSchema,
  type AgentCanvasContext,
  type AgentConnector,
  type AgentConnectorId,
  type AgentConnectorUpdateRequest,
  type CanvasControlCommand,
  type CanvasControlReceiptRequest,
} from "@weftcanvas/contracts";

import { AgentExecutionError } from "./service.js";

export type AgentConnectorGateway = {
  list(signal?: AbortSignal): Promise<AgentConnector[]>;
  update(
    id: AgentConnectorId,
    patch: AgentConnectorUpdateRequest,
    signal?: AbortSignal,
  ): Promise<AgentConnector>;
  /** 一键接入：运行时会写 Codex 配置 / 安装 Blender 插件，可能耗时较久。 */
  connect(
    id: AgentConnectorId,
    options: { launch?: boolean },
    signal?: AbortSignal,
  ): Promise<AgentConnector>;
  pending(
    projectId: string,
    context: AgentCanvasContext | undefined,
    signal?: AbortSignal,
  ): Promise<CanvasControlCommand[]>;
  recordReceipt(receipt: CanvasControlReceiptRequest, signal?: AbortSignal): Promise<boolean>;
};

/**
 * 浏览器 → Agent 运行时的连接器/画布通道代理。
 * 运行时是本机进程，浏览器拿不到它的令牌，所以这一段始终走 API。
 */
export class HttpAgentConnectorGateway implements AgentConnectorGateway {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(
    baseUrl: string,
    private readonly token: string,
    options: {
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
      pollTimeoutMs?: number;
      connectTimeoutMs?: number;
    } = {},
  ) {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol))
      throw new Error("Agent runtime URL must use HTTP or HTTPS");
    if (!token.trim()) throw new Error("Agent runtime token is required");
    this.baseUrl = url.toString().replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
      throw new Error("Agent runtime timeout is invalid");
    }
    this.pollTimeoutMs = options.pollTimeoutMs ?? Math.min(timeoutMs, 15_000);
    // 接入会写入 Codex 配置、安装 Blender 插件并可能启动 Blender，需要更长的等待。
    this.connectTimeoutMs = options.connectTimeoutMs ?? 180_000;
  }

  async connect(id: AgentConnectorId, options: { launch?: boolean }, signal?: AbortSignal) {
    return this.request(`/internal/v1/connectors/${id}/connect`, agentConnectorResponseSchema, {
      method: "POST",
      body: JSON.stringify(options),
      signal,
      timeoutMs: this.connectTimeoutMs,
    });
  }

  async list(signal?: AbortSignal) {
    return this.request("/internal/v1/connectors", agentConnectorListResponseSchema, { signal });
  }

  async update(id: AgentConnectorId, patch: AgentConnectorUpdateRequest, signal?: AbortSignal) {
    return this.request(`/internal/v1/connectors/${id}`, agentConnectorResponseSchema, {
      method: "PUT",
      body: JSON.stringify(patch),
      signal,
    });
  }

  async pending(projectId: string, context: AgentCanvasContext | undefined, signal?: AbortSignal) {
    const data = await this.request(
      "/internal/v1/canvas-control/pending",
      canvasControlPendingResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ projectId, ...(context ? { context } : {}) }),
        signal,
        timeoutMs: this.pollTimeoutMs,
      },
    );
    return data.commands;
  }

  async recordReceipt(receipt: CanvasControlReceiptRequest, signal?: AbortSignal) {
    const data = await this.request(
      "/internal/v1/canvas-control/receipts",
      canvasControlReceiptResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(receipt),
        signal,
      },
    );
    return data.accepted;
  }

  private async request<T>(
    path: string,
    schema: { parse(value: unknown): { ok: true; data: T } },
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<T> {
    const { timeoutMs, ...rest } = init;
    const controller = new AbortController();
    const abort = () => controller.abort(rest.signal?.reason);
    rest.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("Connector request timed out")),
      timeoutMs ?? 15_000,
    );
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...rest,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          ...(rest.body ? { "Content-Type": "application/json" } : {}),
          ...rest.headers,
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AgentExecutionError(
          "CONNECTOR_RUNTIME_UNAVAILABLE",
          "本机连接服务暂时不可用",
          response.status >= 500 || response.status === 429,
        );
      }
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new AgentExecutionError(
          "CONNECTOR_INVALID_RESPONSE",
          "本机连接服务返回了无法识别的结果",
          true,
        );
      }
      if ((payload as { ok?: unknown })?.ok !== true) {
        throw new AgentExecutionError(
          "CONNECTOR_REQUEST_FAILED",
          "本机连接服务没有完成这次请求",
          false,
        );
      }
      try {
        return schema.parse(payload).data;
      } catch {
        throw new AgentExecutionError(
          "CONNECTOR_INVALID_RESPONSE",
          "本机连接服务返回了无法识别的结果",
          true,
        );
      }
    } catch (cause) {
      if (cause instanceof AgentExecutionError) throw cause;
      throw new AgentExecutionError(
        "CONNECTOR_RUNTIME_UNAVAILABLE",
        "本机连接服务暂时不可用",
        true,
      );
    } finally {
      clearTimeout(timer);
      rest.signal?.removeEventListener("abort", abort);
    }
  }
}
