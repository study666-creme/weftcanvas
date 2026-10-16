import type { CanvasImportProvider } from "@weftcanvas/contracts";

import { isAllowedMediaHost } from "./reference.js";

/**
 * 第三方画布 → 中间表示的适配层：纯函数，输入是对方接口返回的 JSON，
 * 输出是画布能直接落地的节点/连线草稿。三个来源各写一个函数，共享下面这组
 * 宽容读取器与边界检查。
 *
 * 三条贯穿原则：
 * 1. **不可信输入**：坐标、尺寸、URL 全部校验，坏数据跳过并说明原因，不猜。
 * 2. **不伪装**：对方没出结果的节点如实标 idle，失败的标 error，素材拿不到
 *    就退化成占位节点，绝不编造素材。
 * 3. **素材域名白名单**：只有对方已核验的媒体域才允许代拉；其余地址整条丢弃。
 */
export type CanvasImportDraftAsset = {
  /** 上游 https 直链：只在服务端进程内流转，永不回给浏览器。 */
  url: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
};

export type CanvasImportDraftNode = {
  key: string;
  kind: "text" | "image" | "video" | "audio";
  title: string;
  body: string;
  prompt: string;
  model: string;
  position: { x: number; y: number };
  width: number;
  height: number;
  status: "idle" | "success" | "error";
  error: string;
  sourceType: string;
  asset: CanvasImportDraftAsset | null;
};

export type CanvasImportDraftEdge = {
  key: string;
  source: string;
  target: string;
};

export type CanvasImportNote = { id: string; message: string };

export type CanvasImportDraft = {
  /** 节点 key 的前缀，前端用它识别"同一次导入"。 */
  batchId: string;
  projectName: string;
  nodes: CanvasImportDraftNode[];
  edges: CanvasImportDraftEdge[];
  skipped: CanvasImportNote[];
  warnings: CanvasImportNote[];
};

export type CanvasImportAdapterOptions = {
  /** 来源画布标识（已由 reference.ts 解析并校验）。 */
  sourceId: string;
  now: number;
  createId: () => string;
};

/** 契约上限：超出部分截断并记一条提醒，不静默丢弃。 */
export const CANVAS_IMPORT_MAX_NODES = 500;
export const CANVAS_IMPORT_MAX_EDGES = 2_000;
export const CANVAS_IMPORT_MAX_SKIPPED = 200;
export const CANVAS_IMPORT_MAX_WARNINGS = 200;
const CANVAS_IMPORT_DEFAULT_SIZE = { width: 480, height: 300 } as const;

export class CanvasImportError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 413 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CanvasImportError";
  }
}

export function canvasImportBatchId(
  provider: CanvasImportProvider,
  options: CanvasImportAdapterOptions,
) {
  return `${provider}-${options.now.toString(36)}-${options.createId().replace(/-/g, "").slice(0, 8)}`;
}

// —— 宽容读取器 ————————————————————————————————————————————————

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** 解析成对象；字符串是对方常见的"JSON 塞在字符串里"写法，再解一层。 */
function decodeRecord(value: unknown, depth = 0): Record<string, unknown> | null {
  const direct = asRecord(value);
  if (direct) return direct;
  if (depth >= 2 || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return asRecord(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

function readString(source: Record<string, unknown> | null, ...keys: string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return "";
}

function readNumber(source: Record<string, unknown> | null, ...keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function readPositive(source: Record<string, unknown> | null, ...keys: string[]): number | null {
  const value = readNumber(source, ...keys);
  return value !== null && value > 0 ? value : null;
}

/** 尺寸字段在不同来源里是对象、数组或单值，逐种形态读，读不到就用默认尺寸。 */
function readSize(value: unknown): { width: number; height: number } | null {
  if (Array.isArray(value) && value.length >= 2) {
    const width = Number(value[0]);
    const height = Number(value[1]);
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)
      return { width, height };
    return null;
  }
  const record = asRecord(value);
  if (record) {
    const width = readPositive(record, "width", "w");
    const height = readPositive(record, "height", "h");
    if (width && height) return { width, height };
    return null;
  }
  const square = typeof value === "number" && Number.isFinite(value) ? value : null;
  return square && square > 0 ? { width: square, height: square } : null;
}

function clampDimension(value: number | null): number {
  if (value === null || !Number.isFinite(value) || value <= 0) return 0;
  return Math.round(Math.min(value, 4_096));
}

/** 只有 https、无凭据、且域名在白名单里的素材地址才被接受。 */
function readMediaUrl(
  provider: CanvasImportProvider,
  values: unknown[],
): { url: string; index: number } | null {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (typeof value !== "string" || !value.trim()) continue;
    let parsed: URL;
    try {
      parsed = new URL(value.trim());
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
    if (!isAllowedMediaHost(provider, parsed.hostname)) continue;
    return { url: parsed.toString(), index };
  }
  return null;
}

function inferMime(kind: string, url: string, hint = ""): string {
  const lower = `${url} ${hint}`.toLowerCase();
  if (kind === "image") {
    if (lower.includes(".png")) return "image/png";
    if (lower.includes(".jpg") || lower.includes(".jpeg")) return "image/jpeg";
    if (lower.includes(".webp")) return "image/webp";
    if (lower.includes(".gif")) return "image/gif";
    return "image/png";
  }
  if (kind === "video") {
    if (lower.includes(".webm")) return "video/webm";
    if (lower.includes(".mov")) return "video/quicktime";
    return "video/mp4";
  }
  if (kind === "audio") {
    if (lower.includes(".wav")) return "audio/wav";
    if (lower.includes(".flac")) return "audio/flac";
    if (lower.includes(".ogg") || lower.includes(".oga")) return "audio/ogg";
    if (lower.includes(".m4a")) return "audio/mp4";
    return "audio/mpeg";
  }
  return "text/plain";
}

function pushNote(list: CanvasImportNote[], note: CanvasImportNote, limit: number) {
  if (list.length < limit) list.push(note);
}

function bounded(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

// —— LibTV ————————————————————————————————————————————————————

const LIBTV_FAILED_TASK_STATUS = 3;

/**
 * LibTV 画布详情。`nodeList[].data` 是 JSON 字符串，`position`/`measured` 里的
 * 数值是字符串；`material-style` 没有生成结果但通常有封面，降级成图片参考节点。
 */
export function adaptLibTVCanvas(
  raw: unknown,
  options: CanvasImportAdapterOptions,
): CanvasImportDraft {
  const detail = asRecord(raw);
  if (!detail) throw new CanvasImportError(503, "IMPORT_SOURCE_INVALID", "LibTV 画布数据格式无效");
  const meta = asRecord(detail.projectMeta);
  const effective = asRecord(meta?.effective);
  if (effective && (effective.canRead === false || effective.canCopy === false)) {
    throw new CanvasImportError(400, "IMPORT_NOT_COPYABLE", "这个 LibTV 画布不允许复制");
  }
  const batchId = canvasImportBatchId("libtv", options);
  const draft: CanvasImportDraft = {
    batchId,
    projectName: bounded(readString(meta, "name"), 200),
    nodes: [],
    edges: [],
    skipped: [],
    warnings: [],
  };
  const nodeList = asArray(detail.nodeList);
  const seen = new Set<string>();
  const mapping = new Map<string, string>();

  for (const entry of nodeList) {
    const rawNode = asRecord(entry);
    if (!rawNode) continue;
    const nodeKey = readString(rawNode, "nodeKey");
    const name = readString(rawNode, "name");
    if (!nodeKey) {
      pushNote(
        draft.skipped,
        { id: "", message: `LibTV 节点「${name || "未命名"}」缺少 nodeKey，已跳过` },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    if (seen.has(nodeKey)) {
      pushNote(
        draft.skipped,
        { id: nodeKey, message: "LibTV 节点标识重复，已跳过" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    seen.add(nodeKey);

    const data = decodeRecord(rawNode.data);
    if (!data) {
      pushNote(
        draft.skipped,
        { id: nodeKey, message: `LibTV 节点「${name || nodeKey}」数据无法解析，已跳过` },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    const sourceType = readString(data, "type").toLowerCase();
    const kind =
      sourceType === "material-style"
        ? "image"
        : sourceType === "image" || sourceType === "video"
          ? sourceType
          : "";
    if (!kind) {
      pushNote(
        draft.skipped,
        { id: nodeKey, message: `LibTV ${sourceType || "未知"} 节点暂不支持导入，已跳过` },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }

    const position = readPosition(rawNode.position, "positionX", "positionY");
    if (!position) {
      pushNote(
        draft.skipped,
        { id: nodeKey, message: `LibTV 节点「${name || nodeKey}」坐标无效，已跳过` },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }

    const urls = asArray(data.url).filter((item): item is string => typeof item === "string");
    const mediaCandidates =
      sourceType === "material-style" ? [readString(data, "coverUrl"), ...urls] : urls;
    const media = readMediaUrl("libtv", mediaCandidates);
    const resourceMeta = asRecord(data.ResourceMeta) ?? asRecord(data._resourceMeta);
    const resources = asArray(resourceMeta?.items);
    const resource = asRecord(resources[media?.index ?? 0]);
    const measured = readMeasured(rawNode.measured);
    // 任务态在节点数据与节点记录里各有一份：数据里的 status 为 0 表示没写，
    // 这时才回落到节点记录的那份。
    const dataTaskInfo = asRecord(data.taskInfo);
    const rawTaskInfo = asRecord(rawNode.taskInfo);
    const dataTaskStatus = readNumber(dataTaskInfo, "status") ?? 0;
    const taskStatus =
      dataTaskStatus !== 0 ? dataTaskStatus : (readNumber(rawTaskInfo, "status") ?? 0);
    const failedReason =
      readString(dataTaskInfo, "failedReason") || readString(rawTaskInfo, "failedReason");
    const stale = data.isStale === true || rawNode.isStale === true;
    // key 用来源画布内的标识（不加批次前缀）：重复导入时能认出同一个来源节点。
    const nodeKeyId = nodeKey;
    let status: CanvasImportDraftNode["status"] = "idle";
    let error = "";
    if (media) {
      // 最近一次任务失败不等于节点里的历史结果不可用。
      status = "success";
      if (taskStatus === LIBTV_FAILED_TASK_STATUS)
        pushNote(
          draft.warnings,
          {
            id: nodeKeyId,
            message: `LibTV 节点「${name || nodeKey}」最近一次任务失败，已导入节点中现存的结果`,
          },
          CANVAS_IMPORT_MAX_WARNINGS,
        );
    } else if (taskStatus === LIBTV_FAILED_TASK_STATUS) {
      status = "error";
      error = bounded(failedReason || "LibTV 生成任务失败", 2_000);
    }

    const naturalWidth = readPositive(resource, "width");
    const naturalHeight = readPositive(resource, "height");
    const durationSec = readNumber(resource, "durationSec");

    draft.nodes.push({
      key: nodeKeyId,
      kind,
      title: bounded(name, 200) || `${kind === "video" ? "视频" : "图片"}节点`,
      body: "",
      prompt: bounded(readString(data.params ? asRecord(data.params) : null, "prompt"), 8_000),
      model: bounded(readString(data.params ? asRecord(data.params) : null, "model"), 200),
      position,
      width: clampDimension(measured?.width ?? null) || CANVAS_IMPORT_DEFAULT_SIZE.width,
      height: clampDimension(measured?.height ?? null) || CANVAS_IMPORT_DEFAULT_SIZE.height,
      status,
      error,
      sourceType: bounded(sourceType, 64),
      asset: media
        ? {
            url: media.url,
            mimeType: inferMime(kind, media.url),
            width: naturalWidth ? Math.round(naturalWidth) : null,
            height: naturalHeight ? Math.round(naturalHeight) : null,
            durationMs: durationSec && durationSec > 0 ? Math.round(durationSec * 1_000) : null,
          }
        : null,
    });
    mapping.set(nodeKey, nodeKeyId);
    if (mediaCandidates.length > 1 && media) {
      pushNote(
        draft.warnings,
        {
          id: nodeKeyId,
          message: `LibTV 节点「${name || nodeKey}」有多个结果，已取第 ${(media.index ?? 0) + 1} 个`,
        },
        CANVAS_IMPORT_MAX_WARNINGS,
      );
    }
    if (stale) {
      pushNote(
        draft.warnings,
        {
          id: nodeKeyId,
          message: `LibTV 节点「${name || nodeKey}」已被标记为过期，现存素材仍会导入`,
        },
        CANVAS_IMPORT_MAX_WARNINGS,
      );
    }
    if (sourceType === "material-style") {
      pushNote(
        draft.warnings,
        { id: nodeKeyId, message: `LibTV 风格素材「${name || nodeKey}」已按图片参考节点导入` },
        CANVAS_IMPORT_MAX_WARNINGS,
      );
    }
  }

  appendConnections(
    draft,
    asArray(detail.connectionList),
    (raw) => {
      const record = asRecord(raw);
      return record
        ? {
            id: readString(record, "connectionId"),
            source: readString(record, "source"),
            target: readString(record, "target"),
          }
        : null;
    },
    mapping,
  );
  return requireImportableNodes(draft, "LibTV");
}

// —— TapNow ——————————————————————————————————————————————————

const TAPNOW_FAILED_STATUSES = new Set(["failed", "error", "failure"]);

/** TapNow 分享画布。`data` 里文本节点带 text/prompt，媒体节点带 src/options。 */
export function adaptTapNowCanvas(
  raw: unknown,
  options: CanvasImportAdapterOptions,
): CanvasImportDraft {
  const detail = asRecord(raw);
  if (!detail) throw new CanvasImportError(503, "IMPORT_SOURCE_INVALID", "TapNow 画布数据格式无效");
  const batchId = canvasImportBatchId("tapnow", options);
  const draft: CanvasImportDraft = {
    batchId,
    projectName: bounded(readString(detail, "name"), 200) || "TapNow 画布",
    nodes: [],
    edges: [],
    skipped: [],
    warnings: [],
  };
  const seen = new Set<string>();
  const mapping = new Map<string, string>();

  for (const entry of asArray(detail.nodes)) {
    const rawNode = asRecord(entry);
    if (!rawNode) continue;
    if (readString(rawNode, "deleted_at")) continue;
    const shortId = readNumber(rawNode, "short_id");
    const nodeId = readString(rawNode, "id") || (shortId !== null ? String(shortId) : "");
    if (!nodeId) {
      pushNote(
        draft.skipped,
        { id: "", message: "TapNow 节点缺少标识，已跳过" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    if (seen.has(nodeId)) {
      pushNote(
        draft.skipped,
        { id: nodeId, message: "TapNow 节点标识重复，已跳过" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    seen.add(nodeId);

    const data = decodeRecord(rawNode.data);
    if (!data) {
      pushNote(
        draft.skipped,
        { id: nodeId, message: "TapNow 节点数据无法解析，已跳过" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    const kind =
      readString(rawNode, "type").toLowerCase() || readString(data, "type").toLowerCase();
    if (!["image", "video", "audio", "text"].includes(kind)) {
      pushNote(
        draft.skipped,
        { id: nodeId, message: `TapNow ${kind || "未知"} 节点暂不支持导入，已跳过` },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    const position = readPosition(rawNode.position, "x", "y");
    if (!position) {
      pushNote(
        draft.skipped,
        {
          id: nodeId,
          message: `TapNow 节点「${readString(data, "title") || nodeId}」坐标无效，已跳过`,
        },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    const title = bounded(readString(data, "title"), 200);
    const prompt = bounded(readString(data, "prompt"), 8_000);
    const params = asRecord(data.params);
    const metadata = asRecord(data.__metadata);
    const options = asArray(data.options).filter(
      (item): item is string => typeof item === "string",
    );
    const media = readMediaUrl("tapnow", [
      readString(data, "src"),
      ...options,
      readString(metadata, "url"),
    ]);
    const text = readString(data, "text") || prompt;
    const measured = readMeasured(rawNode.measured);
    const taskInfo = asRecord(data.taskInfo);
    const taskStatus = readString(taskInfo, "status").toLowerCase();
    const failed = TAPNOW_FAILED_STATUSES.has(taskStatus);
    // key 用来源画布内的标识（不加批次前缀）：重复导入时能认出同一个来源节点。
    const nodeKeyId = nodeId;

    let status: CanvasImportDraftNode["status"] = "idle";
    let error = "";
    if (kind === "text") {
      status = "success";
    } else if (media) {
      status = "success";
      if (failed)
        pushNote(
          draft.warnings,
          {
            id: nodeKeyId,
            message: `TapNow 节点「${title || nodeId}」最近一次任务失败，已导入节点中现存的结果`,
          },
          CANVAS_IMPORT_MAX_WARNINGS,
        );
    } else if (failed) {
      status = "error";
      error = bounded(
        readString(data, "error") ||
          readString(data, "failedReason") ||
          readString(taskInfo, "error") ||
          readString(taskInfo, "failedReason") ||
          readString(taskInfo, "message") ||
          "TapNow 生成任务失败",
        2_000,
      );
    }

    draft.nodes.push({
      key: nodeKeyId,
      kind: kind as CanvasImportDraftNode["kind"],
      title: title || `${kind} 节点`,
      body: kind === "text" ? bounded(text, 20_000) : "",
      prompt,
      model: bounded(readString(params, "model"), 200),
      position,
      width: clampDimension(measured?.width ?? null) || CANVAS_IMPORT_DEFAULT_SIZE.width,
      height: clampDimension(measured?.height ?? null) || CANVAS_IMPORT_DEFAULT_SIZE.height,
      status,
      error,
      sourceType: bounded(readString(data, "type") || kind, 64),
      asset: media
        ? {
            url: media.url,
            mimeType: inferMime(kind, media.url, `${prompt} ${title}`),
            width: naturalInteger(metadata, "width"),
            height: naturalInteger(metadata, "height"),
            durationMs: durationFromMetadata(readNumber(metadata, "duration")),
          }
        : null,
    });
    mapping.set(nodeId, nodeKeyId);
    if (shortId !== null) mapping.set(String(shortId), nodeKeyId);
    if (!measured) {
      pushNote(
        draft.warnings,
        { id: nodeKeyId, message: `TapNow 节点「${title || nodeId}」尺寸无效，已使用默认尺寸` },
        CANVAS_IMPORT_MAX_WARNINGS,
      );
    }
    if (options.length > 1 && media) {
      pushNote(
        draft.warnings,
        {
          id: nodeKeyId,
          message: `TapNow 节点「${title || nodeId}」有多个结果，已取第 ${(media.index ?? 0) + 1} 个`,
        },
        CANVAS_IMPORT_MAX_WARNINGS,
      );
    }
  }

  appendConnections(
    draft,
    asArray(detail.connections),
    (raw) => {
      const record = asRecord(raw);
      if (!record) return null;
      if (readString(record, "deleted_at")) return null;
      return {
        id: readString(record, "id"),
        source: readString(record, "source"),
        target: readString(record, "target"),
      };
    },
    mapping,
  );
  return requireImportableNodes(draft, "TapNow");
}

// —— UpDream ————————————————————————————————————————————————

/**
 * UpDream 分享口令的载荷：`{type:"canvas-nodes", nodes:[…], connections:[…]}`，
 * 过期口令返回 `{expired:true}`。字段名取自对方前端自己的校验器：
 * 节点有 node_type/x/y/size/cover_url/video_url/task_status，连线用
 * from_node_id/to_node_id。对方的私有字段（node_config、agent 相关）一律不读。
 */
export function adaptUpDreamShare(
  raw: unknown,
  options: CanvasImportAdapterOptions,
): CanvasImportDraft {
  const payload = asRecord(raw);
  if (!payload)
    throw new CanvasImportError(503, "IMPORT_SOURCE_INVALID", "UpDream 分享数据格式无效");
  if (payload.expired === true) {
    throw new CanvasImportError(
      400,
      "IMPORT_SHARE_EXPIRED",
      "这个 UpDream 分享口令已过期，请在 UpDream 里重新分享",
    );
  }
  const type = readString(payload, "type");
  if (type && type !== "canvas-nodes") {
    throw new CanvasImportError(
      400,
      "IMPORT_SHARE_UNSUPPORTED",
      "这个 UpDream 分享口令不是画布节点，暂时无法导入",
    );
  }
  const batchId = canvasImportBatchId("updream", options);
  const draft: CanvasImportDraft = {
    batchId,
    projectName: bounded(readString(payload, "name", "title"), 200) || "UpDream 画布",
    nodes: [],
    edges: [],
    skipped: [],
    warnings: [],
  };
  const seen = new Set<string>();
  const mapping = new Map<string, string>();

  for (const entry of asArray(payload.nodes)) {
    const rawNode = asRecord(entry);
    if (!rawNode) continue;
    if (rawNode.is_deleted === true) continue;
    const nodeId = readString(rawNode, "id");
    if (!nodeId) {
      pushNote(
        draft.skipped,
        { id: "", message: "UpDream 节点缺少标识，已跳过" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    if (seen.has(nodeId)) {
      pushNote(
        draft.skipped,
        { id: nodeId, message: "UpDream 节点标识重复，已跳过" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    seen.add(nodeId);

    const sourceType = readString(rawNode, "node_type", "nodeType", "type").toLowerCase();
    const kind = ["image", "video", "audio", "text"].includes(sourceType) ? sourceType : "";
    if (!kind) {
      pushNote(
        draft.skipped,
        { id: nodeId, message: `UpDream ${sourceType || "未知"} 节点暂不支持导入，已跳过` },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    const position = readPosition(rawNode, "x", "y");
    if (!position) {
      pushNote(
        draft.skipped,
        {
          id: nodeId,
          message: `UpDream 节点「${readString(rawNode, "name") || nodeId}」坐标无效，已跳过`,
        },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    const nodeConfig = asRecord(rawNode.node_config);
    const title = bounded(readString(rawNode, "name", "title"), 200);
    const prompt = bounded(
      readString(rawNode, "prompt") || readString(nodeConfig, "prompt"),
      8_000,
    );
    const text = readString(rawNode, "text", "content") || readString(nodeConfig, "text");
    const media = readMediaUrl("updream", [
      readString(rawNode, "video_url", "videoUrl"),
      readString(rawNode, "cover_url", "coverUrl"),
      readString(rawNode, "url"),
      readString(rawNode, "image_url", "imageUrl"),
    ]);
    const size = readSize(rawNode.size) ?? readSize(nodeConfig?.size);
    const taskStatus = readString(rawNode, "task_status", "taskStatus").toLowerCase();
    // 对方的任务态命名只在"失败"这一侧收敛过：任何含 fail/error 的取值都按下标 error 处理。
    const failed = /fail|error|invalid/.test(taskStatus);
    // key 用来源画布内的标识（不加批次前缀）：重复导入时能认出同一个来源节点。
    const nodeKeyId = nodeId;
    let status: CanvasImportDraftNode["status"] = "idle";
    let error = "";
    if (kind === "text") {
      status = "success";
    } else if (media) {
      status = "success";
      if (failed)
        pushNote(
          draft.warnings,
          {
            id: nodeKeyId,
            message: `UpDream 节点「${title || nodeId}」最近一次任务失败，已导入节点中现存的结果`,
          },
          CANVAS_IMPORT_MAX_WARNINGS,
        );
    } else if (failed) {
      status = "error";
      error = bounded(
        readString(rawNode, "error", "failed_reason", "failedReason") || "UpDream 生成任务失败",
        2_000,
      );
    }

    draft.nodes.push({
      key: nodeKeyId,
      kind: kind as CanvasImportDraftNode["kind"],
      title: title || `${kind} 节点`,
      body: kind === "text" ? bounded(text || prompt, 20_000) : "",
      prompt,
      model: bounded(readString(rawNode, "model"), 200),
      position,
      width: clampDimension(size?.width ?? null) || CANVAS_IMPORT_DEFAULT_SIZE.width,
      height: clampDimension(size?.height ?? null) || CANVAS_IMPORT_DEFAULT_SIZE.height,
      status,
      error,
      sourceType: bounded(sourceType, 64),
      asset: media
        ? {
            url: media.url,
            mimeType: inferMime(kind, media.url),
            width: null,
            height: null,
            durationMs: null,
          }
        : null,
    });
    mapping.set(nodeId, nodeKeyId);
    if (!media && kind !== "text") {
      pushNote(
        draft.warnings,
        {
          id: nodeKeyId,
          message: `UpDream 节点「${title || nodeId}」没有可导入的素材，已作为占位节点保留`,
        },
        CANVAS_IMPORT_MAX_WARNINGS,
      );
    }
  }

  appendConnections(
    draft,
    asArray(payload.connections),
    (raw) => {
      const record = asRecord(raw);
      if (!record) return null;
      if (record.is_deleted === true) return null;
      return {
        id:
          readString(record, "id") ||
          `${readString(record, "from_node_id")}-${readString(record, "to_node_id")}`,
        source: readString(record, "from_node_id", "fromNodeId", "source"),
        target: readString(record, "to_node_id", "toNodeId", "target"),
      };
    },
    mapping,
  );
  return requireImportableNodes(draft, "UpDream");
}

// —— 共享收尾 ————————————————————————————————————————————————

function readPosition(value: unknown, xKey: string, yKey: string): { x: number; y: number } | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = record[xKey] ?? record.x;
  const y = record[yKey] ?? record.y;
  const parsedX = typeof x === "string" ? Number(x.trim()) : x;
  const parsedY = typeof y === "string" ? Number(y.trim()) : y;
  if (typeof parsedX !== "number" || !Number.isFinite(parsedX)) return null;
  if (typeof parsedY !== "number" || !Number.isFinite(parsedY)) return null;
  return { x: parsedX, y: parsedY };
}

/** measured 的宽高在 LibTV/TapNow 是数字也可能缺省；两个都读到正数才算有效。 */
function readMeasured(value: unknown) {
  const record = asRecord(value);
  if (!record) return null;
  const width = readPositive(record, "width") ?? readNumber(record, "width");
  const height = readPositive(record, "height") ?? readNumber(record, "height");
  if (width === null || height === null) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

function naturalInteger(record: Record<string, unknown> | null, key: string): number | null {
  const value = readPositive(record, key);
  return value ? Math.round(value) : null;
}

function durationFromMetadata(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1_000);
}

/** 连线端点必须两边都导入了才保留；单边悬空的连线丢掉并说明原因。 */
function appendConnections(
  draft: CanvasImportDraft,
  rawConnections: unknown[],
  read: (raw: unknown) => { id: string; source: string; target: string } | null,
  mapping: Map<string, string>,
) {
  const seen = new Set<string>();
  for (const raw of rawConnections) {
    const connection = read(raw);
    if (!connection) continue;
    const { id, source, target } = connection;
    if (!id) {
      pushNote(
        draft.skipped,
        { id: "", message: "连线缺少标识，已跳过" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    const from = mapping.get(source);
    const to = mapping.get(target);
    if (!from || !to) {
      pushNote(
        draft.skipped,
        { id, message: "连线的端点节点没有导入，已跳过该连线" },
        CANVAS_IMPORT_MAX_SKIPPED,
      );
      continue;
    }
    if (draft.edges.length >= CANVAS_IMPORT_MAX_EDGES) {
      pushNote(
        draft.warnings,
        { id: "", message: `连线超过 ${CANVAS_IMPORT_MAX_EDGES} 条，其余已忽略` },
        CANVAS_IMPORT_MAX_WARNINGS,
      );
      break;
    }
    draft.edges.push({ key: id, source: from, target: to });
  }
}

function requireImportableNodes(draft: CanvasImportDraft, label: string): CanvasImportDraft {
  if (draft.nodes.length === 0) {
    throw new CanvasImportError(422, "IMPORT_SOURCE_EMPTY", `${label} 画布里没有可导入的节点`);
  }
  if (draft.nodes.length > CANVAS_IMPORT_MAX_NODES) {
    draft.warnings.push({
      id: "",
      message: `节点超过 ${CANVAS_IMPORT_MAX_NODES} 个，只导入前 ${CANVAS_IMPORT_MAX_NODES} 个`,
    });
    const allowed = new Set(draft.nodes.slice(0, CANVAS_IMPORT_MAX_NODES).map((node) => node.key));
    draft.nodes = draft.nodes.slice(0, CANVAS_IMPORT_MAX_NODES);
    draft.edges = draft.edges.filter(
      (edge) => allowed.has(edge.source) && allowed.has(edge.target),
    );
  }
  return draft;
}
