import { canvasNodeLabels } from "@weftcanvas/contracts";
import { FileText, Image, Music2, Scissors, SlidersHorizontal, Video } from "lucide-react";

import {
  mediaDraftDimensions,
  plainDraftDimensions,
  registerNode,
  type NodeCreateContext,
  type NodeDefinition,
} from "./node-registry";

/**
 * 内置节点定义（docs/PLUGIN-ROADMAP.md §3）：六种节点全部经注册表登记，
 * 原散在 canvas-features / node-icon / node-factory 的清单、图标、默认尺寸
 * 与 config/edit 数据分支都收敛到这里。本模块是被动注册——import 即注册。
 */

/** 剪辑工作台开关（真源；canvas-features.ts 转出口保持旧引用可用）。 */
export const CLIP_EDITOR_AVAILABLE = true;

function mediaDefinition(
  kind: "image" | "video",
  icon: NodeDefinition["icon"],
  accent: string,
  base: { width: number; height: number },
): NodeDefinition {
  return {
    kind,
    label: () => canvasNodeLabels[kind],
    icon,
    accent,
    createDraft: (ctx: NodeCreateContext) => ({
      kind,
      ...mediaDraftDimensions(base, ctx),
    }),
  };
}

const builtinDefinitions: NodeDefinition[] = [
  {
    kind: "text",
    label: () => canvasNodeLabels.text,
    icon: FileText,
    accent: "jade",
    createDraft: (ctx) => ({
      kind: "text",
      ...plainDraftDimensions({ width: 308, height: 176 }, ctx),
    }),
  },
  mediaDefinition("image", Image, "blue", { width: 340, height: 214 }),
  mediaDefinition("video", Video, "blue", { width: 340, height: 192 }),
  {
    kind: "audio",
    label: () => canvasNodeLabels.audio,
    icon: Music2,
    accent: "jade",
    createDraft: (ctx) => ({
      kind: "audio",
      ...plainDraftDimensions({ width: 340, height: 164 }, ctx),
    }),
  },
  {
    kind: "config",
    label: () => canvasNodeLabels.config,
    icon: SlidersHorizontal,
    accent: "jade",
    createDraft: (ctx) => ({
      kind: "config",
      data: { config: { modality: "image" } },
      ...plainDraftDimensions({ width: 308, height: 176 }, ctx),
    }),
  },
  {
    kind: "edit",
    label: () => canvasNodeLabels.edit,
    icon: Scissors,
    accent: "blue",
    creatable: CLIP_EDITOR_AVAILABLE,
    createDraft: (ctx) => ({
      kind: "edit",
      data: { edit: { clips: [] } },
      ...plainDraftDimensions({ width: 340, height: 192 }, ctx),
    }),
  },
];

for (const definition of builtinDefinitions) {
  registerNode(definition);
}
