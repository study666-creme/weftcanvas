import type {
  CanvasMedia,
  CanvasReferenceMode,
  GenerationJobInput,
  MediaKind,
  ModelInputCount,
  PublicModel,
  ReferenceImagePurpose,
} from "@kachang/contracts";

import type { KachangEdge, KachangNode } from "../types";
import { useCanvasStore } from "../state/canvas-store";
import { useCloudProjectStore } from "../state/cloud-project-store";
import { createMediaUpload, createProviderMediaReference, mediaContentPath, uploadMediaBlob } from "./api-client";
import { indexIncomingNodeIds } from "./canvas-graph";
import { cacheServerMedia, readMedia } from "./media-store";

export type MediaReference = {
  nodeId: string;
  kind: MediaKind;
  media: CanvasMedia;
};

export type GenerationReferences = {
  images: MediaReference[];
  styleImages: MediaReference[];
  elementImages: MediaReference[];
  videos: MediaReference[];
  audios: MediaReference[];
  connectedImages: MediaReference[];
  unassignedImages: MediaReference[];
  imagePurposes: ReferenceImagePurpose[];
  overflow: GenerationReferenceOverflow[];
  aggregateOverflow: GenerationReferenceAggregateOverflow | null;
};

export type GenerationReferenceOverflow = {
  kind: MediaKind;
  purpose?: ReferenceImagePurpose;
  selected: number;
  max: number;
};

export type GenerationReferenceAggregateOverflow = {
  selected: number;
  max: number;
};

export const referenceImagePurposeLabels: Record<ReferenceImagePurpose, string> = {
  images: "参考图",
  styleImages: "风格图",
  elementImages: "元素图",
};

/**
 * H3 系列的上游视频路线要求参考视频成对声明时长（目录里的
 * required_with: referenceVideos）：只连参考视频不发音长，上游整单按 400 拒，
 * 画布上就表现为视频节点一连素材就「请求参数无效」。时长因此是一个随请求提交
 * 的目录参数，顺序必须与 inputs.videos 完全一致。15 秒总上限同样来自目录
 * （referenceVideos.max_total_duration_seconds），没有投影到公开参数表。
 */
export const REFERENCE_VIDEO_DURATIONS_PARAMETER = "referenceVideoDurations";
export const MAX_REFERENCE_VIDEO_TOTAL_SECONDS = 15;

export function referenceVideoDurationsParameter(model: PublicModel) {
  return (model.parameters ?? []).find((parameter) => parameter.name === REFERENCE_VIDEO_DURATIONS_PARAMETER && parameter.type === "array") ?? null;
}

/**
 * 与 inputs.videos 同顺序的参考视频秒数（两位小数）。只要有任何一个参考视频
 * 量不出时长（老素材没有探测过）就返回 null，由引用校验拦住提交，不去上游换
 * 一句「请求参数无效」。
 */
export function referenceVideoDurations(references: Pick<GenerationReferences, "videos">): number[] | null {
  return referenceVideoDurationsFromMedia(references.videos.map((reference) => reference.media.durationMs));
}

/**
 * 毫秒数组 → 秒数组。画布节点与快速生成页共用：两处引用结构不同，但「视频参考
 * 必须成对声明时长」的上游契约和 15 秒上限是同一条，逻辑只留一份。
 */
export function referenceVideoDurationsFromMedia(durations: readonly (number | null | undefined)[]): number[] | null {
  const seconds: number[] = [];
  for (const durationMs of durations) {
    if (!durationMs) return null;
    seconds.push(Math.round(durationMs / 10) / 100);
  }
  return seconds;
}

const imagePurposeOrder: ReferenceImagePurpose[] = ["images", "styleImages", "elementImages"];

/**
 * Returns non-empty text-node bodies on the target's direct incoming edges.
 * 与媒体引用的收集范围一致：只看直接相连的上游节点，不穿透中间节点向上
 * 爬——隔着媒体节点的远端文字不会混进生成提示词。入边原顺序保留，正文去重。
 */
export function collectUpstreamTextContent(
  nodeId: string,
  nodes: readonly KachangNode[],
  edges: readonly KachangEdge[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seenBodies = new Set<string>();
  const bodies: string[] = [];

  for (const edge of edges) {
    if (edge.target !== nodeId) continue;
    const node = byId.get(edge.source);
    if (node?.data.kind !== "text") continue;
    const body = node.data.body.trim();
    if (body && !seenBodies.has(body)) {
      seenBodies.add(body);
      bodies.push(body);
    }
  }

  return bodies;
}

export function collectGenerationReferences(
  nodeId: string,
  model: PublicModel,
  nodes: KachangNode[],
  edges: KachangEdge[],
  explicitNodeIds: readonly string[] = [],
  referenceMode: CanvasReferenceMode = explicitNodeIds.length ? "explicit" : "auto",
  assignments: Readonly<Record<string, ReferenceImagePurpose>> = {},
): GenerationReferences {
  const useExplicitReferences = referenceMode === "explicit" && explicitNodeIds.length > 0;
  const directIncomingNodeIds = indexIncomingNodeIds(edges).get(nodeId) ?? [];
  const directIncomingNodeIdSet = useExplicitReferences ? new Set(directIncomingNodeIds) : null;
  const targetNode = nodes.find((node) => node.id === nodeId);
  const reusesOwnMedia = targetNode?.data.kind === "image";
  const candidateIds = [
    ...(reusesOwnMedia ? [nodeId] : []),
    ...(useExplicitReferences
      ? explicitNodeIds.filter((id) => directIncomingNodeIdSet?.has(id))
      : directIncomingNodeIds),
  ];
  const candidates = collectExplicitMedia(candidateIds, nodes);
  const connectedImages = candidates.filter((item) => item.kind === "image");
  const imagePurposes = getReferenceImagePurposes(model);
  const imageBuckets: Record<ReferenceImagePurpose, MediaReference[]> = {
    images: [],
    styleImages: [],
    elementImages: [],
  };
  const unassignedImages: MediaReference[] = [];

  if (imagePurposes.length === 0) {
    // Keep unsupported images visible to the existing overflow path instead of
    // silently discarding connected or explicitly selected material.
    imageBuckets.images.push(...connectedImages);
  } else {
    for (const reference of connectedImages) {
      const purpose = imagePurposes.length === 1
        ? imagePurposes[0]
        : referenceImagePurposeFor(assignments, reference);
      if (!purpose || !imagePurposes.includes(purpose)) {
        unassignedImages.push(reference);
        continue;
      }
      imageBuckets[purpose].push(reference);
    }
  }

  const images = selectReferences(
    "image",
    imageBuckets.images,
    referenceImageCapability(model, "images"),
    32,
  );
  const styleImages = selectReferences(
    "image",
    imageBuckets.styleImages,
    referenceImageCapability(model, "styleImages"),
    32,
    "styleImages",
  );
  const elementImages = selectReferences(
    "image",
    imageBuckets.elementImages,
    referenceImageCapability(model, "elementImages"),
    32,
    "elementImages",
  );
  const videos = selectReferences(
    "video",
    candidates.filter((item) => item.kind === "video"),
    model.input.referenceMedia?.videos ?? model.input.videos,
    10,
  );
  const audios = selectReferences(
    "audio",
    candidates.filter((item) => item.kind === "audio"),
    model.input.referenceMedia?.audios ?? model.input.audios,
    10,
  );
  const references = [
    ...images.references,
    ...styleImages.references,
    ...elementImages.references,
    ...videos.references,
    ...audios.references,
  ];
  const aggregateMax = model.input.referenceMedia?.maxTotalItems;
  return {
    images: images.references,
    styleImages: styleImages.references,
    elementImages: elementImages.references,
    videos: videos.references,
    audios: audios.references,
    connectedImages,
    unassignedImages,
    imagePurposes,
    overflow: [images.overflow, styleImages.overflow, elementImages.overflow, videos.overflow, audios.overflow]
      .filter((item): item is GenerationReferenceOverflow => item !== null),
    aggregateOverflow: aggregateMax !== undefined && references.length > aggregateMax
      ? { selected: references.length, max: aggregateMax }
      : null,
  };
}

export function getReferenceImagePurposes(model: PublicModel): ReferenceImagePurpose[] {
  return imagePurposeOrder.filter((purpose) => supportsReferences(referenceImageCapability(model, purpose)));
}

export function referenceImageCapability(model: PublicModel, purpose: ReferenceImagePurpose) {
  const referenceMedia = model.input.referenceMedia;
  if (!referenceMedia) return purpose === "images" ? model.input.images : undefined;
  if (purpose !== "images") return referenceMedia[purpose];
  const hasDeclaredImagePurpose = referenceMedia.images !== undefined
    || referenceMedia.styleImages !== undefined
    || referenceMedia.elementImages !== undefined;
  return referenceMedia.images ?? (hasDeclaredImagePurpose ? undefined : model.input.images);
}

export function referenceImagePurposeLabel(model: PublicModel, purpose: ReferenceImagePurpose) {
  if (purpose !== "images") return referenceImagePurposeLabels[purpose];
  const role = model.input.referenceMedia?.images?.role;
  if (role === "frame") return "帧图";
  if (role === "first-last") return "首尾帧";
  return referenceImagePurposeLabels.images;
}

export function referenceMediaKey(reference: MediaReference) {
  return reference.media.serverId ?? reference.media.id;
}

export function referenceImagePurposeFor(
  assignments: Readonly<Record<string, ReferenceImagePurpose>>,
  reference: MediaReference,
) {
  return (reference.media.serverId ? assignments[reference.media.serverId] : undefined)
    ?? assignments[reference.media.id];
}

function collectExplicitMedia(nodeIds: readonly string[], nodes: KachangNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const seenMedia = new Set<string>();
  const references: MediaReference[] = [];
  for (const nodeId of nodeIds) {
    const node = byId.get(nodeId);
    if (!node?.data.media || (node.data.kind !== "image" && node.data.kind !== "video" && node.data.kind !== "audio")) continue;
    const mediaKey = node.data.media.serverId ?? node.data.media.id;
    if (seenMedia.has(mediaKey)) continue;
    seenMedia.add(mediaKey);
    references.push({ nodeId: node.id, kind: node.data.kind, media: node.data.media });
  }
  return references;
}

export function referenceCounts(references: GenerationReferences) {
  return {
    images: references.images.length,
    styleImages: references.styleImages.length,
    elementImages: references.elementImages.length,
    videos: references.videos.length,
    audios: references.audios.length,
  };
}

export function generationReferenceError(references: GenerationReferences, model: PublicModel): string | null {
  if (references.unassignedImages.length) {
    return `请为 ${references.unassignedImages.length} 张参考图片选择用途`;
  }
  const overflow = references.overflow[0];
  if (overflow) {
    const label = overflow.purpose
      ? referenceImagePurposeLabel(model, overflow.purpose)
      : generationMediaLabel(overflow.kind);
    return overflow.max > 0
      ? `${label}已选择 ${overflow.selected} 个，当前模型最多支持 ${overflow.max} 个`
      : `当前模型不支持${label}输入`;
  }
  if (references.aggregateOverflow) {
    return `参考素材已选择 ${references.aggregateOverflow.selected} 个，当前模型合计最多支持 ${references.aggregateOverflow.max} 个`;
  }

  for (const purpose of references.imagePurposes) {
    const minimum = referenceImageCapability(model, purpose)?.min ?? 0;
    if (references[purpose].length < minimum) {
      return `${referenceImagePurposeLabel(model, purpose)}至少需要 ${minimum} 张`;
    }
  }
  const videoMinimum = (model.input.referenceMedia?.videos ?? model.input.videos)?.min ?? 0;
  if (references.videos.length < videoMinimum) return `视频素材至少需要 ${videoMinimum} 个`;
  const audioMinimum = (model.input.referenceMedia?.audios ?? model.input.audios)?.min ?? 0;
  if (references.audios.length < audioMinimum) return `音频素材至少需要 ${audioMinimum} 个`;
  if (referenceVideoDurationsParameter(model) && references.videos.length) {
    const durations = referenceVideoDurations(references);
    // 时长缺失不再拦提交：画布上新生成的视频工件可能还没探测出时长，服务端会
    // 从素材记录与任务工件兜底推导。本地只知道一部分时只校验已知部分，总和上限
    // 的最终判定以服务端为准。
    if (durations !== null && durations.reduce((total, seconds) => total + seconds, 0) > MAX_REFERENCE_VIDEO_TOTAL_SECONDS) {
      return `参考视频总时长不能超过 ${MAX_REFERENCE_VIDEO_TOTAL_SECONDS} 秒`;
    }
  }
  return null;
}

export function composeReferenceAwarePrompt(
  body: string,
  references: Pick<GenerationReferences, "images" | "styleImages" | "elementImages" | "videos" | "audios"> | null,
) {
  if (!references) return body.trim();
  const groups = [
    referenceSequenceLabel("图片", references.images.length),
    referenceSequenceLabel("风格图", references.styleImages.length),
    referenceSequenceLabel("元素图", references.elementImages.length),
    referenceSequenceLabel("视频", references.videos.length),
    referenceSequenceLabel("音频", references.audios.length),
  ].filter(Boolean);
  const prompt = body.trim();
  if (!groups.length) return prompt;
  const referenceHint = `参考素材按上传顺序：${groups.join("；")}`;
  return prompt ? `${prompt}\n${referenceHint}` : referenceHint;
}

export async function prepareGenerationInputs(references: GenerationReferences): Promise<GenerationJobInput> {
  const cloudProject = activeCloudProject();
  const cache = new Map<string, Promise<string>>();
  const prepare = (reference: MediaReference) => {
    const key = `${reference.media.source}:${reference.media.id}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = prepareReference(reference, cloudProject);
    cache.set(key, pending);
    return pending;
  };
  const [images, styleImages, elementImages, videos, audios] = await Promise.all([
    Promise.all(references.images.map(prepare)),
    Promise.all(references.styleImages.map(prepare)),
    Promise.all(references.elementImages.map(prepare)),
    Promise.all(references.videos.map(prepare)),
    Promise.all(references.audios.map(prepare)),
  ]);
  return { images, styleImages, elementImages, videos, audios };
}

export async function prepareCustomGenerationInputs(
  references: GenerationReferences,
  publicReferenceKinds: ReadonlySet<MediaKind> = new Set(),
): Promise<GenerationJobInput> {
  const cloudProject = activeCloudProject();
  const projectId = cloudProject?.projectId;
  const cache = new Map<string, Promise<string>>();
  const prepare = (reference: MediaReference) => {
    const key = `${reference.media.source}:${reference.media.id}`;
    const existing = cache.get(key);
    if (existing) return existing;
    const pending = publicReferenceKinds.has(reference.kind)
      ? preparePublicReference(reference, cloudProject)
      : readReferenceAsDataUrl(reference, projectId);
    cache.set(key, pending);
    return pending;
  };
  const [images, styleImages, elementImages, videos, audios] = await Promise.all([
    Promise.all(references.images.map(prepare)),
    Promise.all(references.styleImages.map(prepare)),
    Promise.all(references.elementImages.map(prepare)),
    Promise.all(references.videos.map(prepare)),
    Promise.all(references.audios.map(prepare)),
  ]);
  return { images, styleImages, elementImages, videos, audios };
}

async function preparePublicReference(
  reference: MediaReference,
  cloudProject?: { projectId: string; shared: boolean },
) {
  const mediaId = await prepareReference(reference, cloudProject);
  const projectId = cloudProject?.shared ? undefined : cloudProject?.projectId;
  return projectId
    ? createProviderMediaReference(mediaId, reference.kind, projectId)
    : createProviderMediaReference(mediaId, reference.kind);
}

function selectReferences(
  kind: MediaKind,
  candidates: MediaReference[],
  capability: ModelInputCount | undefined,
  requestLimit: number,
  purpose?: ReferenceImagePurpose,
) {
  const capabilityMax = !capability
    ? 0
    : capability.multiple
      ? capability.max ?? requestLimit
      : Math.min(1, capability.max ?? 1);
  const max = Math.min(capabilityMax, requestLimit);
  return {
    references: max > 0 ? candidates : [],
    overflow: candidates.length > max
      ? { kind, ...(purpose ? { purpose } : {}), selected: candidates.length, max }
      : null,
  };
}

function supportsReferences(capability: ModelInputCount | undefined) {
  return capability !== undefined && capability.max !== 0;
}

function referenceSequenceLabel(label: string, count: number) {
  return Array.from({ length: count }, (_, index) => `${label}${index + 1}`).join("、");
}

async function prepareReference(
  reference: MediaReference,
  cloudProject?: { projectId: string; shared: boolean },
) {
  const projectId = cloudProject?.projectId;
  if (!cloudProject?.shared && reference.media.serverId && reference.media.serverId !== reference.media.id) {
    return reference.media.serverId;
  }
  const stored = reference.media.source === "server"
    ? await readMedia(reference.media.id).catch(() => null)
    : await readMedia(reference.media.id);
  if (reference.media.source === "server" && !stored) {
    const readProjectId = reference.media.id.startsWith("phm_") ? undefined : projectId;
    const cachedFromServer = readProjectId
      ? cacheServerMedia(reference.media, readProjectId)
      : cacheServerMedia(reference.media);
    await cachedFromServer.catch(() => false);
    const cached = await readMedia(reference.media.id).catch(() => null);
    if (cached) {
      return uploadPreparedReference(
        reference,
        cached,
        cloudProject?.shared ? undefined : projectId,
        !cloudProject?.shared,
      );
    }
  }
  // Generated media is mirrored into IndexedDB for resilient rendering. Reuse
  // those exact bytes as a durable uploaded reference instead of asking the
  // generation provider to re-open an older, potentially expired result URL.
  if (reference.media.source === "server" && !stored) {
    if (cloudProject?.shared) throw new Error(`${mediaLabel(reference.kind)}素材暂时无法读取`);
    return reference.media.id;
  }
  if (!stored) throw new Error(`${mediaLabel(reference.kind)}素材已不在当前浏览器中`);
  return uploadPreparedReference(
    reference,
    stored,
    cloudProject?.shared ? undefined : projectId,
    !cloudProject?.shared,
  );
}

async function uploadPreparedReference(
  reference: MediaReference,
  stored: NonNullable<Awaited<ReturnType<typeof readMedia>>>,
  projectId?: string,
  applyToNode = true,
) {
  const intent = await createMediaUpload({
    kind: reference.kind,
    name: stored.name,
    mimeType: stored.mimeType,
    size: stored.blob.size,
    idempotencyKey: await uploadRequestKey(stored.id, projectId),
    ...(projectId ? { projectId } : {}),
  });
  const ready = intent.upload ? await uploadMediaBlob(intent.media, intent.upload, stored.blob) : intent.media;
  if (ready.status !== "ready") throw new Error(`${mediaLabel(reference.kind)}素材暂时无法使用`);

  if (applyToNode) {
    const state = useCanvasStore.getState();
    const current = state.nodes.find((node) => node.id === reference.nodeId)?.data.media;
    if (current?.id === reference.media.id) {
      state.updateNodeData(reference.nodeId, { media: { ...current, serverId: ready.id } }, false);
    }
  }
  return ready.id;
}

async function readReferenceAsDataUrl(reference: MediaReference, projectId?: string) {
  let blob: Blob;
  if (reference.media.source === "local") {
    const stored = await readMedia(reference.media.id);
    if (!stored) throw new Error(`${mediaLabel(reference.kind)}素材已不在当前浏览器中`);
    blob = stored.blob;
  } else {
    const readProjectId = reference.media.id.startsWith("phm_") ? undefined : projectId;
    // same-origin：302 到 R2 预签名地址后浏览器去掉凭据；include 会被 R2 CORS 拒绝。
    const response = await fetch(mediaContentPath(reference.media.id, readProjectId), { credentials: "same-origin" });
    if (!response.ok) throw new Error(`${mediaLabel(reference.kind)}素材暂时无法读取`);
    blob = await response.blob();
  }
  if (blob.size > 60 * 1024 * 1024) throw new Error(`${mediaLabel(reference.kind)}素材过大，无法直接提交`);
  return blobToDataUrl(blob);
}

function activeCloudProject() {
  const projectId = useCanvasStore.getState().projectId;
  const link = useCloudProjectStore.getState().links[projectId];
  return link ? { projectId, shared: link.projectOwnerId !== link.ownerId } : undefined;
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("素材读取失败"));
    reader.onerror = () => reject(reader.error ?? new Error("素材读取失败"));
    reader.readAsDataURL(blob);
  });
}

function mediaLabel(kind: MediaKind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

function generationMediaLabel(kind: MediaKind) {
  return kind === "image" ? "图片素材" : kind === "video" ? "视频素材" : "音频素材";
}

async function uploadRequestKey(localId: string, projectId?: string) {
  if (!crypto.subtle) return `upload:${crypto.randomUUID()}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${projectId ?? "personal"}:${localId}`),
  );
  const hex = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `upload:${hex}`;
}
