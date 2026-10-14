import type {
  CustomApiCatalogSource,
  GenerationJobInput,
  PublicModel,
} from "@weftcanvas/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyProtocolOverride,
  buildProtocolRequestBody,
  createSyntheticCustomModel,
  createSyntheticCustomRoute,
  buildImageRequestPayload,
  customApiAuthInit,
  executeCustomGeneration,
  fetchCustomApiModelIdsForFormat,
  normalizeProtocolOverride,
  probeCustomApiResponse,
  sendCustomApiTestRequest,
  testCustomApiConnection,
  type CustomApiRoute,
} from "./custom-api";

vi.mock("./media-store", () => ({
  storeMedia: vi.fn(async (file: File, kind: "image" | "video" | "audio") => ({
    id: `media-${kind}`,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    source: "local" as const,
    serverId: null,
    width: null,
    height: null,
    durationMs: null,
  })),
}));

describe("custom API media binding", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    { kind: "image", input: "images", name: "reference_image_urls", type: "array", count: 2 },
    { kind: "image", input: "images", name: "refImageUrl", type: "string", count: 1 },
    { kind: "image", input: "images", name: "image_url", type: "string", count: 1 },
    { kind: "video", input: "videos", name: "ref_video_urls", type: "array", count: 2 },
    { kind: "video", input: "videos", name: "referenceVideoUrl", type: "string", count: 1 },
    { kind: "video", input: "videos", name: "video_urls", type: "array", count: 2 },
    { kind: "audio", input: "audios", name: "reference_audio_urls", type: "array", count: 2 },
    { kind: "audio", input: "audios", name: "refAudioUrl", type: "string", count: 1 },
    { kind: "audio", input: "audios", name: "audio_url", type: "string", count: 1 },
  ] as const)(
    "binds $kind values to custom route alias $name",
    async ({ input, name, type, count }) => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "done" } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const values = Array.from(
        { length: count },
        (_, index) => `https://media.example/${input}-${index + 1}`,
      );
      const inputs: GenerationJobInput = {
        images: [],
        styleImages: [],
        elementImages: [],
        videos: [],
        audios: [],
        [input]: values,
      };

      await executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model: textModel(),
        route: routeWithMediaParameter(name, type),
        parameters: { messages: [{ role: "user", content: "test" }] },
        inputs,
      });

      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({
        upstream: { references: type === "array" ? values : values[0] },
      });
    },
  );

  it("binds first/last frames plus bare video and audio parameters", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "done" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const route = baseRoute();
    route.parameters.push(
      { name: "start_frame_url", path: "frames.first", type: "string" },
      { name: "endFrameImageUrl", path: "frames.last", type: "string" },
      { name: "videos", path: "media.videos", type: "array" },
      { name: "audio", path: "media.audio", type: "string" },
    );

    await executeCustomGeneration({
      connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
      model: textModel(),
      route,
      parameters: { messages: [{ role: "user", content: "test" }] },
      inputs: {
        images: ["https://media.example/image-1", "https://media.example/image-2"],
        styleImages: [],
        elementImages: [],
        videos: ["https://media.example/video-1", "https://media.example/video-2"],
        audios: ["https://media.example/audio-1"],
      },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      frames: {
        first: "https://media.example/image-1",
        last: "https://media.example/image-2",
      },
      media: {
        videos: ["https://media.example/video-1", "https://media.example/video-2"],
        audio: "https://media.example/audio-1",
      },
    });
  });

  it("binds semantic image roles from the catalog path even when the parameter name is generic", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "done" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const route = baseRoute();
    route.parameters.push({
      name: "referenceImages",
      path: "style_references",
      type: "array",
      itemsFormat: "uri-or-data-image",
    });
    route.parameters.push({
      name: "styleImages",
      path: "images",
      type: "array",
      itemsFormat: "uri-or-data-image",
    });
    const model = textModel();
    model.input.referenceMedia = {
      images: { min: 0, max: 1, multiple: false },
      styleImages: { min: 0, max: 4, multiple: true },
      maxTotalItems: 4,
    };

    await executeCustomGeneration({
      connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
      model,
      route,
      parameters: { messages: [{ role: "user", content: "test" }] },
      inputs: {
        images: ["data:image/png;base64,ZnJhbWU="],
        styleImages: ["data:image/png;base64,c3R5bGU="],
        elementImages: [],
        videos: [],
        audios: [],
      },
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toMatchObject({
      images: ["data:image/png;base64,ZnJhbWU="],
      style_references: ["data:image/png;base64,c3R5bGU="],
    });
    expect(JSON.parse(String(request.body))).not.toHaveProperty("referenceImages");
    expect(JSON.parse(String(request.body))).not.toHaveProperty("styleImages");
  });

  it("projects image.v1 intent back to the legacy image endpoint once", async () => {
    const model = imageProtocolModel();
    const payload = buildImageRequestPayload(
      model.id,
      imageProtocolRoute(),
      { prompt: "product photo", resolution: "1k", aspect_ratio: "16:9", quality: "standard" },
      {
        images: ["https://media.example/reference.png"],
        styleImages: [],
        elementImages: [],
        videos: [],
        audios: [],
      },
    );
    expect(payload).toEqual({
      model: "source-image-model",
      prompt: "product photo",
      resolution: "1k",
      size: "16:9",
      quality: "standard",
      images: ["https://media.example/reference.png"],
    });
  });
});

describe("custom API connection", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reads the catalog once while verifying the API key in parallel", async () => {
    let resolveCatalog!: (response: Response) => void;
    let resolveKey!: (response: Response) => void;
    const catalogResponse = new Promise<Response>((resolve) => {
      resolveCatalog = resolve;
    });
    const keyResponse = new Promise<Response>((resolve) => {
      resolveKey = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      return pathname === "/api/model-catalog" ? catalogResponse : keyResponse;
    });
    vi.stubGlobal("fetch", fetchMock);

    const pending = testCustomApiConnection({ baseUrl: "https://api.example", apiKey: "secret" });
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer secret",
    );

    resolveCatalog(jsonResponse(sourceCatalog()));
    resolveKey(jsonResponse({ data: [{ id: "source-image-model" }] }));

    await expect(pending).resolves.toMatchObject({ models: [{ id: "image-model" }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads native Gemini models with the explicit protocol header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        models: [
          { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
          { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchCustomApiModelIdsForFormat(
        "https://generativelanguage.googleapis.com",
        "gemini-secret",
        "gemini",
      ),
    ).resolves.toEqual(["gemini-2.5-flash"]);
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("x-goog-api-key")).toBe(
      "gemini-secret",
    );
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).pathname).toBe("/v1beta/models");
  });

  it("keeps native Gemini execution separate from the OpenAI-compatible route", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        candidates: [{ content: { parts: [{ text: "Gemini response" }] } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const model = createSyntheticCustomModel("gemini-2.5-flash", "text");
    const route = createSyntheticCustomRoute("gemini-2.5-flash", "text")!;
    await expect(
      executeCustomGeneration({
        connection: {
          baseUrl: "https://generativelanguage.googleapis.com",
          apiKey: "secret",
          apiFormat: "gemini",
        },
        model,
        route,
        parameters: { messages: [{ role: "user", content: "hello" }] },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).resolves.toMatchObject({ text: "Gemini response" });

    const [input, init] = fetchMock.mock.calls[0]!;
    expect(new URL(String(input)).pathname).toBe("/v1beta/models/gemini-2.5-flash:generateContent");
    expect(new Headers(init?.headers).get("x-goog-api-key")).toBe("secret");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "hello" }] }],
    });
  });

  it("loads and executes a Chinese Midjourney model through its dedicated endpoint", async () => {
    const imageUrls = [
      "http://127.0.0.1/mj-1.png",
      "http://127.0.0.1/mj-2.png",
      "http://127.0.0.1/mj-3.png",
      "http://127.0.0.1/mj-4.png",
    ];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/model-catalog") {
        return Promise.resolve(
          jsonResponse({
            success: true,
            version: "mj-catalog-1",
            capability_version: "mj-capability-1",
            pricing_version: "mj-pricing-1",
            fetched_at: "2026-08-27T08:00:00.000Z",
            models: [
              {
                id: "Midjourney v8.2 高速",
                modality: "image",
                operation: "generate",
                endpoint: {
                  method: "POST",
                  path: "/v1/midjourney/generations",
                  content_type: "application/json",
                },
                input: { text: { required: true }, images: { min: 0, max: 5, multiple: true } },
                output: { type: "image", count: { fixed: 4 } },
                parameters: [
                  { name: "model", type: "string", fixed: "Midjourney v8.2 高速" },
                  { name: "prompt", type: "string", required: true },
                  {
                    name: "size",
                    type: "string",
                    default: "9:16",
                    options: ["1:1", "16:9", "9:16"],
                  },
                  { name: "raw", type: "boolean", default: false },
                  { name: "n", type: "integer", fixed: 1 },
                  {
                    name: "images",
                    type: "array",
                    items: { type: "string", format: "public-http-url" },
                    max_items: 5,
                  },
                ],
                public: { id: "Midjourney v8.2 高速", label: "Midjourney v8.2 高速" },
                selectable: true,
              },
            ],
          }),
        );
      }
      if (url.pathname === "/v1/models") {
        return Promise.resolve(jsonResponse({ data: [{ id: "Midjourney v8.2 高速" }] }));
      }
      if (url.pathname === "/v1/midjourney/generations") {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          model: "Midjourney v8.2 高速",
          prompt: "cinematic city",
          size: "16:9",
          raw: false,
          n: 1,
        });
        return Promise.resolve(
          jsonResponse({
            data: { task_id: "mj-task-1", status: "completed", image_urls: imageUrls },
          }),
        );
      }
      if (imageUrls.includes(url.toString())) {
        return Promise.resolve(
          new Response(new Blob(["png"], { type: "image/png" }), {
            status: 200,
            headers: { "Content-Type": "image/png" },
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "http://127.0.0.1",
      apiKey: "secret",
    });
    const model = catalog.models[0]!;
    expect(model.id).toBe("Midjourney v8.2 高速");
    expect(catalog.routes[model.id]).toMatchObject({ endpointPath: "/v1/midjourney/generations" });

    const result = await executeCustomGeneration({
      connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
      model,
      route: catalog.routes[model.id]!,
      parameters: { prompt: "cinematic city", size: "16:9", raw: false, n: 1 },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
    });
    expect(result.media).toHaveLength(4);
    expect(result.media?.every((media) => media.mimeType === "image/png")).toBe(true);
  });

  it("uses the catalog version when an upstream omits its pricing version", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/model-catalog") {
        return Promise.resolve(jsonResponse({ ...sourceCatalog(), pricing_version: "" }));
      }
      return Promise.resolve(jsonResponse({ data: [{ id: "source-image-model" }] }));
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog).toMatchObject({
      version: "catalog-1",
      pricingVersion: "catalog-1",
      capabilitySource: "rich",
      catalogWarning: null,
      models: [{ id: "image-model" }],
    });
  });

  it("normalizes reference-media roles from a rich custom catalog", async () => {
    const source = sourceCatalog();
    source.models[0]!.input = {
      text: { required: true },
      reference_media: {
        images: { min: 0, max: 1, multiple: false, role: "frame" },
        style_images: { min: 0, max: 4, multiple: true },
        element_images: { min: 0, max: 3, multiple: true },
        audios: { min: 0, max: 1, multiple: false },
        max_total_items: 4,
      },
    };
    source.models[0]!.parameters.push(
      {
        name: "styleImages",
        path: "images",
        type: "array",
        max_items: 1,
        items: { type: "string", format: "uri-or-data-image" },
      },
      {
        name: "referenceImages",
        path: "style_references",
        type: "array",
        max_items: 6,
        items: { type: "string", format: "uri-or-data-image" },
      },
      {
        name: "elementImages",
        path: "element_references",
        type: "array",
        max_items: 3,
        items: { type: "string", format: "uri-or-data-image" },
      },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-image-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.referenceMedia).toEqual({
      images: { min: 0, max: 1, multiple: false, role: "frame" },
      styleImages: { min: 0, max: 4, multiple: true },
      elementImages: { min: 0, max: 3, multiple: true },
      maxTotalItems: 4,
    });
    expect(catalog.routes["image-model"]?.parameters).toContainEqual(
      expect.objectContaining({
        name: "referenceImages",
        path: "style_references",
      }),
    );
  });

  it("derives Gemini Omni reference roles from paths without explicit reference_media", async () => {
    const source = sourceCatalog();
    const model = source.models[0]!;
    model.id = "gemini-omni-flash";
    model.modality = "video";
    model.endpoint = { method: "POST", path: "/v1/videos", content_type: "application/json" };
    model.output = { type: "video", count: { fixed: 1 } };
    model.public = { id: "gemini-omni-flash", label: "Gemini Omni Flash" };
    model.parameters[0]!.fixed = "gemini-omni-flash";
    const fields = ["images", "style_references", "element_references", "input_video"];
    model.parameters.push(
      {
        name: "styleImages",
        path: "images",
        type: "array",
        max_items: 1,
        items: { type: "string", format: "uri-or-data-image" },
        aggregate_constraint: { fields, max_total_items: 5 },
      },
      {
        name: "referenceImages",
        path: "style_references",
        type: "array",
        max_items: 4,
        items: { type: "string", format: "uri-or-data-image" },
        aggregateConstraint: { fields, maxTotalItems: 4 },
      },
      {
        name: "elementImages",
        path: "element_references",
        type: "array",
        max_items: 3,
        items: { type: "string", format: "uri-or-data-image" },
        aggregate_constraint: { fields: ["images"], max_total_items: 1 },
      },
      { name: "referenceVideos", path: "input_video", type: "string" },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "gemini-omni-flash" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.referenceMedia).toEqual({
      images: { min: 0, max: 1, multiple: false },
      styleImages: { min: 0, max: 4, multiple: true },
      elementImages: { min: 0, max: 3, multiple: true },
      videos: { min: 0, max: 1, multiple: false },
      maxTotalItems: 4,
    });
  });

  it("keeps max_items zero and does not enable roles without a matching media path", async () => {
    const source = sourceCatalog();
    source.models[0]!.input = {
      text: { required: true },
      reference_media: {
        images: { min: 1, max: 2, multiple: true, role: "frame" },
        style_images: { max: 2 },
      },
    };
    source.models[0]!.parameters.push({
      name: "referenceImages",
      path: "images",
      type: "array",
      required: true,
      min_items: 1,
      max_items: 0,
      items: { type: "string", format: "uri-or-data-image" },
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-image-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.referenceMedia).toEqual({
      images: { min: 0, max: 0, multiple: false, role: "frame" },
    });
  });

  it("treats image-generation models with a required image parameter as reference-optional", async () => {
    const source = sourceCatalog();
    source.models[0]!.parameters.push({
      name: "image",
      type: "string",
      required: true,
      format: "uri-or-data-image",
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-image-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.images).toEqual({ min: 0, max: 1, multiple: false });
    expect(catalog.models[0]?.input.referenceMedia?.images).toEqual({
      min: 0,
      max: 1,
      multiple: false,
    });
  });

  it("preserves explicitly required image minima for image models", async () => {
    const source = sourceCatalog();
    source.models[0]!.input = {
      text: { required: true },
      images: { min: 1, max: 1, multiple: false },
      reference_media: {
        images: { min: 1, max: 1, multiple: false },
      },
    };
    source.models[0]!.parameters.push({
      name: "referenceImage",
      type: "string",
      required: true,
      format: "uri-or-data-image",
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-image-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.images).toEqual({ min: 1, max: 1, multiple: false });
    expect(catalog.models[0]?.input.referenceMedia?.images).toEqual({
      min: 1,
      max: 1,
      multiple: false,
    });
  });

  it("keeps an ordinary generic image input optional for image models", async () => {
    const source = sourceCatalog();
    source.models[0]!.parameters.push({
      name: "image",
      type: "string",
      format: "uri-or-data-image",
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-image-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.images).toEqual({ min: 0, max: 1, multiple: false });
    expect(catalog.models[0]?.input.referenceMedia?.images).toEqual({
      min: 0,
      max: 1,
      multiple: false,
    });

    const generationMock = vi.fn().mockResolvedValue(jsonResponse({ data: [] }));
    vi.stubGlobal("fetch", generationMock);
    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model: catalog.models[0]!,
        route: catalog.routes["image-model"]!,
        parameters: { prompt: "text to image" },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).rejects.toMatchObject({ code: "IMAGE_RESULT_INVALID" });
    expect(generationMock).toHaveBeenCalled();
  });

  it("retains a required minimum for an explicit reference_image parameter on an image model", async () => {
    const source = sourceCatalog();
    source.models[0]!.parameters.push({
      name: "reference_image",
      type: "string",
      required: true,
      format: "uri-or-data-image",
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-image-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.images).toEqual({ min: 0, max: 1, multiple: false });
    expect(catalog.models[0]?.input.referenceMedia?.images).toEqual({
      min: 1,
      max: 1,
      multiple: false,
    });

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model: catalog.models[0]!,
        route: catalog.routes["image-model"]!,
        parameters: { prompt: "text to image" },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REQUIRED" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves required reference image slots for video models", async () => {
    const source = videoSourceCatalog();
    source.models[0]!.input = {
      text: { required: true },
      reference_media: {
        images: { min: 1, max: 1, multiple: false },
      },
    };
    source.models[0]!.parameters.push({
      name: "reference_image",
      type: "string",
      required: true,
      format: "public-http-url",
    });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-video-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.referenceMedia?.images).toEqual({
      min: 1,
      max: 1,
      multiple: false,
    });
  });

  it("preserves required frame and specialized image roles for video models", async () => {
    const source = videoSourceCatalog();
    source.models[0]!.parameters.push(
      { name: "first_frame_image", type: "string", required: true, format: "public-http-url" },
      { name: "style_reference", type: "string", required: true, format: "public-http-url" },
      { name: "element_reference", type: "string", required: true, format: "public-http-url" },
    );
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      return Promise.resolve(
        pathname === "/api/model-catalog"
          ? jsonResponse(source)
          : jsonResponse({ data: [{ id: "source-video-model" }] }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.example",
      apiKey: "secret",
    });

    expect(catalog.models[0]?.input.referenceMedia).toEqual({
      images: { min: 1, max: 1, multiple: false, role: "frame" },
      styleImages: { min: 1, max: 1, multiple: false },
      elementImages: { min: 1, max: 1, multiple: false },
    });
  });

  it("allows an empty reference list through generation validation for an image-generation model", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        choices: [{ message: { content: "done" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const model = textModel();
    model.input.referenceMedia = {
      images: { min: 0, max: 1, multiple: false },
    };

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model,
        route: baseRoute(),
        parameters: { messages: [{ role: "user", content: "test" }] },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).resolves.toEqual({ text: "done" });
  });

  it("adds exact Grok video capabilities when a New API relay only exposes /v1/models", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/api/model-catalog")
        return Promise.resolve(jsonResponse({ error: "not found" }, 404));
      return Promise.resolve(
        jsonResponse({
          data: [
            { id: "grok-imagine-video" },
            { id: "grok-imagine-video-1.5" },
            { id: "unclassified-model" },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const catalog = await testCustomApiConnection({
      baseUrl: "https://api.pro666.top",
      apiKey: "secret",
    });

    expect(catalog.capabilitySource).toBe("models-only");
    expect(catalog.models.map((model) => model.id)).toEqual([
      "grok-imagine-video",
      "grok-imagine-video-1.5",
    ]);
    expect(catalog.models[1]).toMatchObject({
      modality: "video",
      input: { images: { min: 1, max: 1, multiple: false } },
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: "seconds", type: "string", default: "6" }),
        expect.objectContaining({ name: "resolution", options: ["480p", "720p", "1080p"] }),
      ]),
    });
    expect(catalog.routes["grok-imagine-video-1.5"]).toMatchObject({
      endpointPath: "/v1/videos",
      parameters: expect.arrayContaining([
        expect.objectContaining({
          name: "first_frame_image",
          path: "first_frame_image",
          format: "public-http-url",
        }),
      ]),
    });
  });
});

describe("Grok custom video requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("surfaces an upstream plan requirement from a failed video task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          id: "task-1",
          status: "failed",
          error: {
            code: "job_minimum_pro_plan_required",
            message: "当前模型要求 Higgsfield Pro 套餐，请更换已开通 Pro 的账号后重试。",
          },
        }),
      ),
    );
    const model = createSyntheticCustomModel("higgsfield-sd2", "video");
    const route = createSyntheticCustomRoute("higgsfield-sd2", "video")!;

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "cinematic orbit shot" },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).rejects.toMatchObject({
      code: "JOB_MINIMUM_PRO_PLAN_REQUIRED",
      message: "当前 Higgsfield 账号需要 Pro 套餐（job_minimum_pro_plan_required）",
    });
  });

  it("submits 1.5 preview with a top-level image and string seconds", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const model = createSyntheticCustomModel("grok-imagine-video-1.5", "video");
    const route = createSyntheticCustomRoute("grok-imagine-video-1.5", "video")!;

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "https://api.pro666.top", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "animate", seconds: 6, aspect_ratio: "9:16", resolution: "1080p" },
        inputs: {
          images: ["https://media.example/first.png"],
          styleImages: [],
          elementImages: [],
          videos: [],
          audios: [],
        },
      }),
    ).rejects.toMatchObject({ code: "VIDEO_TASK_MISSING" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      version: "video.v1",
      model: "grok-imagine-video-1.5",
      operation: "image_to_video",
      prompt: "animate",
      duration_seconds: 6,
      aspect_ratio: "9:16",
      resolution: "1080p",
      media_inputs: [
        { kind: "image", role: "first_frame", url: "https://media.example/first.png" },
      ],
      options: { async: true, n: 1 },
    });
  });

  it("maps multiple Grok 1.0 references to {url} entries and enforces the 10-second limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const model = createSyntheticCustomModel("grok-imagine-video", "video");
    const route = createSyntheticCustomRoute("grok-imagine-video", "video")!;
    const inputs = {
      images: ["https://media.example/a.png", "https://media.example/b.png"],
      styleImages: [],
      elementImages: [],
      videos: [],
      audios: [],
    };

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "https://api.pro666.top", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "keep the character consistent", seconds: "10" },
        inputs,
      }),
    ).rejects.toMatchObject({ code: "VIDEO_TASK_MISSING" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      version: "video.v1",
      model: "grok-imagine-video",
      operation: "image_to_video",
      duration_seconds: 10,
      media_inputs: [
        { kind: "image", role: "reference", url: "https://media.example/a.png" },
        { kind: "image", role: "reference", url: "https://media.example/b.png" },
      ],
      options: { async: true, n: 1 },
    });

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "https://api.pro666.top", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "too long", seconds: "11" },
        inputs,
      }),
    ).rejects.toMatchObject({ code: "DURATION_OUT_OF_RANGE" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects Grok 1.5 preview before submission when no first-frame image is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const model = createSyntheticCustomModel("grok-imagine-video-1.5", "video");
    const route = createSyntheticCustomRoute("grok-imagine-video-1.5", "video")!;

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "https://api.pro666.top", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "unsupported text-only request", seconds: "6" },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).rejects.toMatchObject({ code: "REFERENCE_REQUIRED" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses catalog defaults and keeps protocol-owned controls authoritative", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const model = createSyntheticCustomModel("public-video", "video");
    const route: CustomApiRoute = {
      sourceModelId: "private-video-route",
      modality: "video",
      endpointPath: "/v1/videos",
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "private-video-route" },
        { name: "prompt", path: "prompt", type: "string" },
        { name: "seconds", path: "seconds", type: "integer", default: 8 },
        { name: "resolution", path: "resolution", type: "string", default: "720p" },
        { name: "aspect_ratio", path: "aspect_ratio", type: "string", default: "16:9" },
        { name: "seed", path: "seed", type: "integer", default: 42 },
        { name: "async", path: "async", type: "boolean", fixed: false },
        { name: "n", path: "n", type: "integer", fixed: 9 },
      ],
    };

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "animate", async: false, n: 9 },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).rejects.toMatchObject({ code: "VIDEO_TASK_MISSING" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      version: "video.v1",
      model: "public-video",
      operation: "text_to_video",
      prompt: "animate",
      duration_seconds: 8,
      resolution: "720p",
      aspect_ratio: "16:9",
      options: { seed: 42, async: true, n: 1 },
    });
  });

  it("downloads completed videos through the standard content endpoint when status has no URL", async () => {
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/videos")
        return Promise.resolve(
          jsonResponse({ id: "task-content", status: "completed", progress: 100 }),
        );
      if (url.pathname === "/v1/videos/task-content/content") {
        return Promise.resolve(
          new Response(new Blob(["video-bytes"], { type: "video/mp4" }), {
            status: 200,
            headers: { "Content-Type": "video/mp4" },
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = createSyntheticCustomModel("public-video", "video");
    const route: CustomApiRoute = {
      sourceModelId: "public-video",
      modality: "video",
      endpointPath: "/v1/videos",
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "public-video" },
        { name: "prompt", path: "prompt", type: "string" },
      ],
    };

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "animate" },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).resolves.toMatchObject({ media: [{ mimeType: "video/mp4" }] });

    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/v1/videos",
      "/v1/videos/task-content/content",
    ]);
  });

  it("turns an interrupted result body read into a diagnostic custom API error", async () => {
    const bodyReadError = new Error("The user aborted a request.");
    const response = new Response(null, { status: 200, headers: { "Content-Type": "video/mp4" } });
    Object.defineProperty(response, "blob", { value: vi.fn().mockRejectedValue(bodyReadError) });
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === "/v1/videos")
        return Promise.resolve(
          jsonResponse({
            id: "task-aborted",
            status: "completed",
            url: "http://127.0.0.1/result.mp4",
          }),
        );
      if (pathname === "/result.mp4") return Promise.resolve(response);
      throw new Error(`unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const model = createSyntheticCustomModel("public-video", "video");
    const route = createSyntheticCustomRoute("public-video", "video")!;

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model,
        route,
        parameters: { prompt: "animate" },
        inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
      }),
    ).rejects.toMatchObject({
      code: "RESULT_READ_INTERRUPTED",
      message: "视频结果读取中断，请稍后从任务记录重试",
    });
  });

  it("submits the nine-image video.v1 route with fixed resolution and without a duplicate size field", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const model = createSyntheticCustomModel("S-2.0-9图版", "video");
    model.input.images = { min: 0, max: 9, multiple: true };
    const route: CustomApiRoute = {
      sourceModelId: "S-2.0-9图版",
      modality: "video",
      endpointPath: "/v1/videos",
      parameters: [
        { name: "model", path: "model", type: "string", fixed: "S-2.0-9图版" },
        { name: "prompt", path: "prompt", type: "string" },
        { name: "duration_seconds", path: "duration_seconds", type: "integer" },
        { name: "aspect_ratio", path: "aspect_ratio", type: "string" },
        { name: "resolution", path: "resolution", type: "string", fixed: "720p" },
        { name: "images", path: "images", type: "array", itemsFormat: "public-http-url" },
      ],
    };

    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model,
        route,
        parameters: {
          prompt: "人物自然转身",
          duration_seconds: 15,
          aspect_ratio: "9:16",
          resolution: "720p",
        },
        inputs: {
          images: ["https://media.example/reference.png"],
          styleImages: [],
          elementImages: [],
          videos: [],
          audios: [],
        },
      }),
    ).rejects.toMatchObject({ code: "VIDEO_TASK_MISSING" });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      version: "video.v1",
      model: "S-2.0-9图版",
      operation: "image_to_video",
      prompt: "人物自然转身",
      duration_seconds: 15,
      aspect_ratio: "9:16",
      resolution: "720p",
      media_inputs: [
        { kind: "image", role: "reference", url: "https://media.example/reference.png" },
      ],
      options: { async: true, n: 1 },
    });
  });
});

describe("custom API audio execution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("executes a chat-completions music model and stores each downloaded track", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body });
      if (url.endsWith("/v1/chat/completions"))
        return jsonResponse({
          choices: [{ message: { content: "", audio: { url: "https://cdn.example/a.mp3" } } }],
          data: [{ url: "https://cdn.example/b.mp3" }],
        });
      return new Response(new Uint8Array([0xff, 0xfb, 0x90, 0x00]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { storeMedia } = await import("./media-store");

    const result = await executeCustomGeneration({
      connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
      model: audioModel(),
      route: audioChatRoute(),
      parameters: { messages: [{ role: "user", content: "轻快的钢琴曲" }] },
      inputs: emptyInputs(),
    });

    const submit = calls.find((call) => call.url.endsWith("/v1/chat/completions"));
    expect(JSON.parse(String(submit?.body))).toMatchObject({
      model: "private-suno",
      messages: [{ role: "user", content: "轻快的钢琴曲" }],
    });
    expect(result.media).toHaveLength(2);
    // storeMedia 的 mock 在整个测试文件共享，只看本测试的两次调用（按序）。
    const stored = vi.mocked(storeMedia).mock.calls;
    expect(stored.slice(-2).map((call) => call[1])).toEqual(["audio", "audio"]);
    expect((stored.at(-2)?.[0] as File).type).toBe("audio/mpeg");
    expect((stored.at(-1)?.[0] as File).type).toBe("audio/mpeg");
  });

  it("wraps a bare voice option into the Gemini speechConfig object shape", async () => {
    const pcm = Buffer.from([0x00, 0x10, 0x20, 0x30]);
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body });
      if (url.includes(":generateContent"))
        return jsonResponse({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: "audio/l16; rate=24000; channels=1",
                      data: pcm.toString("base64"),
                    },
                  },
                ],
              },
            },
          ],
        });
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { storeMedia } = await import("./media-store");

    await executeCustomGeneration({
      connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
      model: audioModel(),
      route: audioGeminiRoute(),
      parameters: {
        contents: [{ role: "user", parts: [{ text: "你好" }] }],
        speechConfig: "Kore",
      },
      inputs: emptyInputs(),
    });

    const submit = calls.find((call) => call.url.includes(":generateContent"));
    const body = JSON.parse(String(submit?.body));
    expect(body).toMatchObject({
      contents: [{ role: "user", parts: [{ text: "你好" }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { voice: "Kore" } },
      },
    });
    // 无头 PCM 被包成 WAV 后入库（取本测试的最后一次 storeMedia 调用）。
    const storedFile = vi.mocked(storeMedia).mock.calls.at(-1)?.[0] as File;
    expect(storedFile.type).toBe("audio/wav");
    const bytes = new Uint8Array(await storedFile.arrayBuffer());
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(bytes.subarray(44)).toEqual(new Uint8Array(pcm));
  });

  it("fails explicitly when a chat audio response carries no links", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ choices: [{ message: { content: "完成" } }] })),
    );
    await expect(
      executeCustomGeneration({
        connection: { baseUrl: "http://127.0.0.1", apiKey: "secret" },
        model: audioModel(),
        route: audioChatRoute(),
        parameters: { messages: [] },
        inputs: emptyInputs(),
      }),
    ).rejects.toMatchObject({ code: "AUDIO_RESULT_UNPARSEABLE" });
  });
});

function audioModel(): PublicModel {
  return {
    id: "public-audio",
    label: "Audio model",
    description: "",
    modality: "audio",
    operation: "generate",
    order: 0,
    input: { textRequired: true },
    output: { type: "audio", minCount: 1, maxCount: 2 },
    parameters: [],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  };
}

function audioChatRoute(): CustomApiRoute {
  return {
    sourceModelId: "private-suno",
    modality: "audio",
    endpointPath: "/v1/chat/completions",
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "private-suno" },
      { name: "messages", path: "messages", type: "array" },
      { name: "n", path: "n", type: "integer", fixed: 1 },
    ],
  };
}

function audioGeminiRoute(): CustomApiRoute {
  return {
    sourceModelId: "private-gemini-tts",
    modality: "audio",
    endpointPath: "/v1beta/models/private-gemini-tts:generateContent",
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "private-gemini-tts" },
      { name: "contents", path: "contents", type: "array" },
      { name: "speechConfig", path: "generationConfig.speechConfig", type: "object" },
      {
        name: "responseModalities",
        path: "generationConfig.responseModalities",
        type: "array",
        fixed: ["AUDIO"],
      },
    ],
  };
}

function emptyInputs() {
  return { images: [], styleImages: [], elementImages: [], videos: [], audios: [] };
}

function routeWithMediaParameter(name: string, type: "array" | "string"): CustomApiRoute {
  const route = baseRoute();
  route.parameters.push({ name, path: "upstream.references", type });
  return route;
}

function baseRoute(): CustomApiRoute {
  return {
    sourceModelId: "private-text-route",
    modality: "text",
    endpointPath: "/v1/chat/completions",
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "private-text-route" },
      { name: "messages", path: "messages", type: "array" },
    ],
  };
}

function textModel(): PublicModel {
  return {
    id: "public-text-route",
    label: "Text model",
    description: "",
    modality: "text",
    operation: "generate",
    order: 0,
    input: {
      textRequired: true,
      images: { min: 0, max: 2, multiple: true },
      videos: { min: 0, max: 2, multiple: true },
      audios: { min: 0, max: 2, multiple: true },
    },
    output: { type: "text", minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "messages",
        label: "Messages",
        type: "array",
        required: true,
        mutuallyExclusiveWith: [],
      },
    ],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  };
}

function imageProtocolModel(): PublicModel {
  return {
    id: "image-model",
    label: "Image model",
    description: "",
    modality: "image",
    operation: "generate",
    order: 0,
    protocol: {
      version: "image.v1",
      endpoint: { method: "POST", path: "/v1/images/generations" },
      mediaRoles: ["reference"],
    },
    input: { textRequired: true, images: { min: 0, max: 4, multiple: true } },
    output: { type: "image", minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "prompt",
        label: "Prompt",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
      {
        name: "resolution",
        label: "Resolution",
        type: "string",
        required: false,
        mutuallyExclusiveWith: [],
      },
      {
        name: "aspect_ratio",
        label: "Aspect ratio",
        type: "string",
        required: false,
        mutuallyExclusiveWith: [],
      },
      {
        name: "quality",
        label: "Quality",
        type: "string",
        required: false,
        mutuallyExclusiveWith: [],
      },
    ],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 1,
      baseCreditMicros: 0,
      baseYuanMicros: 0,
      tiers: [],
    },
  };
}

function imageProtocolRoute(): CustomApiRoute {
  return {
    sourceModelId: "source-image-model",
    modality: "image",
    endpointPath: "/v1/images/generations",
    parameters: [
      { name: "model", path: "model", type: "string", fixed: "source-image-model" },
      { name: "prompt", path: "prompt", type: "string" },
      { name: "resolution", path: "resolution", type: "string" },
      { name: "size", path: "size", type: "string" },
      { name: "quality", path: "quality", type: "string" },
      { name: "images", path: "images", type: "array", itemsFormat: "public-http-url" },
    ],
  };
}

function sourceCatalog(): CustomApiCatalogSource {
  return {
    success: true,
    version: "catalog-1",
    capability_version: "capability-1",
    pricing_version: "pricing-1",
    fetched_at: "2026-07-23T08:00:00.000Z",
    models: [
      {
        id: "source-image-model",
        modality: "image",
        operation: "generate",
        endpoint: {
          method: "POST",
          path: "/v1/images/generations",
          content_type: "application/json",
        },
        input: { text: { required: true } },
        output: { type: "image", count: { fixed: 1 } },
        parameters: [
          { name: "model", type: "string", fixed: "source-image-model" },
          { name: "prompt", type: "string", required: true },
        ],
        public: { id: "image-model", label: "Image model" },
        selectable: true,
      },
    ],
  };
}

function videoSourceCatalog(): CustomApiCatalogSource {
  return {
    success: true,
    version: "catalog-1",
    capability_version: "capability-1",
    pricing_version: "pricing-1",
    fetched_at: "2026-07-23T08:00:00.000Z",
    models: [
      {
        id: "source-video-model",
        modality: "video",
        operation: "generate",
        endpoint: { method: "POST", path: "/v1/videos", content_type: "application/json" },
        input: { text: { required: true } },
        output: { type: "video", count: { fixed: 1 } },
        parameters: [
          { name: "model", type: "string", fixed: "source-video-model" },
          { name: "prompt", type: "string", required: true },
        ],
        public: { id: "video-model", label: "Video model" },
        selectable: true,
      },
    ],
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("protocol override (P0)", () => {
  it("keeps only well-formed auth overrides and drops unsafe names", () => {
    expect(normalizeProtocolOverride({ auth: { style: "bearer" } })).toEqual({
      auth: { style: "bearer" },
    });
    expect(normalizeProtocolOverride({ auth: { style: "header", name: "x-api-key" } })).toEqual({
      auth: { style: "header", name: "x-api-key" },
    });
    // 自定义头/查询参数必须有合法名字，否则整条覆盖丢弃、退回默认 bearer。
    expect(
      normalizeProtocolOverride({ auth: { style: "header", name: "bad name!" } }),
    ).toBeUndefined();
    expect(normalizeProtocolOverride({ auth: { style: "query", name: "" } })).toBeUndefined();
    expect(normalizeProtocolOverride({ auth: { style: "nope" } })).toBeUndefined();
  });

  it("accepts only in-site absolute endpoint paths", () => {
    expect(
      normalizeProtocolOverride({
        endpoints: {
          video: "/v1/videos/generate",
          audio: "/v1/chat/completions",
          text: "https://evil.test/v1/chat/completions",
          image: "/v1/../etc/passwd",
        },
      }),
    ).toEqual({ endpoints: { video: "/v1/videos/generate", audio: "/v1/chat/completions" } });
  });

  it("filters result paths: no blanks, no prototype segments", () => {
    expect(
      normalizeProtocolOverride({
        resultUrlPaths: ["data.outputs.0.url", "   ", "__proto__", "data.url"],
      }),
    ).toEqual({ resultUrlPaths: ["data.outputs.0.url", "data.url"] });
    // 空白协议档案等于没填：默认路径，零迁移。
    expect(normalizeProtocolOverride({})).toBeUndefined();
    expect(normalizeProtocolOverride(null)).toBeUndefined();
  });

  it("applies the configured auth style to outbound requests", () => {
    const server = "https://relay.test";
    const bearer = customApiAuthInit({ baseUrl: server, apiKey: "sk-test" }, "/v1/models");
    expect(bearer.headers.Authorization).toBe("Bearer sk-test");

    const header = customApiAuthInit(
      {
        baseUrl: server,
        apiKey: "sk-test",
        protocol: { auth: { style: "header", name: "x-api-key" } },
      },
      "/v1/models",
    );
    expect(header.headers["x-api-key"]).toBe("sk-test");
    expect(header.headers.Authorization).toBeUndefined();

    const query = customApiAuthInit(
      { baseUrl: server, apiKey: "sk-test", protocol: { auth: { style: "query", name: "key" } } },
      "/v1/models",
    );
    expect(query.url.searchParams.get("key")).toBe("sk-test");
    expect(query.headers.Authorization).toBeUndefined();
  });

  it("overrides the route endpoint only for the configured modality", () => {
    const route: CustomApiRoute = {
      sourceModelId: "custom-image",
      modality: "image",
      endpointPath: "/v1/images/generations",
      parameters: [],
    };
    const connection = {
      baseUrl: "https://relay.test",
      apiKey: "sk-test",
      protocol: { endpoints: { image: "/v1/custom/images" } },
    };
    expect(applyProtocolOverride(route, connection).endpointPath).toBe("/v1/custom/images");
    // 未配置覆盖 = 原样返回（同一份路由同时供选择器与执行使用）。
    expect(applyProtocolOverride(route, undefined).endpointPath).toBe("/v1/images/generations");
    expect(
      applyProtocolOverride(route, { baseUrl: connection.baseUrl, apiKey: "k" }).endpointPath,
    ).toBe("/v1/images/generations");
  });
});

describe("protocol override (P1/P2): polling and request encoding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("polls a numeric task ID to a numeric completion status and retrieves the result", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/videos") return jsonResponse({ data: { id: 42, state: 0 } });
      if (path === "/v1/tasks/42")
        return jsonResponse({ data: { id: 42, state: 2, url: "https://cdn.test/result.mp4" } });
      if (path === "/result.mp4")
        return new Response(new Blob(["video-bytes"], { type: "video/mp4" }));
      throw new Error(`Unexpected request: ${path}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = executeCustomGeneration({
      connection: {
        baseUrl: "https://relay.test",
        apiKey: "test-key",
        protocol: {
          poll: {
            taskIdPaths: ["data.id"],
            statusPaths: ["data.state"],
            successValues: ["2"],
            failValues: ["3"],
            urlTemplate: "/v1/tasks/{id}",
          },
          resultUrlPaths: ["data.url"],
        },
      },
      model: createSyntheticCustomModel("test-video", "video"),
      route: createSyntheticCustomRoute("test-video", "video")!,
      parameters: { prompt: "animate" },
      inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
    });
    const assertion = expect(result).resolves.toMatchObject({ media: [{ mimeType: "video/mp4" }] });
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;
    expect(fetchMock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      "/v1/videos",
      "/v1/tasks/42",
      "/result.mp4",
    ]);
  });

  it("uses numeric status codes consistently in the offline response probe", () => {
    const protocol = {
      poll: {
        taskIdPaths: ["data.id"],
        statusPaths: ["data.state"],
        successValues: ["2"],
        failValues: ["3"],
      },
    };
    for (const [state, verdict] of [
      [0, "running"],
      [2, "completed"],
      [3, "failed"],
    ] as const) {
      const result = probeCustomApiResponse(JSON.stringify({ data: { id: 42, state } }), protocol);
      if (!result.ok) throw new Error(result.message);
      expect(result.probe.taskId?.value).toBe("42");
      expect(result.probe.status?.verdict).toBe(verdict);
    }
    for (const state of [true, {}, [], null]) {
      const result = probeCustomApiResponse(JSON.stringify({ data: { state } }), protocol);
      if (!result.ok) throw new Error(result.message);
      expect(result.probe.status).toBeNull();
    }
  });
  it("keeps poll overrides only when they are well-formed", () => {
    expect(
      normalizeProtocolOverride({
        poll: {
          urlTemplate: "/v1/tasks/{task_id}",
          method: "POST",
          taskIdPaths: ["data.task.id"],
          statusPaths: ["data.state"],
          successValues: ["succeeded", "2"],
          failValues: ["failed"],
          progressPath: "data.percent",
        },
      }),
    ).toEqual({
      poll: {
        urlTemplate: "/v1/tasks/{task_id}",
        method: "POST",
        taskIdPaths: ["data.task.id"],
        statusPaths: ["data.state"],
        successValues: ["succeeded", "2"],
        failValues: ["failed"],
        progressPath: "data.percent",
      },
    });
    // 模板只允许 {task_id}/{id} 占位符，且必须是站内路径。
    expect(
      normalizeProtocolOverride({ poll: { urlTemplate: "https://evil.test/t/{id}" } }),
    ).toBeUndefined();
    expect(
      normalizeProtocolOverride({ poll: { urlTemplate: "/v1/tasks/{other}" } }),
    ).toBeUndefined();
    expect(
      normalizeProtocolOverride({ poll: { urlTemplate: "/v1/../tasks/{id}" } }),
    ).toBeUndefined();
    // GET 是默认值，不写进档案；json 同理。
    expect(normalizeProtocolOverride({ poll: { method: "GET" } })).toBeUndefined();
    expect(normalizeProtocolOverride({ request: { contentType: "json" } })).toBeUndefined();
    expect(normalizeProtocolOverride({ request: { contentType: "multipart" } })).toEqual({
      request: { contentType: "multipart" },
    });
  });

  it("probes a pasted response and reports the matched point paths", () => {
    const protocol = {
      poll: { taskIdPaths: ["data.task.id"], statusPaths: ["data.state"], successValues: ["2"] },
      resultUrlPaths: ["data.output.video_url"],
    };
    const ok = probeCustomApiResponse(
      JSON.stringify({
        data: {
          task: { id: "task_9" },
          state: "2",
          output: { video_url: "https://cdn.test/a.mp4" },
        },
      }),
      protocol,
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) throw new Error("expected a successful probe");
    expect(ok.probe.taskId).toEqual({ value: "task_9", path: "data.task.id" });
    expect(ok.probe.status).toEqual({ raw: "2", path: "data.state", verdict: "completed" });
    expect(ok.probe.resultUrl).toEqual({
      value: "https://cdn.test/a.mp4",
      path: "data.output.video_url",
    });

    // 未配置成功的状态值 → 继续等待（不猜完成）
    const pending = probeCustomApiResponse('{"data":{"state":"1"}}', protocol);
    if (!pending.ok) throw new Error("expected a successful probe");
    expect(pending.probe.status?.verdict).toBe("running");

    expect(probeCustomApiResponse("", protocol).ok).toBe(false);
    expect(probeCustomApiResponse("not json", protocol).ok).toBe(false);
  });

  it("sends a real text test request through the configured endpoint and auth", async () => {
    let captured: { url: string; headers: Record<string, string>; body: string } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL, init: RequestInit) => {
        captured = {
          url: String(url),
          headers: (init.headers ?? {}) as Record<string, string>,
          body: String(init.body ?? ""),
        };
        return jsonResponse({ choices: [{ message: { content: "ok" } }] });
      }),
    );

    const result = await sendCustomApiTestRequest(
      {
        baseUrl: "https://relay.test",
        apiKey: "sk-test",
        protocol: {
          auth: { style: "header", name: "x-api-key" },
          endpoints: { text: "/v1/custom/chat" },
        },
      },
      "mock-text",
    );

    expect(result.path).toBe("/v1/custom/chat");
    expect(result.contentType).toBe("json");
    expect(captured!.url).toBe("https://relay.test/v1/custom/chat");
    // 认证样式与端点覆盖必须和真实生成走同一套。
    expect(captured!.headers["x-api-key"]).toBe("sk-test");
    expect(captured!.headers.Authorization).toBeUndefined();
    expect(JSON.parse(captured!.body)).toMatchObject({ model: "mock-text", max_tokens: 1 });
  });

  it("refuses a test request without a model id", async () => {
    await expect(
      sendCustomApiTestRequest({ baseUrl: "https://relay.test", apiKey: "sk-test" }, "  "),
    ).rejects.toThrow("先填一个用于测试的模型 id");
  });

  it("reads upstream failures through the configured error paths", async () => {
    // 中转站常见形状：{code, msg}；内置候选已覆盖 msg，但这里显式声明路径以验证优先级。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ err: { text: "余额不足", no: 4001 } }, 400)),
    );
    await expect(
      sendCustomApiTestRequest(
        {
          baseUrl: "https://relay.test",
          apiKey: "sk-test",
          protocol: { error: { messagePaths: ["err.text"], codePaths: ["err.no"] } },
        },
        "mock-text",
      ),
    ).rejects.toThrow("余额不足");

    // 没有配置时也要能读出常见字段（msg / code），不再只认 error.message。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ code: "RATE_LIMIT", msg: "太频繁" }, 400)),
    );
    await expect(
      sendCustomApiTestRequest({ baseUrl: "https://relay.test", apiKey: "sk-test" }, "t"),
    ).rejects.toThrow("太频繁");

    // 完全读不出消息时给带错误码的兜底文案，而不是空消息（错误码允许是数字）。
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ nope: 4001 }, 400)),
    );
    await expect(
      sendCustomApiTestRequest(
        {
          baseUrl: "https://relay.test",
          apiKey: "sk-test",
          protocol: { error: { codePaths: ["nope"] } },
        },
        "t",
      ),
    ).rejects.toThrow("生成请求失败 (400 · 4001)");
  });

  it("normalizes error overrides and drops unsafe paths", () => {
    expect(
      normalizeProtocolOverride({
        error: { messagePaths: ["msg", "__proto__"], codePaths: ["code"] },
      }),
    ).toEqual({ error: { messagePaths: ["msg"], codePaths: ["code"] } });
    expect(normalizeProtocolOverride({ error: {} })).toBeUndefined();
  });

  it("reports error message and code in the probe", () => {
    const result = probeCustomApiResponse(JSON.stringify({ code: "4001", msg: "余额不足" }), {});
    if (!result.ok) throw new Error("expected a successful probe");
    expect(result.probe.errorMessage).toEqual({ value: "余额不足", path: "msg" });
    expect(result.probe.errorCode).toEqual({ value: "4001", path: "code" });
  });

  it("builds form and multipart bodies without inventing field names", async () => {
    const payload = {
      model: "m",
      prompt: "hi",
      tags: ["a", "b"],
      options: { size: "2k" },
      image: "data:image/png;base64,iVBORw0KGgo=",
    };
    const form = await buildProtocolRequestBody(payload, "form");
    const params = form.body as URLSearchParams;
    expect(params.getAll("tags")).toEqual(["a", "b"]);
    expect(params.get("options")).toBe('{"size":"2k"}');
    expect(params.get("image")).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(form.headers["Content-Type"]).toContain("x-www-form-urlencoded");

    const multipart = await buildProtocolRequestBody(payload, "multipart");
    const data = multipart.body as FormData;
    expect(data.get("prompt")).toBe("hi");
    expect(data.getAll("tags")).toEqual(["a", "b"]);
    const file = data.get("image");
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe("image/png");
    // multipart 的 Content-Type 必须留给浏览器（带 boundary）。
    expect(multipart.headers["Content-Type"]).toBeUndefined();

    const json = await buildProtocolRequestBody(payload, "json");
    expect(json.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(json.body as string)).toMatchObject({ model: "m", prompt: "hi" });
  });
});
