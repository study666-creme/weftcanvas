import type {
  CanvasMedia,
  CanvasNodeData,
  CanvasNodeKind,
  GenerationArtifact,
  PublicGenerationJob,
} from "@weftcanvas/contracts";

import { mediaNodeDimensions, nodeDefaultDimensions } from "./node-factory";
import { resizeMediaNodeToAspectRatio } from "./node-configuration";
import { generationParametersAspectRatio } from "./node-size";
import type { WeftcanvasNode } from "../types";

/**
 * 节点产物投影（从 `canvas-store.ts` 抽出，纯搬移）：生成产物与媒体元数据落到
 * 节点上的几何/状态计算。全部为纯函数——输入节点与产物，输出新节点，不读 store、
 * 不发请求，因此可以直接单测。
 *
 * `currentDefaultNodeAspectRatio()` 仍留在 store：它读 UI 偏好 store，不属于这里。
 */

export function compareGenerationOrder(
  leftCreatedAt: string,
  leftId: string,
  rightCreatedAt: string,
  rightId: string,
) {
  const leftTime = Date.parse(leftCreatedAt);
  const rightTime = Date.parse(rightCreatedAt);
  if (leftTime !== rightTime) return leftTime - rightTime;
  return leftId.localeCompare(rightId);
}

export function artifactAlreadyPresent(
  nodes: WeftcanvasNode[],
  job: PublicGenerationJob,
  artifact: GenerationArtifact,
) {
  return nodes.some((node) => {
    const generation = node.data.generation;
    if (generation.artifactId === artifact.id) return true;
    if (artifact.kind !== "text") {
      return (
        node.data.media?.serverId === artifact.mediaId || node.data.media?.id === artifact.mediaId
      );
    }
    return generation.jobId === job.id && node.data.body === artifact.text;
  });
}

export function generationWithArtifact(
  generation: CanvasNodeData["generation"],
  artifactId: string,
) {
  return { ...generation, artifactId };
}

export function artifactKind(artifact: GenerationArtifact): CanvasNodeKind {
  if (artifact.kind === "text") return "text";
  return artifact.kind;
}

export function projectionResult(
  artifact: GenerationArtifact | null | undefined,
): "none" | "text" | "media" {
  if (!artifact) return "none";
  return artifact.kind === "text" ? "text" : "media";
}

export function resizeNodeForMedia(
  node: WeftcanvasNode,
  media: CanvasMedia,
  scale = 1,
): WeftcanvasNode {
  if (
    (node.data.kind === "image" || node.data.kind === "video") &&
    (!media.width || !media.height) &&
    hasUsableDimensions(node)
  )
    return node;
  const dimensions = mediaNodeDimensions(node.data.kind, media, scale);
  node.width = dimensions.width;
  node.height = dimensions.height;
  return node;
}

export function aspectRatiosEqual(left: number | null, right: number | null) {
  return left !== null && right !== null && Math.abs(left / right - 1) < 0.0001;
}

export function mediaMetadataEqual(left: CanvasMedia | null, right: CanvasMedia) {
  return (
    left?.id === right.id &&
    left.name === right.name &&
    left.mimeType === right.mimeType &&
    left.size === right.size &&
    left.source === right.source &&
    left.serverId === right.serverId &&
    left.width === right.width &&
    left.height === right.height &&
    left.durationMs === right.durationMs
  );
}

export function restoreNodeDimensions(node: WeftcanvasNode) {
  const media = node.data.media;
  const configuredAspectRatio = generationParametersAspectRatio(node.data.generation.parameters);
  if (configuredAspectRatio !== null) {
    // 面板自动写入的模型默认画幅参数不代表创建者的选择：空节点保持创建时
    // 由默认画幅决定的几何，只有显式配置过画幅或媒体已落地才跟随参数比例。
    if (!media && !node.data.generation.aspectExplicit) return node;
    const restored =
      media && !hasUsableDimensions(node) ? resizeNodeForMedia({ ...node }, media) : node;
    return resizeMediaNodeToAspectRatio(restored, configuredAspectRatio);
  }
  if (!media) return node;
  if (!hasUsableDimensions(node)) return resizeNodeForMedia({ ...node }, media);
  if (nodeMediaRatioMatches(node, media)) return node;
  return resizeNodeForMedia({ ...node }, media, inferLegacyNodeScale(node));
}

export function hasUsableDimensions(node: WeftcanvasNode) {
  return (
    Number.isFinite(node.width) &&
    (node.width ?? 0) > 0 &&
    Number.isFinite(node.height) &&
    (node.height ?? 0) > 0
  );
}

export function nodeMediaRatioMatches(node: WeftcanvasNode, media: CanvasMedia) {
  if ((node.data.kind !== "image" && node.data.kind !== "video") || !media.width || !media.height)
    return true;
  const nodeRatio = (node.width ?? 0) / (node.height ?? 0);
  const fitted = mediaNodeDimensions(node.data.kind, media);
  const fittedRatio = fitted.width / fitted.height;
  if (
    !Number.isFinite(nodeRatio) ||
    !Number.isFinite(fittedRatio) ||
    nodeRatio <= 0 ||
    fittedRatio <= 0
  )
    return false;
  return Math.abs(nodeRatio / fittedRatio - 1) <= 0.08;
}

export function inferNodeScale(node: WeftcanvasNode) {
  if (!hasUsableDimensions(node)) return 1;
  const media = node.data.media;
  const base = media
    ? mediaNodeDimensions(node.data.kind, media)
    : node.data.kind === "image" || node.data.kind === "video"
      ? { width: 340, height: 340 }
      : nodeDefaultDimensions(node.data.kind);
  const nodeLongEdge = Math.max(node.width ?? base.width, node.height ?? base.height);
  const baseLongEdge = Math.max(base.width, base.height);
  const scale = nodeLongEdge / baseLongEdge;
  return Number.isFinite(scale) ? Math.min(12, Math.max(0.35, scale)) : 1;
}

export function inferLegacyNodeScale(node: WeftcanvasNode) {
  if (!hasUsableDimensions(node)) return 1;
  // A legacy horizontal box does not describe the scale of newly discovered
  // portrait media. Compare it with the old kind default instead of the new
  // media fit, otherwise a standard 340px node incorrectly shrinks to 85%.
  const base = mediaNodeDimensions(node.data.kind, null);
  const nodeLongEdge = Math.max(node.width ?? base.width, node.height ?? base.height);
  const baseLongEdge = Math.max(base.width, base.height);
  const scale = nodeLongEdge / baseLongEdge;
  return Number.isFinite(scale) ? Math.min(12, Math.max(0.35, scale)) : 1;
}

export function applyArtifact(data: CanvasNodeData, artifact: GenerationArtifact): CanvasNodeData {
  if (artifact.kind === "text")
    return { ...data, body: artifact.text, media: null, status: "success", progress: null };
  const media: CanvasMedia = {
    id: artifact.mediaId,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    source: "server",
    serverId: artifact.mediaId,
    width: artifact.width ?? null,
    height: artifact.height ?? null,
    durationMs: artifact.duration ? Math.max(1, Math.round(artifact.duration * 1_000)) : null,
  };
  return { ...data, media, status: "success", progress: null };
}
