import { describe, expect, it } from "vitest";

import type { PrivateModelRoute } from "../catalog/execution-route.js";
import {
  KachangGenerationProvider,
  type GenerationReferenceResolver,
} from "./kachang-provider.js";
import {
  stagedGenerationResultSchema,
  type GenerationResultStagingStore,
  type StagedGenerationRecord,
  type StagedGenerationResult,
} from "./result-staging.js";
import type { ProviderGenerationRequest } from "./types.js";

describe("Kachang generation provider", () => {
  it("submits private text routes and stages text plus usage", async () => {
    const network = scriptedFetch([jsonResponse({
      choices: [{ message: { content: [{ type: "text", text: "第一段" }, { type: "text", text: "第二段" }] } }],
      usage: { prompt_tokens: 120, completion_tokens: 45 },
    })]);
    const staging = new MemoryStagingStore();
    const provider = createProvider(network.fetch, staging);
    const result = await provider.submit(request(textRoute(), "text", {
      messages: [{ role: "user", content: "改写这段文字" }],
      stream: false,
    }));

    expect(result).toMatchObject({ kind: "output" });
    expect(await stagedResult(staging, result)).toEqual({
      kind: "text",
      text: "第一段第二段",
      usage: { inputTokens: 120, outputTokens: 45 },
    });
    expect(network.calls[0]?.url).toBe("http://127.0.0.1/v1/chat/completions");
    expect(network.calls[0]?.headers.get("authorization")).toBe("Bearer server-secret");
    expect(network.calls[0]?.redirect).toBe("manual");
    expect(network.calls[0]?.body).toMatchObject({
      model: "private-text-route",
      messages: [{ role: "user", content: "改写这段文字" }],
      stream: false,
    });
    expect(JSON.stringify(network.calls[0]?.body)).not.toContain("creative-text");
  });

  it("binds multiple image references and stages URL and base64 results", async () => {
    const network = scriptedFetch([jsonResponse({
      data: [
        { url: "https://media.example/result.png", revised_prompt: "revised" },
        { b64_json: "aW1hZ2U=" },
      ],
    })]);
    const staging = new MemoryStagingStore();
    const references = new MapReferenceResolver({
      "media-1": "https://media.example/reference-1.png",
      "media-2": "https://media.example/reference-2.png",
    });
    const provider = createProvider(network.fetch, staging, references);
    const result = await provider.submit({
      ...request(imageRoute(), "image", { prompt: "雨夜街道", size: "16:9" }),
      inputs: { images: ["media-1", "media-2"], videos: [], audios: [] },
    });

    expect(await stagedResult(staging, result)).toEqual({
      kind: "image",
      items: [
        { source: "url", url: "https://media.example/result.png", revisedPrompt: "revised" },
        { source: "base64", data: "aW1hZ2U=", mimeType: "image/png" },
      ],
    });
    expect(network.calls[0]?.body).toMatchObject({
      model: "private-image-route",
      prompt: "雨夜街道",
      size: "16:9",
      images: ["https://media.example/reference-1.png", "https://media.example/reference-2.png"],
    });
    expect(network.calls[0]?.body).not.toHaveProperty("image");
    expect(references.calls).toHaveLength(2);
  });

  it("resolves relative image result URLs against the configured provider origin", async () => {
    const staging = new MemoryStagingStore();
    const provider = createProvider(scriptedFetch([jsonResponse({ data: [{ url: "/files/result.png" }] })]).fetch, staging);
    const result = await provider.submit(request(imageRoute(), "image", { prompt: "test" }));

    expect(await stagedResult(staging, result)).toEqual({
      kind: "image",
      items: [{ source: "url", url: "http://127.0.0.1/files/result.png" }],
    });
  });

  it("submits and resumes a Midjourney image task with five ordered results", async () => {
    const network = scriptedFetch([
      jsonResponse({ data: { task_id: "task-public", status: "pending", progress: "0%" } }),
      jsonResponse({ data: { task_id: "task-public", status: "processing", progress: "52%" } }),
      jsonResponse({
        data: {
          task_id: "task-public",
          status: "completed",
          progress: "100%",
          result: {
            data: {
              grid_image_url: "https://media.example/grid.png",
              image_urls: [
                "https://media.example/1.png",
                "https://media.example/2.png",
                "https://media.example/3.png",
                "https://media.example/4.png",
              ],
            },
          },
        },
      }),
    ]);
    const staging = new MemoryStagingStore();
    const provider = createProvider(network.fetch, staging, new MapReferenceResolver({
      reference: "https://media.example/reference.png",
    }));
    const job = {
      ...request(midjourneyRoute(), "image", {
        prompt: "cinematic city",
        size: "16:9",
        quality: "2k",
        stylize: 0,
        chaos: 0,
        weird: 0,
      }),
      inputs: { images: ["reference"], styleImages: [], elementImages: [], videos: [], audios: [] },
    };

    expect(await provider.submit(job)).toEqual({ kind: "queued", taskId: "task-public", progress: 0 });
    expect(await provider.poll("task-public", job)).toEqual({ kind: "running", taskId: "task-public", progress: 52 });
    const completed = await provider.poll("task-public", job);

    expect(await stagedResult(staging, completed)).toEqual({
      kind: "image",
      items: ["grid", "1", "2", "3", "4"].map((name) => ({
        source: "url",
        url: `https://media.example/${name}.png`,
      })),
    });
    expect(network.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /v1/midjourney/generations",
      "GET /v1/tasks/task-public",
      "GET /v1/tasks/task-public",
    ]);
    expect(network.calls[0]?.body).toMatchObject({
      model: "mj-v8.1",
      speed: "relax",
      n: 1,
      image_urls: ["https://media.example/reference.png"],
    });
  });

  it("keeps polling when a Midjourney task completes before its gallery is visible", async () => {
    const provider = createProvider(
      scriptedFetch([jsonResponse({ data: { task_id: "task-public", status: "completed", progress: "100%" } })]).fetch,
      new MemoryStagingStore(),
    );
    await expect(provider.poll("task-public", request(midjourneyRoute(), "image", { prompt: "test" })))
      .rejects.toMatchObject({ code: "IMAGE_RESULT_PENDING", outcome: "transient" });
  });

  it("binds frame, style, and element image slots by route path without model-specific rules", async () => {
    const network = scriptedFetch([jsonResponse({ id: "task-1", status: "queued" })]);
    const provider = createProvider(network.fetch, new MemoryStagingStore(), new MapReferenceResolver({
      frame: "https://media.example/frame.png",
      style: "https://media.example/style.png",
      element: "https://media.example/element.png",
    }));
    const route: PrivateModelRoute = {
      sourceModelId: "private-reference-video",
      modality: "video",
      endpoint: { method: "POST", path: "/v1/videos", contentType: "application/json" },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-reference-video" },
        { name: "prompt", path: "prompt", type: "string" },
        { name: "referenceImages", path: "images", type: "array", itemsFormat: "uri-or-data-image" },
        { name: "referenceImages", path: "style_references", type: "array", itemsFormat: "uri-or-data-image" },
        { name: "referenceImages", path: "element_references", type: "array", itemsFormat: "uri-or-data-image" },
      ],
    };
    await provider.submit({
      ...request(route, "video", { prompt: "test" }),
      inputs: { images: ["frame"], styleImages: ["style"], elementImages: ["element"], videos: [], audios: [] },
    });

    expect(network.calls[0]?.body).toMatchObject({
      version: "video.v1",
      model: "public-video",
      operation: "image_to_video",
      media_inputs: [
        { kind: "image", role: "reference", url: "https://media.example/frame.png" },
        { kind: "image", role: "style_reference", url: "https://media.example/style.png" },
        { kind: "image", role: "element_reference", url: "https://media.example/element.png" },
      ],
      options: { async: true, n: 1 },
    });
  });

  it.each([
    ["sd2.0-480p", "referenceImages"],
    ["sd2.0-720p", "reference_images"],
  ])("binds every %s image to its all-purpose reference array", async (modelId, referencePath) => {
    const network = scriptedFetch([jsonResponse({ id: "task-1", status: "queued" })]);
    const provider = createProvider(network.fetch, new MemoryStagingStore(), new MapReferenceResolver({
      first: "https://media.example/first.png",
      second: "https://media.example/second.png",
      third: "https://media.example/third.png",
    }));
    const route = allPurposeReferenceVideoRoute(modelId, referencePath);

    await provider.submit({
      ...request(route, "video", { prompt: "keep all references" }),
      inputs: {
        images: ["first", "second", "third"],
        styleImages: [],
        elementImages: [],
        videos: [],
        audios: [],
      },
    });

    expect(network.calls[0]?.body?.media_inputs).toEqual([
      { kind: "image", role: "reference", url: "https://media.example/first.png" },
      { kind: "image", role: "reference", url: "https://media.example/second.png" },
      { kind: "image", role: "reference", url: "https://media.example/third.png" },
    ]);
    expect(network.calls[0]?.body).not.toHaveProperty("first_image");
    expect(network.calls[0]?.body).not.toHaveProperty("last_image");
  });

  it("keeps pure first-last-frame routes on their two-frame contract", async () => {
    const network = scriptedFetch([jsonResponse({ id: "task-1", status: "queued" })]);
    const provider = createProvider(network.fetch, new MemoryStagingStore(), new MapReferenceResolver({
      first: "https://media.example/first.png",
      last: "https://media.example/last.png",
    }));
    const route = firstLastFrameVideoRoute();

    await provider.submit({
      ...request(route, "video", { prompt: "interpolate these frames" }),
      inputs: {
        images: ["first", "last"],
        styleImages: [],
        elementImages: [],
        videos: [],
        audios: [],
      },
    });

    expect(network.calls[0]?.body).toMatchObject({
      version: "video.v1",
      operation: "image_to_video",
      media_inputs: [
        { kind: "image", role: "first_frame", url: "https://media.example/first.png" },
        { kind: "image", role: "last_frame", url: "https://media.example/last.png" },
      ],
    });
  });

  it("binds a singular reference video parameter as a URL", async () => {
    const network = scriptedFetch([jsonResponse({ id: "task-1", status: "queued" })]);
    const provider = createProvider(network.fetch, new MemoryStagingStore(), new MapReferenceResolver({
      source: "https://media.example/source.mp4",
    }));
    const route: PrivateModelRoute = {
      sourceModelId: "private-reference-video",
      modality: "video",
      endpoint: { method: "POST", path: "/v1/videos", contentType: "application/json" },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-reference-video" },
        { name: "prompt", path: "prompt", type: "string" },
        { name: "referenceVideos", path: "input_video", type: "string", format: "uri-or-data-video" },
      ],
    };
    await provider.submit({
      ...request(route, "video", { prompt: "test" }),
      inputs: { images: [], styleImages: [], elementImages: [], videos: ["source"], audios: [] },
    });

    expect(network.calls[0]?.body).toMatchObject({
      version: "video.v1",
      operation: "video_to_video",
      media_inputs: [{ kind: "video", role: "source_video", url: "https://media.example/source.mp4" }],
    });
  });

  it("submits and resumes a canonical asynchronous video task", async () => {
    const network = scriptedFetch([
      jsonResponse({ id: "task-1", status: "queued", progress: 2 }),
      jsonResponse({ id: "task-1", status: "in_progress", progress: 46 }),
      jsonResponse({ id: "task-1", status: "completed", progress: 100, content: { video_url: "https://media.example/result.mp4" } }),
    ]);
    const staging = new MemoryStagingStore();
    const provider = createProvider(network.fetch, staging);
    const job = request(videoRoute(), "video", { prompt: "人物转身", duration: 6, aspect_ratio: "16:9" });

    expect(await provider.submit(job)).toEqual({ kind: "queued", taskId: "task-1", progress: 2 });
    expect(await provider.poll("task-1", job)).toEqual({ kind: "running", taskId: "task-1", progress: 46 });
    const completed = await provider.poll("task-1", job);

    expect(await stagedResult(staging, completed)).toEqual({
      kind: "video",
      taskId: "task-1",
      url: "https://media.example/result.mp4",
    });
    expect(network.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /v1/videos",
      "GET /v1/videos/task-1",
      "GET /v1/videos/task-1",
    ]);
  });

  it("submits the fixed-resolution nine-image route with duration, ratio, and resolution", async () => {
    const network = scriptedFetch([jsonResponse({ id: "task-nine", status: "queued", progress: 0 })]);
    const provider = createProvider(network.fetch, new MemoryStagingStore(), new MapReferenceResolver({
      reference: "https://media.example/reference.png",
    }));
    const route: PrivateModelRoute = {
      sourceModelId: "S-2.0-9图版",
      modality: "video",
      endpoint: { method: "POST", path: "/v1/videos", contentType: "application/json" },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "S-2.0-9图版" },
        { name: "prompt", path: "prompt", type: "string" },
        { name: "duration_seconds", path: "duration_seconds", type: "integer" },
        { name: "aspect_ratio", path: "aspect_ratio", type: "string" },
        { name: "resolution", path: "resolution", type: "string", fixed: "720p" },
        { name: "images", path: "images", type: "array", itemsFormat: "public-http-url" },
        { name: "n", path: "n", type: "integer", fixed: 1 },
      ],
    };

    await expect(provider.submit({
      ...request(route, "video", {
        prompt: "人物自然转身",
        duration_seconds: 15,
        aspect_ratio: "9:16",
        resolution: "720p",
      }),
      modelId: "S-2.0-9图版",
      inputs: { images: ["reference"], styleImages: [], elementImages: [], videos: [], audios: [] },
    })).resolves.toEqual({ kind: "queued", taskId: "task-nine", progress: 0 });

    expect(network.calls[0]?.body).toEqual({
      version: "video.v1",
      model: "S-2.0-9图版",
      operation: "image_to_video",
      prompt: "人物自然转身",
      duration_seconds: 15,
      aspect_ratio: "9:16",
      resolution: "720p",
      media_inputs: [{ kind: "image", role: "reference", url: "https://media.example/reference.png" }],
      options: { async: true, n: 1 },
    });
  });

  it("submits image2-A once through the async task API and stages its polled image", async () => {
    const network = scriptedFetch([
      jsonResponse({ id: "image-task-1", status: "queued", progress: 3 }),
      jsonResponse({ id: "image-task-1", status: "running", progress: 48 }),
      jsonResponse({ id: "image-task-1", status: "completed", url: "https://media.example/image2-a.png" }),
    ]);
    const staging = new MemoryStagingStore();
    const provider = createProvider(network.fetch, staging);
    const job = request(image2ARoute(), "image", {
      prompt: "product photo",
      resolution: "4k",
      quality: "high",
      n: 1,
    });

    expect(await provider.submit(job)).toEqual({
      kind: "queued",
      taskId: "image-videos:image-task-1",
      progress: 3,
    });
    expect(await provider.poll("image-videos:image-task-1", job)).toEqual({
      kind: "running",
      taskId: "image-videos:image-task-1",
      progress: 48,
    });
    const completed = await provider.poll("image-videos:image-task-1", job);

    expect(await stagedResult(staging, completed)).toEqual({
      kind: "image",
      items: [{ source: "url", url: "https://media.example/image2-a.png" }],
    });
    expect(network.calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "POST /v1/videos",
      "GET /v1/videos/image-task-1",
      "GET /v1/videos/image-task-1",
    ]);
    expect(network.calls[0]?.body).toMatchObject({
      model: "image2-A",
      prompt: "product photo",
      resolution: "4k",
      quality: "high",
      n: 1,
    });
  });

  it("resolves relative video result URLs against the configured provider origin", async () => {
    const staging = new MemoryStagingStore();
    const provider = createProvider(scriptedFetch([
      jsonResponse({ id: "task-1", status: "completed", content: { video_url: "/files/result.mp4" } }),
    ]).fetch, staging);
    const result = await provider.submit(request(videoRoute(), "video", { prompt: "test" }));

    expect(await stagedResult(staging, result)).toEqual({
      kind: "video",
      taskId: "task-1",
      url: "http://127.0.0.1/files/result.mp4",
    });
  });

  it("keeps polling when completion is visible before its video URL", async () => {
    const provider = createProvider(
      scriptedFetch([jsonResponse({ id: "task-1", status: "completed", progress: 100 })]).fetch,
      new MemoryStagingStore(),
    );
    await expect(provider.poll("task-1", request(videoRoute(), "video", { prompt: "test" })))
      .rejects.toMatchObject({ code: "VIDEO_RESULT_PENDING", outcome: "transient" });
  });

  it("classifies definitive rejection, ambiguous submission, and transient polling failures", async () => {
    const rejectedProvider = createProvider(scriptedFetch([jsonResponse({ error: {} }, 400)]).fetch, new MemoryStagingStore());
    await expect(rejectedProvider.submit(request(imageRoute(), "image", { prompt: "test" }))).rejects.toMatchObject({
      code: "GENERATION_REQUEST_FAILED",
      outcome: "rejected",
    });

    const uncertainProvider = createProvider(scriptedFetch([jsonResponse({ error: {} }, 503)]).fetch, new MemoryStagingStore());
    await expect(uncertainProvider.submit(request(imageRoute(), "image", { prompt: "test" }))).rejects.toMatchObject({
      outcome: "unknown",
    });

    const disconnectedProvider = createProvider(scriptedFetch([new Error("socket closed")]).fetch, new MemoryStagingStore());
    await expect(disconnectedProvider.submit(request(imageRoute(), "image", { prompt: "test" }))).rejects.toMatchObject({
      code: "GENERATION_SUBMISSION_UNCONFIRMED",
      outcome: "unknown",
    });

    const pollingProvider = createProvider(scriptedFetch([jsonResponse({ error: {} }, 503)]).fetch, new MemoryStagingStore());
    await expect(pollingProvider.poll("task-1", request(videoRoute(), "video", { prompt: "test" }))).rejects.toMatchObject({
      code: "GENERATION_REQUEST_FAILED",
      outcome: "transient",
    });
  });

  it("rejects unreviewed routes, streaming, and unsupported batch execution before fetch", async () => {
    const network = scriptedFetch([]);
    const provider = createProvider(network.fetch, new MemoryStagingStore());
    const route = imageRoute();
    route.endpoint.path = "/internal/admin";

    await expect(provider.submit(request(route, "image", { prompt: "test" }))).rejects.toMatchObject({ code: "EXECUTION_ROUTE_INVALID" });
    await expect(provider.submit(request(textRoute(), "text", { messages: [], stream: true }))).rejects.toMatchObject({ code: "STREAMING_UNAVAILABLE" });
    await expect(provider.submit({ ...request(imageRoute(), "image", { prompt: "test" }), quantity: 2 })).rejects.toMatchObject({ code: "BATCH_GENERATION_UNAVAILABLE" });
    expect(network.calls).toHaveLength(0);
  });

  it("rejects audio submissions explicitly without fabricating a provider request", async () => {
    const network = scriptedFetch([]);
    const provider = createProvider(network.fetch, new MemoryStagingStore());
    const route: PrivateModelRoute = {
      sourceModelId: "private-audio-route",
      modality: "audio",
      endpoint: { method: "POST", path: "/v1/audio/generations", contentType: "application/json" },
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-audio-route" },
        { name: "prompt", path: "prompt", type: "string" },
      ],
    };
    await expect(provider.submit(request(route, "audio", { prompt: "生成一段音乐" }))).rejects.toMatchObject({
      code: "MODEL_MODALITY_UNAVAILABLE",
      message: "当前音频模型暂不支持生成",
      outcome: "rejected",
    });
    await expect(provider.poll("task-1", request(route, "audio", { prompt: "生成一段音乐" }))).rejects.toMatchObject({
      code: "TASK_POLLING_UNAVAILABLE",
      outcome: "rejected",
    });
    expect(network.calls).toHaveLength(0);
  });
});

describe("video failure parsing", () => {
  it.each([
    ["plain string", { id: "task-1", status: "failed", error: "触发内容审核，请调整提示词" }, "VIDEO_GENERATION_CONTENT_REJECTED", "触发内容审核，请调整提示词"],
    ["code and message", { id: "task-1", status: "failed", error: { code: "429", message: "请求过于频繁" } }, "VIDEO_GENERATION_RATE_LIMITED", "请求过于频繁"],
    ["nested error object", { id: "task-1", status: "failed", error: { error: { message: "账户余额不足，请充值" } } }, "VIDEO_GENERATION_BALANCE_EXHAUSTED", "账户余额不足，请充值"],
    ["deep data error", { id: "task-1", status: "failed", data: { error: { message: "生成超时，请稍后重试" } } }, "VIDEO_GENERATION_TIMED_OUT", "生成超时，请稍后重试"],
    ["empty error", { id: "task-1", status: "failed", error: {} }, "VIDEO_GENERATION_FAILED", "视频生成失败"],
    ["null error", { id: "task-1", status: "failed", error: null }, "VIDEO_GENERATION_FAILED", "视频生成失败"],
  ])("classifies a %s failure response into a stable product message", async (_label, body, code, message) => {
    const provider = createProvider(scriptedFetch([jsonResponse(body)]).fetch, new MemoryStagingStore());

    const state = await provider.submit(request(videoRoute(), "video", { prompt: "test" }));

    expect(state).toEqual({ kind: "failed", code, message, retryable: false });
  });

  it("redacts credentials, signed URLs, and private links from the upstream reason", async () => {
    const provider = createProvider(scriptedFetch([jsonResponse({
      id: "task-1",
      status: "failed",
      error: {
        message: "请查看 https://newapi.prompt-hubs.com/private/tasks/task-1?token=abc123\nBearer server-secret-here 处理进度，账户余额不足",
      },
    })]).fetch, new MemoryStagingStore());

    const state = await provider.submit(request(videoRoute(), "video", { prompt: "test" }));

    expect(state).toMatchObject({ code: "VIDEO_GENERATION_BALANCE_EXHAUSTED", retryable: false });
    expect(state.message).not.toContain("https://");
    expect(state.message).not.toContain("abc123");
    expect(state.message).not.toContain("server-secret-here");
    expect(state.message).toContain("余额不足");
  });

  it("keeps a stable message for an invalid JSON success response", async () => {
    const provider = createProvider(scriptedFetch([
      new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }),
    ]).fetch, new MemoryStagingStore());

    await expect(provider.submit(request(videoRoute(), "video", { prompt: "test" })))
      .rejects.toMatchObject({ code: "GENERATION_RESPONSE_INVALID", message: "生成服务返回格式异常" });
  });

  it("extracts a sanitized specific reason from an HTTP error body while keeping a stable code", async () => {
    const provider = createProvider(scriptedFetch([jsonResponse({
      error: { code: "4007", message: "当前模型暂不可用，请稍后再试" },
    }, 400)]).fetch, new MemoryStagingStore());

    await expect(provider.submit(request(videoRoute(), "video", { prompt: "test" })))
      .rejects.toMatchObject({
        code: "GENERATION_REQUEST_FAILED",
        outcome: "rejected",
        message: "当前模型暂不可用，请稍后再试",
      });
  });

  it("never leaks a private URL, query token, or Bearer secret from an HTTP 400 body", async () => {
    const provider = createProvider(scriptedFetch([jsonResponse({
      error: {
        message: "请查看 https://newapi.prompt-hubs.com/private/tasks/task-1?token=super-secret-token 处理进度\nBearer server-secret-here 账户余额不足",
      },
    }, 400)]).fetch, new MemoryStagingStore());

    const error = await provider.submit(request(videoRoute(), "video", { prompt: "test" }))
      .catch((cause) => cause as Error);

    expect(error).toMatchObject({ code: "GENERATION_REQUEST_FAILED", outcome: "rejected" });
    expect(error.message).not.toContain("https://");
    expect(error.message).not.toContain("super-secret-token");
    expect(error.message).not.toContain("server-secret-here");
    expect(error.message).toContain("余额不足");
  });

  it("falls back to a bounded product message when the HTTP body is not usable", async () => {
    const provider = createProvider(scriptedFetch([
      new Response("gateway hiccup", { status: 502, headers: { "Content-Type": "text/plain" } }),
    ]).fetch, new MemoryStagingStore());

    await expect(provider.submit(request(videoRoute(), "video", { prompt: "test" })))
      .rejects.toMatchObject({
        code: "GENERATION_REQUEST_FAILED",
        outcome: "unknown",
        message: "生成服务暂时不可用",
      });
  });

  it("uses the status-specific fallback when a 4xx error body has no usable message", async () => {
    const provider = createProvider(scriptedFetch([jsonResponse({
      error: { code: "4007" },
    }, 400)]).fetch, new MemoryStagingStore());

    await expect(provider.submit(request(videoRoute(), "video", { prompt: "test" })))
      .rejects.toMatchObject({
        code: "GENERATION_REQUEST_FAILED",
        outcome: "rejected",
        message: "当前参数无法提交",
      });
  });
});

function createProvider(
  fetcher: typeof fetch,
  staging: GenerationResultStagingStore,
  references: GenerationReferenceResolver = new MapReferenceResolver({}),
) {
  return new KachangGenerationProvider({
    baseUrl: "http://127.0.0.1",
    apiKey: "server-secret",
    staging,
    references,
    fetch: fetcher,
    allowInsecureHttp: true,
  });
}

function request(
  executionRoute: PrivateModelRoute,
  modality: ProviderGenerationRequest["modality"],
  parameters: Record<string, unknown>,
): ProviderGenerationRequest {
  return {
    jobId: "job-1",
    ownerId: "user-1",
    modelId: `public-${modality}`,
    modality,
    parameters,
    inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
    quantity: 1,
    executionRoute,
  };
}

function textRoute(): PrivateModelRoute {
  return {
    sourceModelId: "private-text-route",
    modality: "text",
    endpoint: { method: "POST", path: "/v1/chat/completions", contentType: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "private-text-route" },
      { name: "messages", path: "messages", type: "array" },
      { name: "stream", path: "stream", type: "boolean" },
    ],
  };
}

function imageRoute(): PrivateModelRoute {
  return {
    sourceModelId: "private-image-route",
    modality: "image",
    endpoint: { method: "POST", path: "/v1/images/generations", contentType: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "private-image-route" },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "size", path: "size", type: "string" },
      { name: "image", path: "image", type: "string", format: "uri-or-data-image" },
      { name: "images", path: "images", type: "array", itemsFormat: "uri-or-data-image" },
    ],
  };
}

function image2ARoute(): PrivateModelRoute {
  return {
    sourceModelId: "image2-A",
    modality: "image",
    endpoint: { method: "POST", path: "/v1/images/generations", contentType: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "image2-A" },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "resolution", path: "resolution", type: "string" },
      { name: "quality", path: "quality", type: "string" },
      { name: "n", path: "n", type: "integer", fixed: 1 },
    ],
  };
}

function midjourneyRoute(): PrivateModelRoute {
  return {
    sourceModelId: "mj-v8.1",
    modality: "image",
    endpoint: { method: "POST", path: "/v1/midjourney/generations", contentType: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "mj-v8.1" },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "size", path: "size", type: "string" },
      { name: "quality", path: "quality", type: "string" },
      { name: "image_urls", path: "image_urls", type: "array", itemsFormat: "public-http-url" },
      { name: "stylize", path: "stylize", type: "integer" },
      { name: "chaos", path: "chaos", type: "integer" },
      { name: "weird", path: "weird", type: "integer" },
      { name: "speed", path: "speed", type: "string", fixed: "relax" },
      { name: "n", path: "n", type: "integer", fixed: 1 },
    ],
  };
}

function videoRoute(): PrivateModelRoute {
  return {
    sourceModelId: "private-video-route",
    modality: "video",
    endpoint: { method: "POST", path: "/v1/videos", contentType: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "private-video-route" },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "duration", path: "duration", type: "integer" },
      { name: "aspect_ratio", path: "aspect_ratio", type: "string" },
    ],
  };
}

function allPurposeReferenceVideoRoute(modelId: string, referencePath: string): PrivateModelRoute {
  return {
    sourceModelId: modelId,
    modality: "video",
    endpoint: { method: "POST", path: "/v1/videos", contentType: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", fixed: modelId },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "referenceImages", path: referencePath, type: "array", itemsFormat: "uri-or-data-image" },
      { name: "first_image", path: "first_image", type: "string", format: "uri-or-data-image" },
      { name: "last_image", path: "last_image", type: "string", format: "uri-or-data-image" },
    ],
  };
}

function firstLastFrameVideoRoute(): PrivateModelRoute {
  return {
    sourceModelId: "first-last-video",
    modality: "video",
    endpoint: { method: "POST", path: "/v1/videos", contentType: "application/json" },
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "first-last-video" },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "first_image", path: "first_image", type: "string", format: "uri-or-data-image" },
      { name: "last_image", path: "last_image", type: "string", format: "uri-or-data-image" },
    ],
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function scriptedFetch(responses: Array<Response | Error>) {
  const calls: Array<{
    url: string;
    method: string;
    headers: Headers;
    redirect: RequestRedirect | undefined;
    body: Record<string, unknown> | null;
  }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      redirect: init?.redirect,
      body,
    });
    const response = responses.shift();
    if (!response) throw new Error("No scripted response");
    if (response instanceof Error) throw response;
    return response;
  };
  return { fetch: fetcher, calls };
}

class MemoryStagingStore implements GenerationResultStagingStore {
  private readonly records = new Map<string, StagedGenerationRecord>();
  private sequence = 0;

  async write(jobId: string, value: StagedGenerationResult) {
    const id = `result_${String(++this.sequence).padStart(4, "0")}`;
    const reference = `generation-result:${id}`;
    this.records.set(reference, {
      version: 1,
      id,
      jobId,
      result: stagedGenerationResultSchema.parse(value),
      createdAt: "2026-07-15T10:00:00.000Z",
    });
    return reference;
  }

  async read(reference: string) {
    const record = this.records.get(reference);
    if (!record) throw new Error("missing staged result");
    return structuredClone(record);
  }

  async remove(reference: string) {
    this.records.delete(reference);
  }
}

class MapReferenceResolver implements GenerationReferenceResolver {
  readonly calls: Array<{ ownerId: string; mediaId: string; kind: "image" | "video" | "audio"; format?: string }> = [];

  constructor(private readonly values: Record<string, string>) {}

  async resolve(input: { ownerId: string; mediaId: string; kind: "image" | "video" | "audio"; format?: string }) {
    this.calls.push(input);
    const value = this.values[input.mediaId];
    if (!value) throw new Error(`Missing media ${input.mediaId}`);
    return value;
  }
}

async function stagedResult(staging: GenerationResultStagingStore, state: { kind: string; resultRef?: string }) {
  if (state.kind !== "output" || !state.resultRef) throw new Error("expected staged output");
  return (await staging.read(state.resultRef)).result;
}
