import { z } from "zod";

const knowledgeResponseSchema = z.object({
  ok: z.literal(true),
  relevant: z.boolean(),
  context: z.string().max(12_000),
  hitCount: z.number().int().nonnegative().max(8),
});

export type AgentKnowledgeRetriever = {
  retrieve: (query: string, signal?: AbortSignal) => Promise<string>;
};

export class HostedKnowledgeClient implements AgentKnowledgeRetriever {
  private readonly endpoint: string;

  constructor(
    endpoint: string,
    private readonly token: string,
    private readonly timeoutMs = 4_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    const url = new URL(endpoint);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("CANVAS_KNOWLEDGE_SERVICE_URL must use HTTPS or local HTTP");
    }
    if (url.username || url.password || url.hash) throw new Error("CANVAS_KNOWLEDGE_SERVICE_URL is invalid");
    if (token.trim().length < 24) throw new Error("CANVAS_KNOWLEDGE_SERVICE_TOKEN is invalid");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 8_000) {
      throw new Error("CANVAS_KNOWLEDGE_TIMEOUT_MS is invalid");
    }
    this.endpoint = url.toString();
  }

  async retrieve(query: string, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: query.trim().slice(0, 6_000),
        creativeMode: inferCreativeMode(query),
        maxHits: 8,
        maxContextChars: 12_000,
      }),
      redirect: "error",
      signal: requestSignal,
    });
    if (!response.ok) throw new Error("Knowledge service rejected the request");
    const result = knowledgeResponseSchema.parse(await response.json());
    return result.relevant ? result.context.trim() : "";
  }
}

export function createKnowledgeRetriever(environment: NodeJS.ProcessEnv = process.env): AgentKnowledgeRetriever | undefined {
  const endpoint = environment.CANVAS_KNOWLEDGE_SERVICE_URL?.trim();
  const token = environment.CANVAS_KNOWLEDGE_SERVICE_TOKEN?.trim();
  if (!endpoint || !token) return undefined;
  return new HostedKnowledgeClient(
    endpoint,
    token,
    readInteger(environment.CANVAS_KNOWLEDGE_TIMEOUT_MS, 4_000, 1_000, 8_000),
  );
}

function inferCreativeMode(query: string) {
  if (/短剧|分集|连载|剧集/.test(query)) return "short_drama" as const;
  if (/微故事|15\s*秒|十五秒|超短片/.test(query)) return "micro_story" as const;
  return "general" as const;
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}
