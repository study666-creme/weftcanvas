import { z } from "zod";

import type { ChatMessage } from "./prompt.js";

const MAX_MODEL_CONTENT_CHARS = 400_000;

const chatCompletionResponseSchema = z.object({
  choices: z.array(z.object({
    message: z.object({
      content: z.union([z.string(), z.null()]).optional(),
    }).optional(),
  })).min(1),
});

export type OpenAICompatibleConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  maxOutputTokens?: number;
  fetchImpl?: typeof fetch;
};

export class OpenAICompatibleError extends Error {
  constructor(
    readonly code: "MODEL_UNAVAILABLE" | "MODEL_INVALID_RESPONSE" | "MODEL_EMPTY_CONTENT",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OpenAICompatibleError";
  }
}

export class OpenAICompatibleClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenAICompatibleConfig) {
    if (!config.apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
    if (!config.model.trim()) throw new Error("OPENAI_MODEL is required");
    this.endpoint = chatCompletionsUrl(config.baseUrl);
    this.timeoutMs = config.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1_000 || this.timeoutMs > 30 * 60_000) {
      throw new Error("OPENAI_TIMEOUT_MS is invalid");
    }
    if (
      config.maxOutputTokens !== undefined
      && (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 16 || config.maxOutputTokens > 16_000)
    ) {
      throw new Error("OPENAI_MAX_OUTPUT_TOKENS is invalid");
    }
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async complete(messages: readonly ChatMessage[], modelId: string, signal?: AbortSignal, reasoningEffort?: string) {
    const selectedModel = modelId.trim();
    if (!selectedModel || selectedModel.length > 128) {
      throw new OpenAICompatibleError("MODEL_UNAVAILABLE", "The selected model is invalid", false);
    }
    const effort = reasoningEffort?.trim();
    if (effort && effort.length > 24) {
      throw new OpenAICompatibleError("MODEL_UNAVAILABLE", "The selected thinking level is invalid", false);
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error("OpenAI-compatible request timed out")), this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: selectedModel,
          messages,
          temperature: 0.4,
          ...(effort ? { reasoning_effort: effort } : {}),
          ...(this.config.maxOutputTokens ? { max_tokens: this.config.maxOutputTokens } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new OpenAICompatibleError(
          "MODEL_UNAVAILABLE",
          "模型服务暂时不可用",
          response.status >= 500 || response.status === 429,
        );
      }

      let parsed: z.infer<typeof chatCompletionResponseSchema>;
      try {
        parsed = chatCompletionResponseSchema.parse(await response.json());
      } catch {
        throw new OpenAICompatibleError("MODEL_INVALID_RESPONSE", "模型返回了无法识别的结果", true);
      }

      const content = parsed.choices[0]?.message?.content?.trim() ?? "";
      if (!content) {
        throw new OpenAICompatibleError("MODEL_EMPTY_CONTENT", "模型没有返回有效内容", true);
      }
      return clampContent(content);
    } catch (cause) {
      if (cause instanceof OpenAICompatibleError) throw cause;
      if (signal?.aborted || controller.signal.aborted) {
        throw new OpenAICompatibleError("MODEL_UNAVAILABLE", "模型请求已取消或超时", true);
      }
      throw new OpenAICompatibleError("MODEL_UNAVAILABLE", "模型服务暂时不可用", true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

export function chatCompletionsUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("OPENAI_BASE_URL must use HTTP or HTTPS");
  }
  let path = url.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    path = "/v1";
  } else if (path.endsWith("/chat/completions")) {
    url.pathname = path;
    url.search = "";
    url.hash = "";
    return url.toString();
  } else if (!path.endsWith("/v1")) {
    path = `${path}/v1`;
  }
  url.pathname = `${path}/chat/completions`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function clampContent(value: string) {
  // 不设人为上限：模型支持多长就返回多长（只防极端内存问题）。
  return value.length <= MAX_MODEL_CONTENT_CHARS ? value : value.slice(0, MAX_MODEL_CONTENT_CHARS);
}
