import { createId } from "@kachang/canvas-core";
import type { CanvasMedia, CanvasNodeData, CanvasNodeKind } from "@kachang/contracts";
import type { XYPosition } from "@xyflow/react";

import type { KachangEdge, KachangNode } from "../types";
import { getNodeDefinition } from "./node-registry";
import "./builtin-nodes";
import { scaleNodeDimensions, type DefaultNodeAspectRatio, type DefaultNodeSize } from "./node-size";

/** 未注册 kind 的兜底尺寸（正常情况下六种内置节点都在注册表里）。 */
const FALLBACK_DIMENSIONS = { width: 308, height: 176 } as const;

export function nodeDefaultDimensions(
  kind: CanvasNodeKind,
  aspectRatioOrLegacySize: DefaultNodeAspectRatio | DefaultNodeSize = "16:9",
) {
  const draft = getNodeDefinition(kind)?.createDraft({ defaultAspectRatio: aspectRatioOrLegacySize });
  return draft ? { width: draft.width, height: draft.height } : { ...FALLBACK_DIMENSIONS };
}

export function nodeCreationDimensions(
  kind: CanvasNodeKind,
  aspectRatio: DefaultNodeAspectRatio | DefaultNodeSize,
) {
  return nodeDefaultDimensions(kind, aspectRatio);
}

export function mediaNodeDimensions(
  kind: CanvasNodeKind,
  media: Pick<CanvasMedia, "width" | "height"> | null,
  size: DefaultNodeSize | number = "standard",
) {
  const fallback = scaleNodeDimensions(nodeDefaultDimensions(kind, "standard"), size);
  if ((kind !== "image" && kind !== "video") || !media?.width || !media.height) {
    return fallback;
  }

  const ratio = media.width / media.height;
  if (!Number.isFinite(ratio) || ratio <= 0) return fallback;
  let dimensions: { width: number; height: number };
  if (ratio >= 1) {
    const width = kind === "video" ? 380 : 360;
    const naturalHeight = Math.round(width / ratio);
    if (naturalHeight >= 180 && naturalHeight <= 360) {
      dimensions = { width, height: naturalHeight };
    } else {
      const height = Math.max(180, Math.min(360, naturalHeight));
      dimensions = { width: Math.min(460, Math.round(height * ratio)), height };
    }
  } else {
    const height = kind === "video" ? 400 : 390;
    const naturalWidth = Math.round(height * ratio);
    if (naturalWidth >= 200 && naturalWidth <= 360) {
      dimensions = { width: naturalWidth, height };
    } else {
      const width = Math.max(200, Math.min(360, naturalWidth));
      dimensions = { width, height: Math.min(440, Math.round(width / ratio)) };
    }
  }
  return scaleNodeDimensions(dimensions, size);
}

export function createCanvasNode(
  kind: CanvasNodeKind,
  position: XYPosition,
  overrides: Partial<CanvasNodeData> = {},
  defaultAspectRatio: DefaultNodeAspectRatio | DefaultNodeSize = "16:9",
  creationScale = 1,
): KachangNode {
  const now = Date.now();
  const definition = getNodeDefinition(kind);
  const draft = definition?.createDraft({ defaultAspectRatio }) ?? { kind, ...FALLBACK_DIMENSIONS };
  const dimensions = scaleNodeDimensions(draft, creationScale);
  const data: CanvasNodeData = {
    kind,
    body: "",
    accent: definition?.accent ?? "jade",
    status: "idle",
    progress: null,
    media: null,
    directorCapture: null,
    config: null,
    edit: null,
    music: null,
    generation: {
      modelId: null,
      parameters: {},
      referenceImagePurposes: {},
      maxOutputTokens: null,
      referenceMode: "auto",
      referenceNodeIds: [],
      jobId: null,
      jobVersion: null,
      jobCreatedAt: null,
      jobStatus: null,
      error: null,
    },
    createdAt: now,
    updatedAt: now,
    ...draft.data,
    ...overrides,
  };
  return {
    id: createId("node"),
    type: "kachang",
    position,
    width: dimensions.width,
    height: dimensions.height,
    selected: true,
    data,
  };
}

export function createCanvasEdge(source: string, target: string): KachangEdge {
  return {
    id: createId("edge"),
    type: "kachang",
    source,
    target,
  };
}
