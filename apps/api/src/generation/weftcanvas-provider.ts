import { Buffer } from "node:buffer";

import { z } from "zod";

import {
  buildImageProtocolRequest,
  buildVideoProtocolRequest,
  imageProtocolResponseSchema,
  isAllowedAudioEndpoint,
  isGeminiNativeAudioPath,
  wrapPcmToWav,
  type ImageMediaInput,
  type VideoMediaInput,
} from "@weftcanvas/contracts";

import type { PrivateModelRoute } from "../catalog/execution-route.js";
import type { GenerationResultStagingStore, StagedGenerationResult } from "./result-staging.js";
import {
  GenerationProviderError,
  type GenerationProvider,
  type ProviderExecutionState,
  type ProviderGenerationRequest,
} from "./types.js";

const MAX_RESPONSE_BYTES = 110 * 1024 * 1024;
const MAX_REQUEST_BYTES = 80 * 1024 * 1024;
const EXPECTED_ENDPOINTS = {
  text: new Set(["/v1/chat/completions"]),
  image: new Set(["/v1/images/generations", "/v1/midjourney/generations"]),
  video: new Set(["/v1/videos"]),
  audio: new Set(["/v1/chat/completions"]),
} as const;
const IMAGE_MEDIA_NAMES = new Set([
  "image",
  "images",
  "image_urls",
  "reference_image",
  "reference_images",
  "referenceImages",
  "first_image",
  "last_image",
  "style_references",
  "styleImages",
  "style_images",
  "element_references",
  "elementImages",
  "element_images",
]);
const VIDEO_MEDIA_NAMES = new Set([
  "video",
  "videos",
  "reference_video",
  "reference_videos",
  "referenceVideos",
  "input_video",
  "source_video",
]);
const AUDIO_MEDIA_NAMES = new Set([
  "audio",
  "audios",
  "reference_audio",
  "reference_audios",
  "referenceAudios",
]);
const BLOCKED_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const ASYNC_IMAGE_TASK_PREFIX = "image-videos:";
type ImageTaskTransport = "tasks" | "videos";

const usageSchema = z
  .object({
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const textResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z.object({ content: z.unknown() }).passthrough(),
          })
          .passthrough(),
      )
      .min(1),
    usage: usageSchema.optional(),
  })
  .passthrough();

const imageLegacyResponseSchema = z
  .object({
    data: z
      .array(
        z
          .object({
            url: z.string().optional(),
            b64_json: z.string().optional(),
            revised_prompt: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1)
      .max(8),
    usage: usageSchema.optional(),
  })
  .passthrough();
const imageResponseSchema = z.union([imageLegacyResponseSchema, imageProtocolResponseSchema]);

const videoResponseSchema = z
  .object({
    id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    status: z.string().optional(),
    progress: z.number().optional(),
    error: z
      .union([
        z.string(),
        z
          .object({
            code: z.union([z.string(), z.number()]).optional(),
            message: z.string().optional(),
          })
          .passthrough(),
      ])
      .nullable()
      .optional(),
  })
  .passthrough();

export type GenerationReferenceKind = "image" | "video" | "audio";

export interface GenerationReferenceResolver {
  resolve(input: {
    ownerId: string;
    mediaId: string;
    kind: GenerationReferenceKind;
    format?: string;
  }): Promise<string>;
}

type WeftcanvasGenerationProviderOptions = {
  baseUrl: string;
  apiKey: string;
  staging: GenerationResultStagingStore;
  references: GenerationReferenceResolver;
  fetch?: typeof globalThis.fetch;
  allowInsecureHttp?: boolean;
  submitTimeoutMs?: number;
  pollTimeoutMs?: number;
};

export class WeftcanvasGenerationProvider implements GenerationProvider {
  private readonly origin: string;
  private readonly apiKey: string;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly submitTimeoutMs: number;
  private readonly pollTimeoutMs: number;

  constructor(private readonly options: WeftcanvasGenerationProviderOptions) {
    const base = new URL(options.baseUrl);
    if (base.username || base.password)
      throw new Error("Generation API URL cannot contain credentials");
    const localHttp =
      options.allowInsecureHttp &&
      base.protocol === "http:" &&
      ["127.0.0.1", "localhost", "::1"].includes(base.hostname);
    if (base.protocol !== "https:" && !localHttp)
      throw new Error("Generation API URL must use HTTPS");
    this.origin = base.origin;
    this.apiKey = options.apiKey.trim();
    if (!this.apiKey) throw new Error("Generation API key is required");
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.submitTimeoutMs = options.submitTimeoutMs ?? 10 * 60_000;
    this.pollTimeoutMs = options.pollTimeoutMs ?? 30_000;
  }

  async submit(request: ProviderGenerationRequest): Promise<ProviderExecutionState> {
    if (request.quantity !== 1) {
      throw rejected("BATCH_GENERATION_UNAVAILABLE", "当前任务暂不支持批量提交");
    }
    assertExecutionRoute(request.executionRoute, request.modality);
    const payload = await buildWeftcanvasRequestPayload(request, this.options.references);
    if (request.modality === "audio") normalizeAudioRequestPayload(payload);
    const asyncImage = request.modality === "image" && isAsyncImageRoute(request.executionRoute);
    const response = await this.requestJson(
      asyncImage ? "/v1/videos" : request.executionRoute.endpoint.path,
      { method: "POST", body: payload },
      "submit",
    );
    if (request.modality === "text") {
      return this.stage(request.jobId, parseTextResult(response));
    }
    if (request.modality === "audio") {
      return this.stage(
        request.jobId,
        parseAudioResult(response, request.executionRoute, this.origin),
      );
    }
    if (request.modality === "image") {
      if (!asyncImage) {
        const synchronous = imageResponseSchema.safeParse(response);
        if (synchronous.success)
          return this.stage(request.jobId, parseImageResult(synchronous.data, this.origin));
      }
      return this.imageState(
        request.jobId,
        response,
        undefined,
        "submit",
        asyncImage ? "videos" : "tasks",
      );
    }
    if (request.modality === "video") {
      return this.videoState(request.jobId, response, undefined, "submit");
    }
    throw rejected("MODEL_MODALITY_UNAVAILABLE", "当前模型类型暂不支持生成");
  }

  async poll(taskId: string, request: ProviderGenerationRequest): Promise<ProviderExecutionState> {
    if (request.modality !== "image" && request.modality !== "video") {
      throw rejected("TASK_POLLING_UNAVAILABLE", "当前任务不支持进度查询");
    }
    assertExecutionRoute(request.executionRoute, request.modality);
    const imageTask = request.modality === "image" ? decodeImageTaskId(taskId) : null;
    const path =
      request.modality === "image"
        ? `/v1/${imageTask!.transport}/${encodeURIComponent(imageTask!.taskId)}`
        : `/v1/videos/${encodeURIComponent(safeTaskId(taskId))}`;
    const response = await this.requestJson(path, { method: "GET" }, "poll");
    if (request.modality === "image") {
      return this.imageState(
        request.jobId,
        response,
        imageTask!.taskId,
        "poll",
        imageTask!.transport,
      );
    }
    return this.videoState(request.jobId, response, taskId, "poll");
  }

  private async stage(
    jobId: string,
    result: StagedGenerationResult,
    taskId?: string,
  ): Promise<ProviderExecutionState> {
    const resultRef = await this.options.staging.write(jobId, result);
    return { kind: "output", resultRef, ...(taskId ? { taskId } : {}) };
  }

  private async videoState(
    jobId: string,
    value: unknown,
    fallbackTaskId: string | undefined,
    phase: "submit" | "poll",
  ): Promise<ProviderExecutionState> {
    const response = videoResponseSchema.parse(value);
    const taskId = response.id ?? response.task_id ?? fallbackTaskId;
    if (!taskId) throw rejected("VIDEO_TASK_MISSING", "视频任务没有返回可恢复标识");
    const status = normalizeVideoStatus(response.status);
    if (status === "failed") {
      const failure = videoFailure(value);
      return { kind: "failed", code: failure.code, message: failure.message, retryable: false };
    }
    if (status === "completed") {
      const url = videoResultUrl(response, this.origin);
      if (url) return this.stage(jobId, { kind: "video", taskId, url }, taskId);
      if (phase === "submit") return { kind: "queued", taskId, progress: 100 };
      throw new GenerationProviderError("VIDEO_RESULT_PENDING", "视频结果仍在准备中", "transient");
    }
    if (status === "running")
      return { kind: "running", taskId, progress: normalizedProgress(response.progress) };
    return { kind: "queued", taskId, progress: normalizedProgress(response.progress) };
  }

  private async imageState(
    jobId: string,
    value: unknown,
    fallbackTaskId: string | undefined,
    phase: "submit" | "poll",
    transport: ImageTaskTransport,
  ): Promise<ProviderExecutionState> {
    const upstreamTaskId = imageTaskId(value) ?? fallbackTaskId;
    if (!upstreamTaskId) throw rejected("IMAGE_TASK_MISSING", "图片任务没有返回可恢复标识");
    const taskId = encodeImageTaskId(upstreamTaskId, transport);
    const status = normalizeTaskStatus(taskStatus(value));
    const items = imageTaskItems(value, this.origin);
    if (items.length) return this.stage(jobId, { kind: "image", items }, taskId);
    if (status === "failed") {
      return {
        kind: "failed",
        code: "IMAGE_GENERATION_FAILED",
        message: "图片生成失败",
        retryable: false,
      };
    }
    if (status === "completed") {
      if (phase === "submit") return { kind: "queued", taskId, progress: 100 };
      throw new GenerationProviderError("IMAGE_RESULT_PENDING", "图片结果仍在准备中", "transient");
    }
    const progress = normalizedProgress(taskProgress(value));
    return status === "running"
      ? { kind: "running", taskId, ...(progress !== undefined ? { progress } : {}) }
      : { kind: "queued", taskId, ...(progress !== undefined ? { progress } : {}) };
  }

  private async requestJson(
    path: string,
    request: { method: "GET" | "POST"; body?: Record<string, unknown> },
    phase: "submit" | "poll",
  ) {
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin)
      throw new Error("Generation route escaped the configured origin");
    const serialized = request.body === undefined ? undefined : JSON.stringify(request.body);
    if (serialized && Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) {
      throw rejected("GENERATION_REQUEST_TOO_LARGE", "参考素材过大，请减少后重试");
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: request.method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...(serialized ? { "Content-Type": "application/json" } : {}),
        },
        ...(serialized ? { body: serialized } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(phase === "submit" ? this.submitTimeoutMs : this.pollTimeoutMs),
      });
    } catch (error) {
      if (error instanceof GenerationProviderError) throw error;
      throw new GenerationProviderError(
        phase === "submit" ? "GENERATION_SUBMISSION_UNCONFIRMED" : "GENERATION_STATUS_UNAVAILABLE",
        phase === "submit" ? "任务提交结果待确认" : "暂时无法获取生成进度",
        phase === "submit" ? "unknown" : "transient",
      );
    }

    const maxBytes = response.ok ? MAX_RESPONSE_BYTES : 64 * 1024;
    const text = await readLimitedResponse(response, maxBytes).catch(() => {
      throw new GenerationProviderError(
        "GENERATION_RESPONSE_TOO_LARGE",
        "生成服务返回内容过大",
        phase === "submit" ? "unknown" : "transient",
      );
    });
    if (!response.ok) {
      const definitive = response.status >= 400 && response.status < 500;
      const sanitizedMessage = sanitizeProviderMessage(safeUpstreamMessage(text));
      const upstreamMessage = sanitizedMessage || undefined;
      throw new GenerationProviderError(
        response.status === 429 ? "GENERATION_RATE_LIMITED" : "GENERATION_REQUEST_FAILED",
        upstreamMessage ??
          (response.status === 429
            ? "生成请求过于频繁，请稍后重试"
            : definitive
              ? "当前参数无法提交"
              : "生成服务暂时不可用"),
        definitive ? "rejected" : phase === "submit" ? "unknown" : "transient",
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GenerationProviderError(
        "GENERATION_RESPONSE_INVALID",
        "生成服务返回格式异常",
        phase === "submit" ? "unknown" : "transient",
      );
    }
  }
}

export async function buildWeftcanvasRequestPayload(
  request: ProviderGenerationRequest,
  references: GenerationReferenceResolver,
) {
  const route = request.executionRoute;
  assertExecutionRoute(route, request.modality);
  if (request.modality === "video") {
    return buildWeftcanvasVideoRequestPayload(request, references);
  }
  if (request.modality === "image") {
    return buildWeftcanvasImageRequestPayload(request, references);
  }
  const payload: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (parameter.fixed !== undefined) {
      setPath(payload, parameter.path, parameter.fixed);
      continue;
    }
    if (isMediaParameter(parameter.name)) continue;
    const value = request.parameters[parameter.name];
    if (parameter.name === "stream" && value === true)
      throw rejected("STREAMING_UNAVAILABLE", "当前任务暂不支持流式生成");
    if (value !== undefined) setPath(payload, parameter.path, value);
  }
  if (payload.model !== route.sourceModelId)
    throw new Error("Private model route is not fixed correctly");

  await bindImages(payload, route, request.ownerId, request.inputs.images ?? [], references);
  await bindMedia(
    payload,
    route,
    request.ownerId,
    request.inputs.styleImages ?? [],
    "image",
    ["style_references", "styleImages", "style_images"],
    [],
    references,
  );
  await bindMedia(
    payload,
    route,
    request.ownerId,
    request.inputs.elementImages ?? [],
    "image",
    ["element_references", "elementImages", "element_images"],
    [],
    references,
  );
  await bindMedia(
    payload,
    route,
    request.ownerId,
    request.inputs.videos,
    "video",
    ["videos", "referenceVideos", "reference_videos"],
    ["video", "reference_video"],
    references,
  );
  await bindMedia(
    payload,
    route,
    request.ownerId,
    request.inputs.audios,
    "audio",
    ["audios", "referenceAudios", "reference_audios"],
    ["audio", "reference_audio"],
    references,
  );
  return payload;
}

const IMAGE_CORE_PARAMETER_NAMES = new Set([
  "version",
  "operation",
  "model",
  "prompt",
  "resolution",
  "size",
  "aspect_ratio",
  "aspectRatio",
  "ratio",
  "quality",
  "count",
  "n",
  "media_inputs",
  "options",
]);

async function buildWeftcanvasImageRequestPayload(
  request: ProviderGenerationRequest,
  references: GenerationReferenceResolver,
) {
  const route = request.executionRoute;
  const fixedModel = route.parameters.find((parameter) => parameter.name === "model")?.fixed;
  if (fixedModel !== route.sourceModelId)
    throw new Error("Private model route is not fixed correctly");

  const mediaInputs: ImageMediaInput[] = [];
  await appendImageProtocolMedia(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.images ?? [],
    "reference",
    references,
  );
  await appendImageProtocolMedia(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.styleImages ?? [],
    "style_reference",
    references,
    "style",
  );
  await appendImageProtocolMedia(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.elementImages ?? [],
    "element_reference",
    references,
    "element",
  );

  const options: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (IMAGE_CORE_PARAMETER_NAMES.has(parameter.name) || isMediaParameter(parameter.name))
      continue;
    const value =
      parameter.fixed !== undefined ? parameter.fixed : request.parameters[parameter.name];
    if (value !== undefined) options[parameter.name] = value;
  }
  const protocol = buildImageProtocolRequest({
    model: request.modelId,
    prompt: String(imageScalar(route, request.parameters, ["prompt"]) ?? ""),
    ...optionalImageString("resolution", imageScalar(route, request.parameters, ["resolution"])),
    ...optionalImageString(
      "aspectRatio",
      imageScalar(route, request.parameters, ["aspect_ratio", "aspectRatio", "ratio", "size"]),
    ),
    ...optionalImageString("quality", imageScalar(route, request.parameters, ["quality"])),
    ...optionalImageNumber("count", imageScalar(route, request.parameters, ["count", "n"])),
    mediaInputs,
    options,
  });

  const projected: Record<string, unknown> = { ...protocol.options, prompt: protocol.prompt };
  assignImageScalar(projected, route, ["resolution"], protocol.resolution);
  assignImageScalar(
    projected,
    route,
    ["aspect_ratio", "aspectRatio", "ratio", "size"],
    protocol.aspect_ratio,
  );
  assignImageScalar(projected, route, ["quality"], protocol.quality);
  assignImageScalar(projected, route, ["count", "n"], protocol.count);
  const payload: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (parameter.fixed !== undefined) setPath(payload, parameter.path, parameter.fixed);
    else if (!isMediaParameter(parameter.name) && projected[parameter.name] !== undefined)
      setPath(payload, parameter.path, projected[parameter.name]);
  }
  if (payload.model !== route.sourceModelId)
    throw new Error("Private model route is not fixed correctly");
  bindImageProtocolUrls(payload, route, protocol.media_inputs ?? []);
  return payload;
}

async function appendImageProtocolMedia(
  target: ImageMediaInput[],
  route: PrivateModelRoute,
  ownerId: string,
  mediaIds: string[],
  role: ImageMediaInput["role"],
  references: GenerationReferenceResolver,
  position?: "style" | "element",
) {
  if (!mediaIds.length) return;
  const aliases =
    position === "style"
      ? ["style_references", "styleImages", "style_images"]
      : position === "element"
        ? ["element_references", "elementImages", "element_images"]
        : [
            "images",
            "image_urls",
            "referenceImages",
            "reference_images",
            "image",
            "reference_image",
          ];
  const parameter =
    findMediaParameter(route, aliases, "array") ?? findMediaParameter(route, aliases, "string");
  if (!parameter) throw rejected("TOO_MANY_REFERENCES", "当前模型不支持参考图");
  if (parameter.type !== "array" && mediaIds.length > 1)
    throw rejected("TOO_MANY_REFERENCES", "当前模型不支持多张参考图");
  const format = parameter.itemsFormat ?? parameter.format;
  for (const mediaId of mediaIds) {
    target.push({
      kind: "image",
      role,
      url: await resolveReference(ownerId, mediaId, "image", format, references),
    });
  }
}

function bindImageProtocolUrls(
  payload: Record<string, unknown>,
  route: PrivateModelRoute,
  mediaInputs: ImageMediaInput[],
) {
  for (const role of ["reference", "style_reference", "element_reference"] as const) {
    const values = mediaInputs.filter((input) => input.role === role).map((input) => input.url);
    if (!values.length) continue;
    const aliases =
      role === "style_reference"
        ? ["style_references", "styleImages", "style_images"]
        : role === "element_reference"
          ? ["element_references", "elementImages", "element_images"]
          : [
              "images",
              "image_urls",
              "referenceImages",
              "reference_images",
              "image",
              "reference_image",
            ];
    const arrayParameter = findMediaParameter(route, aliases, "array");
    const singleParameter = findMediaParameter(route, aliases, "string");
    if (arrayParameter) {
      setPath(payload, arrayParameter.path, values);
    } else if (singleParameter) {
      setPath(payload, singleParameter.path, values[0]);
    } else {
      throw rejected("TOO_MANY_REFERENCES", "当前模型不支持多张参考图");
    }
  }
}

function imageScalar(route: PrivateModelRoute, values: Record<string, unknown>, aliases: string[]) {
  for (const alias of aliases) {
    const parameter = route.parameters.find(
      (candidate) => candidate.name === alias || candidate.path.split(".").at(-1) === alias,
    );
    if (!parameter) continue;
    if (parameter.fixed !== undefined) return parameter.fixed;
    if (values[parameter.name] !== undefined) return values[parameter.name];
    for (const valueAlias of aliases) {
      if (values[valueAlias] !== undefined) return values[valueAlias];
    }
    if (parameter.default !== undefined) return parameter.default;
  }
  return undefined;
}

function assignImageScalar(
  target: Record<string, unknown>,
  route: PrivateModelRoute,
  aliases: string[],
  value: unknown,
) {
  if (value === undefined) return;
  const parameter = route.parameters.find(
    (candidate) =>
      aliases.includes(candidate.name) || aliases.includes(candidate.path.split(".").at(-1) ?? ""),
  );
  if (parameter && parameter.fixed === undefined) target[parameter.name] = value;
}

function optionalImageString(key: "resolution" | "aspectRatio" | "quality", value: unknown) {
  return typeof value === "string" && value.trim() ? { [key]: value } : {};
}

function optionalImageNumber(key: "count", value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? { [key]: number } : {};
}

const VIDEO_CORE_PARAMETER_NAMES = new Set([
  "version",
  "operation",
  "model",
  "prompt",
  "duration_seconds",
  "duration",
  "seconds",
  "resolution",
  "size",
  "aspect_ratio",
  "ratio",
  "media_inputs",
  "options",
  "async",
  "n",
]);

async function buildWeftcanvasVideoRequestPayload(
  request: ProviderGenerationRequest,
  references: GenerationReferenceResolver,
) {
  const route = request.executionRoute;
  const fixedModel = route.parameters.find((parameter) => parameter.name === "model")?.fixed;
  if (fixedModel !== route.sourceModelId)
    throw new Error("Private model route is not fixed correctly");

  const mediaInputs: VideoMediaInput[] = [];
  await appendVideoImageInputs(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.images ?? [],
    references,
  );
  await appendResolvedVideoMedia(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.styleImages ?? [],
    "image",
    "style_reference",
    ["style_references", "styleImages", "style_images"],
    references,
  );
  await appendResolvedVideoMedia(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.elementImages ?? [],
    "image",
    "element_reference",
    ["element_references", "elementImages", "element_images"],
    references,
  );
  const videoParameter = findMediaParameter(route, [
    "videos",
    "referenceVideos",
    "reference_videos",
    "video",
    "reference_video",
    "input_video",
  ]);
  const videoRole =
    videoParameter?.path.split(".").at(-1) === "input_video" ? "source_video" : "reference";
  await appendResolvedVideoMedia(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.videos,
    "video",
    videoRole,
    ["videos", "referenceVideos", "reference_videos", "video", "reference_video", "input_video"],
    references,
  );
  await appendResolvedVideoMedia(
    mediaInputs,
    route,
    request.ownerId,
    request.inputs.audios,
    "audio",
    "audio_reference",
    [
      "audios",
      "referenceAudios",
      "reference_audios",
      "audio",
      "reference_audio",
      "audio_reference",
    ],
    references,
  );

  const options: Record<string, unknown> = {};
  for (const parameter of route.parameters) {
    if (VIDEO_CORE_PARAMETER_NAMES.has(parameter.name) || isMediaParameter(parameter.name))
      continue;
    const value =
      parameter.fixed !== undefined ? parameter.fixed : request.parameters[parameter.name];
    if (parameter.name === "stream" && value === true)
      throw rejected("STREAMING_UNAVAILABLE", "当前任务暂不支持流式生成");
    if (value !== undefined) options[parameter.name] = value;
  }

  const duration = videoScalar(route, request.parameters, [
    "duration_seconds",
    "seconds",
    "duration",
  ]);
  const resolution = videoScalar(route, request.parameters, ["resolution", "size"]);
  const aspectRatio = videoScalar(route, request.parameters, ["aspect_ratio", "ratio"]);
  const prompt = videoScalar(route, request.parameters, ["prompt"]);
  return buildVideoProtocolRequest({
    model: request.modelId,
    prompt: String(prompt ?? ""),
    ...(duration !== undefined ? { durationSeconds: Number(duration) } : {}),
    ...(resolution !== undefined ? { resolution: String(resolution) } : {}),
    ...(aspectRatio !== undefined ? { aspectRatio: String(aspectRatio) } : {}),
    mediaInputs,
    options,
  });
}

function videoScalar(route: PrivateModelRoute, values: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const parameter = route.parameters.find((candidate) => candidate.name === name);
    if (!parameter) continue;
    if (parameter.fixed !== undefined) return parameter.fixed;
    if (values[name] !== undefined) return values[name];
    if (parameter.default !== undefined) return parameter.default;
  }
  return undefined;
}

async function appendVideoImageInputs(
  target: VideoMediaInput[],
  route: PrivateModelRoute,
  ownerId: string,
  mediaIds: string[],
  references: GenerationReferenceResolver,
) {
  if (!mediaIds.length) return;
  const arrayParameter = findMediaParameter(
    route,
    ["images", "image_urls", "referenceImages", "reference_images"],
    "array",
  );
  if (arrayParameter) {
    const format = arrayParameter.itemsFormat ?? arrayParameter.format;
    for (const mediaId of mediaIds) {
      target.push({
        kind: "image",
        role: "reference",
        url: await resolveReference(ownerId, mediaId, "image", format, references),
      });
    }
    return;
  }
  const firstFrame = route.parameters.find((parameter) =>
    ["first_image", "start_frame"].includes(parameter.name),
  );
  const lastFrame = route.parameters.find((parameter) =>
    ["last_image", "end_frame"].includes(parameter.name),
  );
  if (!firstFrame && !lastFrame) {
    await appendResolvedVideoMedia(
      target,
      route,
      ownerId,
      mediaIds,
      "image",
      "reference",
      ["image", "reference_image"],
      references,
    );
    return;
  }
  if (mediaIds.length > 2) throw rejected("TOO_MANY_REFERENCES", "当前模型最多支持首尾两张参考图");
  if (firstFrame) {
    target.push({
      kind: "image",
      role: "first_frame",
      url: await resolveReference(ownerId, mediaIds[0]!, "image", firstFrame.format, references),
    });
  }
  if (lastFrame && mediaIds[1]) {
    target.push({
      kind: "image",
      role: "last_frame",
      url: await resolveReference(ownerId, mediaIds.at(-1)!, "image", lastFrame.format, references),
    });
  }
}

async function appendResolvedVideoMedia(
  target: VideoMediaInput[],
  route: PrivateModelRoute,
  ownerId: string,
  mediaIds: string[],
  kind: GenerationReferenceKind,
  role: VideoMediaInput["role"],
  aliases: string[],
  references: GenerationReferenceResolver,
) {
  if (!mediaIds.length) return;
  const parameter =
    findMediaParameter(route, aliases, "array") ?? findMediaParameter(route, aliases, "string");
  if (!parameter)
    throw rejected("TOO_MANY_REFERENCES", `当前模型不支持${referenceLabel(kind)}参考`);
  if (parameter.type !== "array" && mediaIds.length > 1) {
    throw rejected("TOO_MANY_REFERENCES", `当前模型不支持多${referenceLabel(kind)}参考`);
  }
  const format = parameter.itemsFormat ?? parameter.format;
  for (const mediaId of mediaIds) {
    target.push({
      kind,
      role,
      url: await resolveReference(ownerId, mediaId, kind, format, references),
    });
  }
}

async function bindImages(
  payload: Record<string, unknown>,
  route: PrivateModelRoute,
  ownerId: string,
  mediaIds: string[],
  references: GenerationReferenceResolver,
) {
  if (!mediaIds.length) return;
  const arrayNames = ["images", "image_urls", "referenceImages", "reference_images"];
  const arrayParameter = findMediaParameter(route, arrayNames, "array");
  if (arrayParameter) {
    const format = arrayParameter.itemsFormat ?? arrayParameter.format;
    const values = await Promise.all(
      mediaIds.map((mediaId) => resolveReference(ownerId, mediaId, "image", format, references)),
    );
    setPath(payload, arrayParameter.path, values);
    return;
  }
  const firstFrame = route.parameters.find((parameter) => parameter.name === "first_image");
  const lastFrame = route.parameters.find((parameter) => parameter.name === "last_image");
  if (firstFrame || lastFrame) {
    if (firstFrame)
      setPath(
        payload,
        firstFrame.path,
        await resolveReference(ownerId, mediaIds[0]!, "image", firstFrame.format, references),
      );
    if (lastFrame && mediaIds[1])
      setPath(
        payload,
        lastFrame.path,
        await resolveReference(ownerId, mediaIds.at(-1)!, "image", lastFrame.format, references),
      );
    if (mediaIds.length > 2)
      throw rejected("TOO_MANY_REFERENCES", "当前模型最多支持首尾两张参考图");
    return;
  }
  await bindMedia(
    payload,
    route,
    ownerId,
    mediaIds,
    "image",
    arrayNames,
    ["image", "reference_image"],
    references,
  );
}

async function bindMedia(
  payload: Record<string, unknown>,
  route: PrivateModelRoute,
  ownerId: string,
  mediaIds: string[],
  kind: GenerationReferenceKind,
  arrayNames: string[],
  singleNames: string[],
  references: GenerationReferenceResolver,
) {
  if (!mediaIds.length) return;
  const aliases = [...arrayNames, ...singleNames];
  const arrayParameter = findMediaParameter(route, aliases, "array");
  const singleParameter = findMediaParameter(route, aliases, "string");
  if (mediaIds.length === 1 && singleParameter) {
    setPath(
      payload,
      singleParameter.path,
      await resolveReference(ownerId, mediaIds[0]!, kind, singleParameter.format, references),
    );
    return;
  }
  if (!arrayParameter)
    throw rejected("TOO_MANY_REFERENCES", `当前模型不支持多${referenceLabel(kind)}参考`);
  const format = arrayParameter.itemsFormat ?? arrayParameter.format;
  const values = await Promise.all(
    mediaIds.map((mediaId) => resolveReference(ownerId, mediaId, kind, format, references)),
  );
  setPath(payload, arrayParameter.path, values);
}

function findMediaParameter(
  route: PrivateModelRoute,
  aliases: string[],
  type?: PrivateModelRoute["parameters"][number]["type"],
) {
  return route.parameters.find((parameter) => {
    const pathTail = parameter.path.split(".").at(-1);
    if (type && parameter.type !== type) return false;
    return (
      aliases.includes(parameter.name) ||
      aliases.includes(parameter.path) ||
      (pathTail !== undefined && aliases.includes(pathTail))
    );
  });
}

async function resolveReference(
  ownerId: string,
  mediaId: string,
  kind: GenerationReferenceKind,
  format: string | undefined,
  references: GenerationReferenceResolver,
) {
  const value = await references.resolve({ ownerId, mediaId, kind, ...(format ? { format } : {}) });
  if (format === "public-http-url" && !isHttpUrl(value))
    throw rejected("REFERENCE_NOT_PUBLIC", "参考素材暂时无法用于当前模型");
  if (format === "uri-or-data-image" && !isHttpUrl(value) && !value.startsWith("data:image/")) {
    throw rejected("REFERENCE_FORMAT_INVALID", "参考图片格式不正确");
  }
  return value;
}

function parseTextResult(value: unknown): StagedGenerationResult {
  const response = textResponseSchema.parse(value);
  const text = messageText(response.choices[0]!.message.content).trim();
  if (!text) throw rejected("TEXT_RESULT_EMPTY", "文本生成没有返回可用内容");
  return { kind: "text", text, ...usageResult(response.usage) };
}

function parseImageResult(value: unknown, origin: string): StagedGenerationResult {
  const response = imageResponseSchema.parse(value);
  const items: Array<{ url?: string; b64_json?: string; revised_prompt?: string }> =
    "outputs" in response
      ? (response.outputs as Array<{ content_url: string }>).map((item) => ({
          url: item.content_url,
        }))
      : response.data;
  const parsedItems = items.map((item) => {
    if (item.b64_json) return base64Image(item.b64_json, item.revised_prompt);
    if (item.url?.startsWith("data:image/")) return base64Image(item.url, item.revised_prompt);
    const url = item.url ? resolveResultUrl(item.url, origin) : null;
    if (url) {
      return {
        source: "url" as const,
        url,
        ...(item.revised_prompt ? { revisedPrompt: item.revised_prompt } : {}),
      };
    }
    throw rejected("IMAGE_RESULT_INVALID", "图片生成没有返回可用结果");
  });
  return {
    kind: "image",
    items: parsedItems,
    ...usageResult("usage" in response ? response.usage : undefined),
  };
}

/**
 * 音频执行有两种上游形态（目录与路由白名单保证只有这两种能进来）：
 * - `/v1/chat/completions`（suno）：同步返回，音频是**有时效的下载链接**。
 *   OpenAI 兼容变体很多（message.audio / content 内嵌链接 / data[].url /
 *   outputs[].content_url），全部尝试收集；一个都收不到就显式失败，绝不伪造。
 * - Gemini 原生 `:generateContent`（TTS）：parts[].inlineData 返回无头
 *   PCM，必须按目录声明的采样规格包成 WAV 才能进媒体管线。
 */
function parseAudioResult(
  value: unknown,
  route: PrivateModelRoute,
  origin: string,
): StagedGenerationResult {
  if (isGeminiNativeAudioPath(route.endpoint.path))
    return parseGeminiInlineAudioResult(value, route);
  return parseAudioLinkResult(value, origin);
}

function parseAudioLinkResult(value: unknown, origin: string): StagedGenerationResult {
  if (!value || typeof value !== "object") throw audioUnparseable();
  const response = value as Record<string, unknown>;
  const urls: string[] = [];
  const pushUrl = (candidate: unknown) => {
    if (typeof candidate !== "string") return;
    const resolved = resolveResultUrl(candidate, origin);
    if (resolved && !urls.includes(resolved)) urls.push(resolved);
  };
  for (const choice of arrayOfRecords(response.choices)) {
    const message = recordOf(choice.message);
    if (!message) continue;
    pushUrl(recordOf(message.audio)?.url);
    pushUrl(message.audio_url);
    if (typeof message.content === "string") {
      for (const match of message.content.matchAll(/https?:\/\/[^\s"'<>()\[\]]+/g))
        pushUrl(match[0].replace(/[.,;:!?)]+$/, ""));
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        const record = recordOf(part);
        pushUrl(record ? recordOf(record.audio)?.url : undefined);
        pushUrl(record?.url);
      }
    }
  }
  for (const item of arrayOfRecords(response.data)) {
    pushUrl(item.url);
    pushUrl(item.audio_url);
    pushUrl(item.download_url);
    pushUrl(item.content_url);
  }
  for (const item of arrayOfRecords(response.outputs)) {
    pushUrl(item.content_url);
    pushUrl(item.download_url);
    pushUrl(item.url);
  }
  pushUrl(recordOf(response.audio)?.url);
  pushUrl(response.url);
  pushUrl(response.audio_url);
  const items = urls.slice(0, 8).map((url) => ({ source: "url" as const, url }));
  if (!items.length) throw audioUnparseable();
  return { kind: "audio", items, ...usageResult(usageSchema.safeParse(response.usage).data) };
}

function parseGeminiInlineAudioResult(
  value: unknown,
  route: PrivateModelRoute,
): StagedGenerationResult {
  const parts = geminiCandidateParts(value);
  const inline = parts
    .map((part) => recordOf(part.inlineData ?? part.inline_data))
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry.data === "string" && entry.data.length > 0),
    );
  if (!inline.length) throw rejected("AUDIO_RESULT_EMPTY", "语音合成没有返回音频数据");
  const mimeType = typeof inline[0]?.mimeType === "string" ? (inline[0].mimeType as string) : "";
  // 上游实测：各 part 的 base64 段按序直接拼接即为完整流（段界 4 字符对齐）。
  const combined = inline.map((entry) => entry.data as string).join("");
  if (/l16|pcm/i.test(mimeType)) {
    const pcm = Buffer.from(combined, "base64");
    if (!pcm.length) throw rejected("AUDIO_RESULT_EMPTY", "语音合成没有返回音频数据");
    const wav = wrapPcmToWav(new Uint8Array(pcm), {
      sampleRate: route.audioOutput?.sampleRateHz ?? 24_000,
      channels: route.audioOutput?.channels ?? 1,
    });
    return {
      kind: "audio",
      items: [
        { source: "base64", data: Buffer.from(wav).toString("base64"), mimeType: "audio/wav" },
      ],
    };
  }
  if (!/^audio\//i.test(mimeType)) throw audioUnparseable();
  return { kind: "audio", items: [{ source: "base64", data: combined, mimeType }] };
}

function geminiCandidateParts(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  const candidates = (value as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((candidate) => {
    const content = recordOf(recordOf(candidate)?.content);
    const parts = content?.parts;
    return Array.isArray(parts)
      ? parts.flatMap((part) => (recordOf(part) ? [recordOf(part)!] : []))
      : [];
  });
}

/** 音色下拉发的是裸选项值（"Kore"），Gemini 的 speechConfig 要对象形态。 */
function normalizeAudioRequestPayload(payload: Record<string, unknown>) {
  const generationConfig = recordOf(payload.generationConfig);
  if (!generationConfig) return;
  if (typeof generationConfig.speechConfig === "string")
    generationConfig.speechConfig = { voiceConfig: { voice: generationConfig.speechConfig } };
}

function audioUnparseable() {
  return rejected(
    "AUDIO_RESULT_UNPARSEABLE",
    "音频结果格式无法识别，需要站点确认上游响应形态后适配",
  );
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayOfRecords(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = recordOf(item);
    return record ? [record] : [];
  });
}

function base64Image(value: string, revisedPrompt?: string) {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value);
  return {
    source: "base64" as const,
    data: match?.[2] ?? value,
    mimeType: match?.[1] ?? "image/png",
    ...(revisedPrompt ? { revisedPrompt } : {}),
  };
}

function usageResult(usage: z.infer<typeof usageSchema> | undefined) {
  if (!usage) return {};
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  if (inputTokens === undefined && outputTokens === undefined) return {};
  return {
    usage: {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
    },
  };
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .join("");
}

function assertExecutionRoute(
  route: PrivateModelRoute,
  modality: ProviderGenerationRequest["modality"],
) {
  const expected = EXPECTED_ENDPOINTS[modality as keyof typeof EXPECTED_ENDPOINTS];
  const pathAllowed =
    expected?.has(route.endpoint.path) ||
    (modality === "audio" && isAllowedAudioEndpoint(route.endpoint.path));
  if (
    !expected ||
    route.modality !== modality ||
    route.endpoint.method !== "POST" ||
    !pathAllowed ||
    route.endpoint.contentType !== "application/json"
  ) {
    throw rejected("EXECUTION_ROUTE_INVALID", "当前模型执行配置无效");
  }
}

function isAsyncImageRoute(route: PrivateModelRoute) {
  return route.sourceModelId.trim().toLowerCase() === "image2-a";
}

function encodeImageTaskId(taskId: string, transport: ImageTaskTransport) {
  const safe = safeTaskId(taskId);
  return transport === "videos" ? `${ASYNC_IMAGE_TASK_PREFIX}${safe}` : safe;
}

function decodeImageTaskId(taskId: string): { taskId: string; transport: ImageTaskTransport } {
  const safe = safeTaskId(taskId);
  if (!safe.startsWith(ASYNC_IMAGE_TASK_PREFIX)) return { taskId: safe, transport: "tasks" };
  return { taskId: safeTaskId(safe.slice(ASYNC_IMAGE_TASK_PREFIX.length)), transport: "videos" };
}

function setPath(target: Record<string, unknown>, path: string, value: unknown) {
  const segments = path.split(".");
  if (
    !segments.length ||
    segments.length > 8 ||
    segments.some(
      (segment) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) || BLOCKED_PATH_SEGMENTS.has(segment),
    )
  ) {
    throw new Error("Unsafe generation parameter path");
  }
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const current = cursor[segment];
    if (
      current !== undefined &&
      (!current || typeof current !== "object" || Array.isArray(current))
    )
      throw new Error("Conflicting generation parameter paths");
    if (current === undefined) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
}

function isMediaParameter(name: string) {
  return IMAGE_MEDIA_NAMES.has(name) || VIDEO_MEDIA_NAMES.has(name) || AUDIO_MEDIA_NAMES.has(name);
}

function isHttpUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeVideoStatus(value: string | undefined) {
  const status = value?.trim().toLowerCase().replace(/-/g, "_");
  if (["completed", "succeeded", "success", "done"].includes(status ?? "")) return "completed";
  if (["failed", "error", "cancelled", "canceled"].includes(status ?? "")) return "failed";
  if (["in_progress", "processing", "running"].includes(status ?? "")) return "running";
  return "queued";
}

function normalizeTaskStatus(value: string | undefined) {
  const status = value?.trim().toLowerCase().replace(/-/g, "_");
  if (["completed", "succeeded", "success", "done"].includes(status ?? "")) return "completed";
  if (["failed", "failure", "error", "timeout", "cancelled", "canceled"].includes(status ?? ""))
    return "failed";
  if (["in_progress", "processing", "running"].includes(status ?? "")) return "running";
  return "queued";
}

function imageTaskId(value: unknown) {
  for (const path of ["data.task_id", "task_id", "data.id", "id"]) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "string" && candidate.trim()) return safeTaskId(candidate);
  }
  return null;
}

function taskStatus(value: unknown) {
  for (const path of ["data.status", "status", "data.result.status", "result.status"]) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "string") return candidate;
  }
  return undefined;
}

function taskProgress(value: unknown) {
  for (const path of ["data.progress", "progress"]) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "number") return candidate;
    if (typeof candidate === "string") {
      const parsed = Number(candidate.replace(/%$/, "").trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function imageTaskItems(value: unknown, origin: string) {
  const grids: string[] = [];
  const tiles: string[] = [];
  const visit = (current: unknown, depth: number) => {
    if (depth > 8 || !current || typeof current !== "object") return;
    if (Array.isArray(current)) {
      for (const child of current) visit(child, depth + 1);
      return;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.grid_image_url === "string") grids.push(record.grid_image_url);
    for (const key of ["url", "image_url", "output_url", "result_url", "download_url"]) {
      if (typeof record[key] === "string") tiles.push(record[key] as string);
    }
    if (Array.isArray(record.image_urls)) {
      for (const candidate of record.image_urls)
        if (typeof candidate === "string") tiles.push(candidate);
    }
    for (const [key, child] of Object.entries(record)) {
      if (
        [
          "grid_image_url",
          "url",
          "image_url",
          "output_url",
          "result_url",
          "download_url",
          "image_urls",
        ].includes(key)
      )
        continue;
      if (child && typeof child === "object") visit(child, depth + 1);
    }
  };
  visit(value, 0);
  const unique = [...new Set([...grids, ...tiles])].slice(0, 8);
  return unique.flatMap((candidate) => {
    const url = resolveResultUrl(candidate, origin);
    return url ? [{ source: "url" as const, url }] : [];
  });
}

function videoResultUrl(value: unknown, origin: string) {
  const paths = [
    "outputs.0.content_url",
    "outputs.0.download_url",
    "video.url",
    "url",
    "video_url",
    "download_url",
    "output.url",
    "result.url",
    "result.video_url",
    "data.url",
    "data.video_url",
    "data.video.url",
    "content.url",
    "content.video_url",
    "file.url",
  ];
  for (const path of paths) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate !== "string") continue;
    const url = resolveResultUrl(candidate, origin);
    if (url) return url;
  }
  return null;
}

function resolveResultUrl(value: string, origin: string) {
  if (!value || value.length > 4096) return null;
  try {
    const url = new URL(value, `${origin}/`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function valueAtPath(value: unknown, path: string) {
  let current = value;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function normalizedProgress(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function videoFailure(value: unknown): { code: string; message: string } {
  const upstream = extractUpstreamError(value);
  return {
    code: classifyVideoFailure(upstream),
    message: sanitizeProviderMessage(upstream.message) || "视频生成失败",
  };
}

const ERROR_MESSAGE_PATHS = [
  "error.message",
  "data.error.message",
  "error.error.message",
  "result.message",
  "result.error.message",
  "message",
  "detail",
  "data.message",
  "error",
] as const;

const ERROR_CODE_PATHS = [
  "error.code",
  "data.error.code",
  "error.error.code",
  "result.code",
  "code",
] as const;

function extractUpstreamError(value: unknown): { code?: string; message?: string } {
  const code = firstStringAtPaths(value, ERROR_CODE_PATHS);
  const message = firstStringAtPaths(value, ERROR_MESSAGE_PATHS);
  return {
    ...(code ? { code } : {}),
    ...(message ? { message } : {}),
  };
}

function firstStringAtPaths(value: unknown, paths: readonly string[]) {
  for (const path of paths) {
    const candidate = valueAtPath(value, path);
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return undefined;
}

/**
 * Bound the upstream failure into a stable, product-facing code so arbitrary
 * provider identifiers never reach the browser or the job history. The message
 * stays specific but is sanitized below to drop credentials, internal URLs, and
 * private diagnostics.
 */
function classifyVideoFailure(upstream: { code?: string; message?: string }): string {
  const hint = `${upstream.code ?? ""} ${upstream.message ?? ""}`.toLowerCase();
  if (/429|rate.?limit|限流|过于频繁|请求过多|try again later|retry later/.test(hint))
    return "VIDEO_GENERATION_RATE_LIMITED";
  if (/balance|insufficient|quota|credit|积分|余额|不足|已用完|已欠费/.test(hint))
    return "VIDEO_GENERATION_BALANCE_EXHAUSTED";
  if (/policy|content|moderat|审核|违规|敏感|风险|rejected|拒绝/.test(hint))
    return "VIDEO_GENERATION_CONTENT_REJECTED";
  if (/timeout|超时|timed out|expired/.test(hint)) return "VIDEO_GENERATION_TIMED_OUT";
  return "VIDEO_GENERATION_FAILED";
}

function sanitizeProviderMessage(value: string | undefined): string {
  const cleaned = (value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .replace(/\bBearer\s+[A-Za-z0-9._~+\-/=]+/gi, "Bearer [隐藏]")
    .replace(/https?:\/\/\S+/gi, "[链接]")
    .slice(0, 160);
}

function safeUpstreamMessage(text: string): string | undefined {
  try {
    return extractUpstreamError(JSON.parse(text)).message;
  } catch {
    return undefined;
  }
}

function safeTaskId(value: string) {
  const taskId = value.trim();
  if (!taskId || taskId.length > 256 || /[\u0000-\u001f]/.test(taskId))
    throw new Error("Invalid generation task id");
  return taskId;
}

function referenceLabel(kind: GenerationReferenceKind) {
  if (kind === "image") return "图片";
  if (kind === "video") return "视频";
  return "音频";
}

function rejected(code: string, message: string) {
  return new GenerationProviderError(code, message, "rejected");
}

async function readLimitedResponse(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  ).toString("utf8");
}
