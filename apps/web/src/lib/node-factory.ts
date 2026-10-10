import { createId } from "@kachang/canvas-core";
import type { CanvasMedia, CanvasNodeData, CanvasNodeKind } from "@kachang/contracts";
import type { XYPosition } from "@xyflow/react";

import type { KachangEdge, KachangNode } from "../types";
import {
  isDefaultNodeAspectRatio,
  nodeAspectRatioValue,
  scaleNodeDimensions,
  type DefaultNodeAspectRatio,
  type DefaultNodeSize,
} from "./node-size";

const nodeDefaults: Record<CanvasNodeKind, { body: string; accent: string; width: number; height: number }> = {
  text: { body: "", accent: "jade", width: 308, height: 176 },
  image: { body: "", accent: "blue", width: 340, height: 214 },
  video: { body: "", accent: "blue", width: 340, height: 192 },
  audio: { body: "", accent: "jade", width: 340, height: 164 },
  config: { body: "", accent: "jade", width: 308, height: 176 },
  edit: { body: "", accent: "blue", width: 340, height: 192 },
};

export function nodeDefaultDimensions(
  kind: CanvasNodeKind,
  aspectRatioOrLegacySize: DefaultNodeAspectRatio | DefaultNodeSize = "16:9",
) {
  const { width, height } = nodeDefaults[kind];
  if (!isDefaultNodeAspectRatio(aspectRatioOrLegacySize)) {
    return scaleNodeDimensions({ width, height }, aspectRatioOrLegacySize);
  }
  if (kind !== "image" && kind !== "video") return { width, height };
  const ratio = nodeAspectRatioValue(aspectRatioOrLegacySize);
  const longEdge = 340;
  return ratio >= 1
    ? { width: longEdge, height: Math.round(longEdge / ratio) }
    : { width: Math.round(longEdge * ratio), height: longEdge };
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
  const fallback = scaleNodeDimensions(nodeDefaults[kind], size);
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
  const defaults = nodeDefaults[kind];
  const dimensions = scaleNodeDimensions(nodeDefaultDimensions(kind, defaultAspectRatio), creationScale);
  return {
    id: createId("node"),
    type: "kachang",
    position,
    width: dimensions.width,
    height: dimensions.height,
    selected: true,
    data: {
      kind,
      body: defaults.body,
      accent: defaults.accent,
      status: "idle",
      progress: null,
      media: null,
      directorCapture: null,
      config: kind === "config" ? { modality: "image" } : null,
      edit: kind === "edit" ? { clips: [] } : null,
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
      ...overrides,
    },
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
