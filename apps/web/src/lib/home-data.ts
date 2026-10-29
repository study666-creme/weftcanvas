import type { CanvasMedia } from "@weftcanvas/contracts";

/**
 * 主页（工作台式首屏）的数据整理层：纯函数，无 React / IndexedDB 依赖，便于单测。
 *
 * 主页只读浏览器里已经存在的真实数据——本地项目库、资产库、工作台历史——
 * 不伪造任何作品或封面。项目快照用宽松解析（JSON.parse + 字段守卫），不走
 * zod 全量校验：主页只需要封面与作品摘要，大项目逐个 schema 校验会拖慢首屏。
 */

export type HomeWorkKind = "image" | "video" | "audio";

export type HomeWorkOrigin =
  | { type: "project"; projectId: string; projectName: string; nodeId: string }
  | { type: "workbench"; jobId: string }
  | { type: "library"; assetId: string };

export type HomeWork = {
  /** 去重键：同一份媒体只算一件作品。 */
  key: string;
  kind: HomeWorkKind;
  media: CanvasMedia;
  prompt: string;
  model: string | null;
  createdAt: number;
  origin: HomeWorkOrigin;
};

export type ProjectDigest = {
  /** 封面候选（最近更新的图片/视频媒体，最多 4 个）。 */
  cover: { media: CanvasMedia; kind: HomeWorkKind }[];
  /** 该项目里由生成任务产出的作品。 */
  works: HomeWork[];
  counts: { image: number; video: number; audio: number; text: number };
};

const MAX_COVER_MEDIA = 4;
const MAX_WORKS_PER_PROJECT = 120;

type LooseRecord = Record<string, unknown>;

function isRecord(value: unknown): value is LooseRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function mediaKindOf(media: Pick<CanvasMedia, "mimeType">): HomeWorkKind | null {
  const mime = media.mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

/** 宽松读取一个媒体描述；字段不全时返回 null（主页宁可不显示也不显示坏图）。 */
export function looseMedia(value: unknown): CanvasMedia | null {
  if (!isRecord(value)) return null;
  const { id, name, mimeType } = value;
  if (typeof id !== "string" || !id || typeof mimeType !== "string" || !mimeType) return null;
  const source = value.source === "server" ? "server" : "local";
  const optionalInt = (field: unknown) =>
    typeof field === "number" && Number.isFinite(field) && field > 0 ? Math.round(field) : null;
  return {
    id,
    name: typeof name === "string" && name ? name : "未命名素材",
    mimeType,
    size: finiteNumber(value.size),
    source,
    serverId: typeof value.serverId === "string" && value.serverId ? value.serverId : null,
    width: optionalInt(value.width),
    height: optionalInt(value.height),
    durationMs: optionalInt(value.durationMs),
  };
}

/**
 * 从一份（可能来自旧版本、字段不全的）项目快照里取主页需要的摘要。
 * 解析失败或结构不符时返回空摘要，不抛错。
 */
export function digestProject(raw: unknown, fallback: { id: string; name: string }): ProjectDigest {
  const digest: ProjectDigest = {
    cover: [],
    works: [],
    counts: { image: 0, video: 0, audio: 0, text: 0 },
  };
  if (!isRecord(raw) || !Array.isArray(raw.nodes)) return digest;
  const projectId = typeof raw.id === "string" && raw.id ? raw.id : fallback.id;
  const projectName = typeof raw.name === "string" && raw.name ? raw.name : fallback.name;

  type Candidate = { media: CanvasMedia; kind: HomeWorkKind; updatedAt: number };
  const coverCandidates: Candidate[] = [];
  const seenCover = new Set<string>();

  for (const node of raw.nodes) {
    if (!isRecord(node) || !isRecord(node.data)) continue;
    const data = node.data;
    const nodeKind = data.kind === "note" ? "text" : data.kind === "music" ? "audio" : data.kind;
    if (nodeKind === "text") digest.counts.text += 1;
    const media = looseMedia(data.media);
    if (!media) continue;
    const kind = mediaKindOf(media);
    if (!kind) continue;
    digest.counts[kind] += 1;
    const updatedAt = finiteNumber(data.updatedAt, finiteNumber(data.createdAt));

    if ((kind === "image" || kind === "video") && !seenCover.has(media.id)) {
      seenCover.add(media.id);
      coverCandidates.push({ media, kind, updatedAt });
    }

    const generation = isRecord(data.generation) ? data.generation : null;
    const jobId = generation && typeof generation.jobId === "string" ? generation.jobId : null;
    if (!jobId || digest.works.length >= MAX_WORKS_PER_PROJECT) continue;
    const jobCreatedAt =
      generation && typeof generation.jobCreatedAt === "string"
        ? Date.parse(generation.jobCreatedAt)
        : Number.NaN;
    digest.works.push({
      key: media.id,
      kind,
      media,
      prompt: typeof data.body === "string" ? data.body.trim().slice(0, 2_000) : "",
      model:
        generation && typeof generation.modelId === "string" && generation.modelId
          ? generation.modelId
          : null,
      createdAt: Number.isFinite(jobCreatedAt) ? jobCreatedAt : updatedAt,
      origin: {
        type: "project",
        projectId,
        projectName,
        nodeId: typeof node.id === "string" ? node.id : "",
      },
    });
  }

  // 封面优先用图片（视频首帧要解码，成本高），同类按最近更新排序。
  digest.cover = coverCandidates
    .sort(
      (left, right) =>
        Number(right.kind === "image") - Number(left.kind === "image") ||
        right.updatedAt - left.updatedAt,
    )
    .slice(0, MAX_COVER_MEDIA)
    .map(({ media, kind }) => ({ media, kind }));
  return digest;
}

export type WorkbenchJobLike = {
  id: string;
  status: string;
  modality: string;
  modelLabel?: string;
  modelId?: string;
  createdAt: string;
  parameters?: Record<string, unknown>;
  artifacts: ReadonlyArray<
    | { kind: "text" }
    | {
        kind: "image" | "video" | "audio";
        mediaId: string;
        name: string;
        mimeType: string;
        size: number;
        width?: number;
        height?: number;
        duration?: number;
      }
  >;
};

/** 工作台（/generate）历史任务 → 作品。只收已完成的媒体产物。 */
export function worksFromWorkbenchJobs(
  jobs: readonly WorkbenchJobLike[],
  hiddenArtifactKeys: ReadonlySet<string> = new Set(),
): HomeWork[] {
  const works: HomeWork[] = [];
  for (const job of jobs) {
    if (job.status !== "completed") continue;
    const createdAt = Date.parse(job.createdAt);
    const prompt =
      typeof job.parameters?.prompt === "string"
        ? job.parameters.prompt.trim().slice(0, 2_000)
        : "";
    for (const artifact of job.artifacts) {
      if (artifact.kind === "text") continue;
      if (hiddenArtifactKeys.has(`${job.id}:${artifact.mediaId}`)) continue;
      works.push({
        key: artifact.mediaId,
        kind: artifact.kind,
        media: {
          id: artifact.mediaId,
          name: artifact.name,
          mimeType: artifact.mimeType,
          size: artifact.size,
          source: "server",
          serverId: artifact.mediaId,
          width: artifact.width ?? null,
          height: artifact.height ?? null,
          durationMs: artifact.duration ? Math.max(1, Math.round(artifact.duration * 1_000)) : null,
        },
        prompt,
        model: job.modelLabel ?? job.modelId ?? null,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        origin: { type: "workbench", jobId: job.id },
      });
    }
  }
  return works;
}

export type LibraryItemLike = {
  id: string;
  kind: string;
  name: string;
  prompt: string;
  media: CanvasMedia | null;
  source: string;
  createdAt: number;
  updatedAt: number;
};

/** 资产库里由生成落库的媒体（source=canvas）→ 作品；用于补齐不在任何项目里的产物。 */
export function worksFromLibraryItems(items: readonly LibraryItemLike[]): HomeWork[] {
  const works: HomeWork[] = [];
  for (const item of items) {
    if (item.source !== "canvas" || !item.media) continue;
    const kind = mediaKindOf(item.media);
    if (!kind) continue;
    works.push({
      key: item.media.id,
      kind,
      media: item.media,
      prompt: item.prompt.trim(),
      model: null,
      createdAt: item.createdAt,
      origin: { type: "library", assetId: item.id },
    });
  }
  return works;
}

const ORIGIN_RANK: Record<HomeWorkOrigin["type"], number> = {
  // 同一份媒体出现在多处时，项目来源信息最完整（能跳回原画布）。
  project: 0,
  workbench: 1,
  library: 2,
};

/** 合并多来源作品：按媒体去重（保留信息最全的一条，并补齐提示词），按时间倒序。 */
export function mergeWorks(...sources: ReadonlyArray<readonly HomeWork[]>): HomeWork[] {
  const byKey = new Map<string, HomeWork>();
  for (const list of sources) {
    for (const work of list) {
      const existing = byKey.get(work.key);
      if (!existing) {
        byKey.set(work.key, work);
        continue;
      }
      const preferred =
        ORIGIN_RANK[work.origin.type] < ORIGIN_RANK[existing.origin.type] ? work : existing;
      const other = preferred === work ? existing : work;
      byKey.set(work.key, {
        ...preferred,
        prompt: preferred.prompt || other.prompt,
        model: preferred.model ?? other.model,
        createdAt: Math.max(preferred.createdAt, other.createdAt),
      });
    }
  }
  return [...byKey.values()].sort(
    (left, right) => right.createdAt - left.createdAt || left.key.localeCompare(right.key),
  );
}

export type WorkFilter = "all" | HomeWorkKind;

export function filterWorks(works: readonly HomeWork[], filter: WorkFilter, query = "") {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  return works.filter((work) => {
    if (filter !== "all" && work.kind !== filter) return false;
    if (!needle) return true;
    const haystack = [
      work.prompt,
      work.media.name,
      work.model ?? "",
      work.origin.type === "project" ? work.origin.projectName : "",
    ]
      .join(" ")
      .toLocaleLowerCase("zh-CN");
    return haystack.includes(needle);
  });
}

export type DateBucket = "today" | "yesterday" | "week" | "month" | "earlier";

export const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: "今天",
  yesterday: "昨天",
  week: "近 7 天",
  month: "近 30 天",
  earlier: "更早",
};

export function dateBucket(timestamp: number, now = Date.now()): DateBucket {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86_400_000;
  if (timestamp >= today) return "today";
  if (timestamp >= today - day) return "yesterday";
  if (timestamp >= today - 6 * day) return "week";
  if (timestamp >= today - 29 * day) return "month";
  return "earlier";
}

/** 按日期分组，保持输入顺序（输入已按时间倒序）。 */
export function groupWorksByDate(works: readonly HomeWork[], now = Date.now()) {
  const groups: { bucket: DateBucket; label: string; works: HomeWork[] }[] = [];
  for (const work of works) {
    const bucket = dateBucket(work.createdAt, now);
    const last = groups[groups.length - 1];
    if (last && last.bucket === bucket) last.works.push(work);
    else groups.push({ bucket, label: DATE_BUCKET_LABELS[bucket], works: [work] });
  }
  return groups;
}

export function formatRelativeTime(timestamp: number, now = Date.now()) {
  if (!timestamp) return "时间未知";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 7 * 86_400_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return new Intl.DateTimeFormat("zh-CN", {
    ...(sameYear ? {} : { year: "numeric" }),
    month: "short",
    day: "numeric",
  }).format(date);
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(durationMs: number | null) {
  if (!durationMs || durationMs <= 0) return null;
  const total = Math.round(durationMs / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function greetingFor(date = new Date()) {
  const hour = date.getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "早上好";
  if (hour < 13) return "中午好";
  if (hour < 18) return "下午好";
  if (hour < 23) return "晚上好";
  return "夜深了";
}

export type ProjectSort = "updated" | "created" | "name";

export type ProjectSummaryLike = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
};

export function sortProjects<T extends ProjectSummaryLike>(
  projects: readonly T[],
  sort: ProjectSort,
  query = "",
): T[] {
  const needle = query.trim().toLocaleLowerCase("zh-CN");
  const filtered = needle
    ? projects.filter((project) => project.name.toLocaleLowerCase("zh-CN").includes(needle))
    : [...projects];
  return filtered.sort((left, right) => {
    if (sort === "name") return left.name.localeCompare(right.name, "zh-CN");
    if (sort === "created") return right.createdAt - left.createdAt;
    return right.updatedAt - left.updatedAt;
  });
}
