import {
  mediaKindSchema,
  referenceImagePurposeSchema,
  type MediaKind,
  type ReferenceImagePurpose,
} from "@weftcanvas/contracts";
import { createRequestKey, mediaContentPath } from "./api-client";
import type { DirectModalityKey, DirectReference } from "../state/direct-reference-store";

// 画布工作台上传素材的标签页会话存储。
// sessionStorage 按标签页隔离：刷新页面与同标签页的全页跳转都会保留，
// 关闭标签页或新开标签页则自然消失，与“只有手动删除或离开工作台才消失”一致。
export const DIRECT_REFERENCE_SESSION_KEY = "weftcanvas:direct-reference-session:v1";
export const DIRECT_DRAFT_SESSION_KEY = "weftcanvas:direct-draft-session:v1";
// v2: 素材带上 durationMs（H3 要求参考视频成对声明时长）。v1 会话照样恢复，
// 只是时长列为 null，由工作台补查一次素材元数据，缺字段不会让恢复失败。
const REFERENCE_SESSION_SCHEMA_VERSION = 2;
const SUPPORTED_SESSION_SCHEMA_VERSIONS: readonly number[] = [1, 2];
// 草稿会话 schema 独立：本次只动了素材结构，草稿仍是 v1，不借共享版本号升级。
const DRAFT_SESSION_SCHEMA_VERSION = 1;
// 每个模态最多恢复 64 条，防止异常数据无限膨胀存储。
const MAX_PERSISTED_REFERENCES = 64;

const MEDIA_KINDS: readonly MediaKind[] = mediaKindSchema.options;
const IMAGE_PURPOSES: readonly ReferenceImagePurpose[] = referenceImagePurposeSchema.options;

// 持久化只保留“已就绪且有服务端 id”的素材：blob 预览地址在刷新后失效，
// 服务端 id 才是跨页面可靠的引用。恢复时用服务端内容路径重建预览。
export type PersistedDirectReference = {
  id: string;
  kind: MediaKind;
  name: string;
  serverId: string;
  imagePurpose: ReferenceImagePurpose | null;
  durationMs: number | null;
};

export type PersistedDirectReferenceSession = {
  schemaVersion: number;
  image: PersistedDirectReference[];
  video: PersistedDirectReference[];
  audio: PersistedDirectReference[];
};

export function isDirectGenerationPath(pathname: string): boolean {
  return pathname === "/generate" || pathname.startsWith("/generate/");
}

export function readDirectReferenceSession(): PersistedDirectReferenceSession | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(DIRECT_REFERENCE_SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (!SUPPORTED_SESSION_SCHEMA_VERSIONS.includes(record.schemaVersion as number)) return null;
    return {
      schemaVersion: REFERENCE_SESSION_SCHEMA_VERSION,
      image: normalizePersistedReferences(record.image),
      video: normalizePersistedReferences(record.video),
      audio: normalizePersistedReferences(record.audio),
    };
  } catch {
    return null;
  }
}

export function writeDirectReferenceSession(
  references: Record<DirectModalityKey, DirectReference[]>,
): void {
  const storage = getSessionStorage();
  if (!storage) return;
  const session: PersistedDirectReferenceSession = {
    schemaVersion: REFERENCE_SESSION_SCHEMA_VERSION,
    image: persistReferences(references.image),
    video: persistReferences(references.video),
    audio: persistReferences(references.audio),
  };
  if (!session.image.length && !session.video.length && !session.audio.length) {
    clearDirectReferenceSession();
    return;
  }
  try {
    storage.setItem(DIRECT_REFERENCE_SESSION_KEY, JSON.stringify(session));
  } catch {
    // 存储不可用（隐私模式/配额）时保持内存行为，不影响本次页面会话。
  }
}

export function clearDirectReferenceSession(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(DIRECT_REFERENCE_SESSION_KEY);
  } catch {
    // ignore
  }
}

// 恢复为内存态引用：预览指向服务端内容路径，状态置为已就绪，重新生成上传幂等键。
export function restoreDirectReferenceSession(): Record<DirectModalityKey, DirectReference[]> {
  const session = readDirectReferenceSession();
  if (!session) return { image: [], video: [], audio: [] };
  return {
    image: restoreReferences(session.image),
    video: restoreReferences(session.video),
    audio: restoreReferences(session.audio),
  };
}

// 模块初始化入口：在生成工作台内恢复已持久化的素材；在任意其他路径
// （返回首页、打开画布、地址栏直达等）视为已离开工作台，立即清空会话。
// pathname 供测试注入；缺省时读取当前页面路径。
export function initialDirectReferenceSession(
  pathname?: string,
): Record<DirectModalityKey, DirectReference[]> {
  const currentPathname =
    pathname ?? (typeof window === "undefined" ? "" : window.location.pathname);
  if (isDirectGenerationPath(currentPathname)) {
    return restoreDirectReferenceSession();
  }
  clearDirectReferenceSession();
  return { image: [], video: [], audio: [] };
}

function persistReferences(items: DirectReference[]): PersistedDirectReference[] {
  return items
    .filter(
      (item): item is DirectReference & { serverId: string } =>
        item.status === "ready" && item.serverId !== null && item.serverId.length > 0,
    )
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      name: item.name,
      serverId: item.serverId,
      imagePurpose: item.kind === "image" ? item.imagePurpose : null,
      durationMs: item.kind === "image" ? null : (item.durationMs ?? null),
    }))
    .slice(0, MAX_PERSISTED_REFERENCES);
}

function normalizePersistedReferences(value: unknown): PersistedDirectReference[] {
  if (!Array.isArray(value)) return [];
  const references: PersistedDirectReference[] = [];
  for (const entry of value.slice(0, MAX_PERSISTED_REFERENCES)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id) continue;
    if (typeof record.name !== "string" || !record.name) continue;
    if (typeof record.serverId !== "string" || !record.serverId) continue;
    if (!MEDIA_KINDS.includes(record.kind as MediaKind)) continue;
    const kind = record.kind as MediaKind;
    let imagePurpose: ReferenceImagePurpose | null = null;
    if (kind === "image" && (record.imagePurpose === null || record.imagePurpose === undefined)) {
      imagePurpose = null;
    } else if (
      kind === "image" &&
      IMAGE_PURPOSES.includes(record.imagePurpose as ReferenceImagePurpose)
    ) {
      imagePurpose = record.imagePurpose as ReferenceImagePurpose;
    }
    references.push({
      id: record.id,
      kind,
      name: record.name.slice(0, 255),
      serverId: record.serverId,
      imagePurpose,
      // v1 会话没有这个字段；图片也没有时长。缺失一律按 null 交给工作台补查。
      durationMs:
        kind !== "image" &&
        typeof record.durationMs === "number" &&
        Number.isFinite(record.durationMs) &&
        record.durationMs > 0
          ? Math.round(record.durationMs)
          : null,
    });
  }
  return references;
}

function restoreReferences(items: PersistedDirectReference[]): DirectReference[] {
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    name: item.name,
    previewUrl: mediaContentPath(item.serverId),
    serverId: item.serverId,
    status: "ready",
    error: null,
    uploadKey: createRequestKey("restored-session"),
    imagePurpose: item.imagePurpose,
    durationMs: item.kind === "image" ? null : item.durationMs,
  }));
}

function getSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 草稿会话：提示词 / 模型 / 模型参数 / 数量 / 输出上限。
// 与素材会话同一个标签页生命周期：刷新与提交后保留，离开工作台清空。
// 只持久化 JSON 可序列化的基础值；恢复时按当前目录重新校验（模型不存在
// 时由目录 reconcile 回退到默认模型）。
// ---------------------------------------------------------------------------

export type PersistedDirectDraft = {
  prompt: string;
  modelId: string;
  parameters: Record<string, unknown>;
  quantity: number;
  maxOutputTokens: number | null;
};

export type PersistedDirectDraftSession = {
  schemaVersion: 1;
  image: PersistedDirectDraft | null;
  video: PersistedDirectDraft | null;
  audio: PersistedDirectDraft | null;
};

const MAX_DRAFT_PROMPT_LENGTH = 4_000;
const MAX_DRAFT_PARAMETER_KEYS = 128;
const MAX_DRAFT_QUANTITY = 99;
const MAX_DRAFT_TOKENS = 32_768;

export function readDirectDraftSession(): PersistedDirectDraftSession | null {
  const storage = getSessionStorage();
  if (!storage) return null;
  let raw: string | null = null;
  try {
    raw = storage.getItem(DIRECT_DRAFT_SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== DRAFT_SESSION_SCHEMA_VERSION) return null;
    return {
      schemaVersion: DRAFT_SESSION_SCHEMA_VERSION,
      image: normalizePersistedDraft(record.image),
      video: normalizePersistedDraft(record.video),
      audio: normalizePersistedDraft(record.audio),
    };
  } catch {
    return null;
  }
}

export function writeDirectDraftSession(
  drafts: Record<DirectModalityKey, PersistedDirectDraft | null>,
): void {
  const storage = getSessionStorage();
  if (!storage) return;
  const session: PersistedDirectDraftSession = {
    schemaVersion: DRAFT_SESSION_SCHEMA_VERSION,
    image: isEmptyDraft(drafts.image) ? null : drafts.image,
    video: isEmptyDraft(drafts.video) ? null : drafts.video,
    audio: isEmptyDraft(drafts.audio) ? null : drafts.audio,
  };
  if (!session.image && !session.video && !session.audio) {
    clearDirectDraftSession();
    return;
  }
  try {
    storage.setItem(DIRECT_DRAFT_SESSION_KEY, JSON.stringify(session));
  } catch {
    // 存储不可用（隐私模式/配额）时保持内存行为，不影响本次页面会话。
  }
}

export function clearDirectDraftSession(): void {
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(DIRECT_DRAFT_SESSION_KEY);
  } catch {
    // ignore
  }
}

// 模块初始化入口：与素材会话使用同一路径判定——在生成工作台内恢复，
// 在其他任何路径（返回首页、打开画布、地址栏直达等）立即清空。
// 始终返回会话对象（空会话 = 两个模态均为 null），避免调用方处理 null。
export function initialDirectDraftSession(pathname?: string): PersistedDirectDraftSession {
  const currentPathname =
    pathname ?? (typeof window === "undefined" ? "" : window.location.pathname);
  if (isDirectGenerationPath(currentPathname)) {
    return (
      readDirectDraftSession() ?? {
        schemaVersion: DRAFT_SESSION_SCHEMA_VERSION,
        image: null,
        video: null,
        audio: null,
      }
    );
  }
  clearDirectDraftSession();
  return {
    schemaVersion: DRAFT_SESSION_SCHEMA_VERSION,
    image: null,
    video: null,
    audio: null,
  };
}

export function persistDirectDraft(draft: {
  prompt: string;
  modelId: string;
  parameters: Record<string, unknown>;
  quantity: number;
  maxOutputTokens: number | null;
}): PersistedDirectDraft {
  return {
    prompt: typeof draft.prompt === "string" ? draft.prompt.slice(0, MAX_DRAFT_PROMPT_LENGTH) : "",
    modelId: typeof draft.modelId === "string" ? draft.modelId.slice(0, 255) : "",
    parameters: persistDraftParameters(draft.parameters),
    quantity: Number.isFinite(draft.quantity)
      ? Math.min(MAX_DRAFT_QUANTITY, Math.max(1, Math.round(draft.quantity)))
      : 1,
    maxOutputTokens:
      draft.maxOutputTokens === null || draft.maxOutputTokens === undefined
        ? null
        : Math.min(MAX_DRAFT_TOKENS, Math.max(1, Math.round(draft.maxOutputTokens))),
  };
}

export function restorePersistedDraft(
  draft: PersistedDirectDraft | null,
): PersistedDirectDraft | null {
  return draft
    ? {
        prompt: draft.prompt,
        modelId: draft.modelId,
        parameters: { ...draft.parameters },
        quantity: draft.quantity,
        maxOutputTokens: draft.maxOutputTokens,
      }
    : null;
}

function normalizePersistedDraft(value: unknown): PersistedDirectDraft | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const prompt =
    typeof record.prompt === "string" ? record.prompt.slice(0, MAX_DRAFT_PROMPT_LENGTH) : "";
  const modelId = typeof record.modelId === "string" ? record.modelId.slice(0, 255) : "";
  if (!prompt && !modelId) return null;
  return {
    prompt,
    modelId,
    parameters: persistDraftParameters(record.parameters),
    quantity: Number.isFinite(record.quantity)
      ? Math.min(MAX_DRAFT_QUANTITY, Math.max(1, Math.round(Number(record.quantity))))
      : 1,
    maxOutputTokens:
      record.maxOutputTokens === null || record.maxOutputTokens === undefined
        ? null
        : Math.min(MAX_DRAFT_TOKENS, Math.max(1, Math.round(Number(record.maxOutputTokens)))),
  };
}

function isEmptyDraft(draft: PersistedDirectDraft | null): boolean {
  return !draft || (!draft.prompt && !draft.modelId);
}

function persistDraftParameters(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") return {};
  const source = value as Record<string, unknown>;
  const parameters: Record<string, unknown> = {};
  let count = 0;
  for (const [key, entry] of Object.entries(source)) {
    if (count >= MAX_DRAFT_PARAMETER_KEYS) break;
    if (!key || key.length > 255) continue;
    if (typeof entry === "string") {
      parameters[key] = entry.slice(0, 2_000);
      count += 1;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      parameters[key] = entry;
      count += 1;
    } else if (typeof entry === "boolean") {
      parameters[key] = entry;
      count += 1;
    }
  }
  return parameters;
}
