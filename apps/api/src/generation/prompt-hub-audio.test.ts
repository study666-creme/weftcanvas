import { describe, expect, it } from "vitest";

import type { GenerationQuote } from "@weftcanvas/contracts";

import type { ResolvedGenerationRoute } from "../catalog/execution-route.js";
import {
  MemoryPromptHubGenerationStore,
  PromptHubGenerationService,
  type HostedAudioBilling,
} from "./prompt-hub-service.js";

const NOW = Date.parse("2026-10-30T10:00:00.000Z");
const OWNER_ID = "owner-audio";
const TTS_MODEL = "gemini-3.8-flash-tts";
const SUNO_MODEL = "suno-v6";

const ttsQuote: GenerationQuote = {
  id: "quote-tts-1",
  modelId: TTS_MODEL,
  modelLabel: "Gemini 语音合成 TTS",
  modality: "audio",
  quantity: 1,
  outputCount: 1,
  normalizedParameters: {
    contents: [{ role: "user", parts: [{ text: "你好" }] }],
    speechConfig: "Zephyr",
  },
  creditMicros: 2_000_000,
  credits: "2",
  yuanMicros: 20_000,
  yuan: "0.02",
  estimated: false,
  pricingUnit: "request",
  catalogVersion: "catalog-1",
  capabilityVersion: "capability-1",
  pricingVersion: "pricing-1",
  expiresAt: "2026-10-30T10:05:00.000Z",
};

const sunoQuote: GenerationQuote = {
  ...ttsQuote,
  id: "quote-suno-1",
  modelId: SUNO_MODEL,
  modelLabel: "Suno v6",
  normalizedParameters: { messages: [{ role: "user", content: "upbeat" }] },
};

const ttsRoute = {
  route: {
    sourceModelId: TTS_MODEL,
    modality: "audio",
    endpoint: {
      method: "POST",
      path: `/v1beta/models/${TTS_MODEL}:generateContent`,
      contentType: "application/json",
    },
    audioOutput: { format: "inline-data", sampleRateHz: 24_000, channels: 1 },
    parameters: [
      { name: "model", path: "model", fixed: TTS_MODEL },
      { name: "contents", path: "contents" },
      { name: "responseModalities", path: "generationConfig.responseModalities", fixed: ["AUDIO"] },
      { name: "speechConfig", path: "generationConfig.speechConfig" },
    ],
  },
  pricing: ttsQuote.pricing ?? { mode: "request", unit: "request" },
  catalogVersion: "catalog-1",
  capabilityVersion: "capability-1",
  pricingVersion: "pricing-1",
} as unknown as ResolvedGenerationRoute;

const sunoRoute = {
  ...ttsRoute,
  route: {
    sourceModelId: SUNO_MODEL,
    modality: "audio",
    endpoint: { method: "POST", path: "/v1/chat/completions", contentType: "application/json" },
    audioOutput: { format: "url" },
    parameters: [
      { name: "model", path: "model", fixed: SUNO_MODEL },
      { name: "messages", path: "messages" },
      { name: "n", path: "n", fixed: 1, default: 1 },
    ],
  },
} as unknown as ResolvedGenerationRoute;

function pcmBase64(samples = 4_800) {
  return Buffer.alloc(samples * 2, 7).toString("base64");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function audioService(options: {
  quote: GenerationQuote;
  route: ResolvedGenerationRoute;
  fetch: typeof fetch;
  billing?: HostedAudioBilling;
  withAudio?: boolean;
}) {
  const store = new MemoryPromptHubGenerationStore();
  const billingCalls: Array<Record<string, unknown>> = [];
  const billing: HostedAudioBilling = options.billing ?? {
    async consumeCredit(_token, input) {
      billingCalls.push({ type: "consume", ...input });
      return { balance: 8 };
    },
    async refundCredit(_token, input) {
      billingCalls.push({ type: "refund", ...input });
      return { balance: 10 };
    },
  };
  const persisted: Array<{ jobId: string; index: number; mimeType: string; size: number }> = [];
  const service = new PromptHubGenerationService(
    { createQuote: async () => options.quote },
    { resolveUpstreamAccess: async () => ({ data: { accessToken: "station-token" } }) },
    store,
    {
      apiBaseUrl: "https://prompt-hub.test",
      now: () => NOW,
      fetch: options.fetch,
      media: {
        readReference: async () => {
          throw new Error("audio jobs never read references");
        },
        async persistGenerated(_ownerId, input) {
          persisted.push({
            jobId: input.jobId,
            index: input.index,
            mimeType: input.mimeType,
            size: input.size,
          });
          return {
            id: `media-${input.index}`,
            mimeType: input.mimeType,
            size: input.size,
            durationMs: 4_000,
          } as never;
        },
        async open(_ownerId: string, mediaId: string) {
          return new Response(Buffer.from(`bytes:${mediaId}`), {
            status: 200,
            headers: { "content-type": "audio/wav" },
          }) as never;
        },
      },
      ...(options.withAudio === false
        ? {}
        : {
            audio: { baseUrl: "https://audio-upstream.test", apiKey: "audio-key" },
            routes: { getExecutionRoute: async () => options.route },
            audioBilling: billing,
          }),
    },
  );
  return { service, store, billing, billingCalls: billingCalls, persisted };
}

function submission(quote: GenerationQuote, modality = "audio") {
  return {
    projectId: "project-1",
    nodeId: "node-1",
    modelId: quote.modelId,
    modality,
    parameters: {},
    inputs: {},
    quantity: 1,
    expectedQuote: {
      id: quote.id,
      modelId: quote.modelId,
      creditMicros: quote.creditMicros,
      pricingVersion: quote.pricingVersion,
      expiresAt: quote.expiresAt,
    },
    idempotencyKey: `canvas:audio:${quote.id}`,
  };
}

async function waitForTerminal(
  service: PromptHubGenerationService,
  jobId: string,
): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { data } = await service.get(OWNER_ID, jobId);
    if (data.status === "completed" || data.status === "failed") return data as never;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("audio job did not reach a terminal state");
}

describe("hosted audio generation", () => {
  it("completes a Gemini TTS job from inline PCM and charges the wallet once", async () => {
    const { service, billingCalls, persisted } = audioService({
      quote: ttsQuote,
      route: ttsRoute,
      fetch: (async (input: string | URL | Request) => {
        expect(String(input)).toBe(
          `https://audio-upstream.test/v1beta/models/${TTS_MODEL}:generateContent`,
        );
        return json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/l16; rate=24000; channels=1",
                      data: pcmBase64(),
                    },
                  },
                ],
              },
            },
          ],
        });
      }) as typeof fetch,
    });

    const submitted = await service.submit(OWNER_ID, submission(ttsQuote), "session");
    const job = await waitForTerminal(service, submitted.data.id);

    expect(job).toMatchObject({
      status: "completed",
      progress: 100,
      modality: "audio",
      billing: { chargedCreditMicros: 2_000_000, refunded: false },
    });
    const artifacts = (job as { artifacts: Array<Record<string, unknown>> }).artifacts;
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      kind: "audio",
      mimeType: "audio/wav",
      name: "Gemini 语音合成 TTS-1.wav",
    });
    // 内联 PCM 必须包成 WAV 再进媒体库。
    expect(persisted).toEqual([
      expect.objectContaining({ index: 0, mimeType: "audio/wav", size: 9_644 }),
    ]);
    // 扣一次，refId 稳定且带任务前缀。
    expect(billingCalls).toEqual([
      {
        type: "consume",
        amount: 2,
        reason: "audio_generation",
        refId: `audio-job:${String((job as { id: string }).id)}`,
      },
    ]);
  });

  it("delivers a suno link result as audio media", async () => {
    const { service } = audioService({
      quote: sunoQuote,
      route: sunoRoute,
      fetch: (async (input: string | URL | Request) => {
        if (String(input).endsWith("/v1/chat/completions")) {
          return json({
            choices: [{ message: { audio: { url: "https://cdn.test/song.mp3" } } }],
          });
        }
        return new Response(Buffer.from("mp3-bytes"), {
          status: 200,
          headers: { "content-type": "audio/mpeg" },
        });
      }) as typeof fetch,
    });

    const submitted = await service.submit(OWNER_ID, submission(sunoQuote), "session");
    const job = await waitForTerminal(service, submitted.data.id);

    expect(job).toMatchObject({ status: "completed" });
    const artifacts = (job as { artifacts: Array<Record<string, unknown>> }).artifacts;
    expect(artifacts[0]).toMatchObject({
      kind: "audio",
      mimeType: "audio/mpeg",
      name: "Suno v6-1.mp3",
    });
  });

  it("refunds the wallet and surfaces the upstream message when the provider rejects", async () => {
    const { service, billingCalls } = audioService({
      quote: ttsQuote,
      route: ttsRoute,
      fetch: (async () =>
        json(
          { error: { message: "分组 音频 下模型 gemini-3.8-flash-tts 暂不可用" } },
          503,
        )) as typeof fetch,
    });

    const submitted = await service.submit(OWNER_ID, submission(ttsQuote), "session");
    const job = await waitForTerminal(service, submitted.data.id);

    expect(job).toMatchObject({
      status: "failed",
      billing: { chargedCreditMicros: 2_000_000, refunded: true },
    });
    const error = (job as { error: { code: string; message: string; retryable: boolean } }).error;
    expect(error.code).toBe("AUDIO_PROVIDER_REJECTED");
    expect(error.message).toContain("分组 音频 下模型 gemini-3.8-flash-tts 暂不可用");
    expect(billingCalls.map((call) => call.type)).toEqual(["consume", "refund"]);
    expect(billingCalls[1]).toMatchObject({
      amount: 2,
      reason: "audio_generation_refund",
      refId: billingCalls[0]!.refId,
    });
  });

  it("rejects audio explicitly when the audio upstream is not configured", async () => {
    const { service, billingCalls } = audioService({
      quote: ttsQuote,
      route: ttsRoute,
      fetch: (async () => json({})) as typeof fetch,
      withAudio: false,
    });

    await expect(service.submit(OWNER_ID, submission(ttsQuote), "session")).rejects.toMatchObject({
      code: "AUDIO_UPSTREAM_UNAVAILABLE",
      message: "音频上游暂未配置，请联系管理员",
    });
    expect(billingCalls).toEqual([]);
  });
});
