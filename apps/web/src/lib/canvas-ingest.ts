import type { CanvasMedia, CanvasNodeData, CanvasNodeKind } from "@weftcanvas/contracts";
import type { XYPosition } from "@xyflow/react";

import { mediaNodeDimensions, nodeDefaultDimensions } from "./node-factory";
import { type DefaultNodeAspectRatio } from "./node-size";
import { inferMaterialKind } from "./media-kind";

export type CanvasIngestDraft = {
  kind: CanvasNodeKind;
  data?: Partial<CanvasNodeData>;
};

export type CanvasFileNodeKind = Exclude<CanvasNodeKind, "config" | "edit">;

export type PositionedCanvasIngestDraft = CanvasIngestDraft & {
  position: XYPosition;
};

const TEXT_EXTENSIONS = [".md", ".markdown", ".txt"];

/**
 * 画布文件类型推断：文字类看 MIME/扩展名；媒体类走共享的三层推断
 * （MIME → 扩展名 → 文件头魔数）。此前只看 MIME，MIME 为空的下载图片
 * 会被误判为不支持——工作台同文件却能上传（它有魔数兜底）。
 */
export async function inferCanvasFileKind(file: File): Promise<CanvasFileNodeKind | null> {
  const name = file.name.toLocaleLowerCase("en-US");
  if (
    file.type.startsWith("text/") ||
    TEXT_EXTENSIONS.some((extension) => name.endsWith(extension))
  )
    return "text";
  return inferMaterialKind(file);
}

export function layoutCanvasIngestDrafts(
  drafts: CanvasIngestDraft[],
  anchor: XYPosition,
  defaultAspectRatio: DefaultNodeAspectRatio = "16:9",
): PositionedCanvasIngestDraft[] {
  if (!drafts.length) return [];
  const columns = Math.min(3, drafts.length);
  const rows = Math.ceil(drafts.length / columns);
  const dimensions = drafts.map((draft) => dimensionsForDraft(draft, defaultAspectRatio));
  const columnWidths = Array.from({ length: columns }, (_, column) =>
    Math.max(
      ...dimensions.filter((_, index) => index % columns === column).map((size) => size.width),
    ),
  );
  const rowHeights = Array.from({ length: rows }, (_, row) =>
    Math.max(...dimensions.slice(row * columns, (row + 1) * columns).map((size) => size.height)),
  );
  const gapX = 34;
  const gapY = 42;
  const totalWidth = columnWidths.reduce((sum, width) => sum + width, 0) + gapX * (columns - 1);
  const totalHeight = rowHeights.reduce((sum, height) => sum + height, 0) + gapY * (rows - 1);
  const columnOffsets = cumulativeOffsets(columnWidths, gapX);
  const rowOffsets = cumulativeOffsets(rowHeights, gapY);

  return drafts.map((draft, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    const size = dimensions[index]!;
    const columnWidth = columnWidths[column]!;
    const rowHeight = rowHeights[row]!;
    return {
      ...draft,
      position: {
        x: anchor.x - totalWidth / 2 + columnOffsets[column]! + (columnWidth - size.width) / 2,
        y: anchor.y - totalHeight / 2 + rowOffsets[row]! + (rowHeight - size.height) / 2,
      },
    };
  });
}

function dimensionsForDraft(draft: CanvasIngestDraft, defaultAspectRatio: DefaultNodeAspectRatio) {
  const media = draft.data?.media as CanvasMedia | null | undefined;
  return media
    ? mediaNodeDimensions(draft.kind, media)
    : nodeDefaultDimensions(draft.kind, defaultAspectRatio);
}

function cumulativeOffsets(values: number[], gap: number) {
  const offsets: number[] = [];
  let current = 0;
  for (const value of values) {
    offsets.push(current);
    current += value + gap;
  }
  return offsets;
}
