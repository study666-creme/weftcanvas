import type { InsertableAsset } from "./insertable-asset";

/**
 * 卡片/资产 → 画布的拖拽通道。
 *
 * 媒体要经过下载、签名或本地 IndexedDB 读取才能变成 InsertableAsset，而
 * dragstart 不能 await。这里在拖拽开始时把「异步解析器」登记到内存表，
 * DataTransfer 里只放一个短 id（浏览器在 dragover 阶段也只允许读 types），
 * 画布在 drop 时取出解析器并 await，再按落点建节点。
 *
 * 只支持同页面内拖拽；跨窗口请走「加入画布」按钮。
 */

export const CANVAS_ASSET_DRAG_TYPE = "application/x-weftcanvas-asset";

/** 拖拽开始后多久回收解析器，避免拖拽被取消时泄漏。 */
const DRAG_PAYLOAD_TTL_MS = 60_000;

export type CanvasAssetDragPayload = {
  title?: string;
  /** 返回 null 表示资源不可用（例如本地媒体已被清理）。 */
  load: () => Promise<InsertableAsset | null>;
};

const payloads = new Map<string, CanvasAssetDragPayload>();
let nextPayloadId = 0;

type DragDataTransfer = Pick<DataTransfer, "types" | "setData" | "getData" | "effectAllowed">;

export function startCanvasAssetDrag(
  dataTransfer: DragDataTransfer | null,
  payload: CanvasAssetDragPayload,
): void {
  if (!dataTransfer) return;
  const id = `canvas-asset-${Date.now().toString(36)}-${(nextPayloadId += 1)}`;
  payloads.set(id, payload);
  globalThis.setTimeout(() => payloads.delete(id), DRAG_PAYLOAD_TTL_MS);
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(CANVAS_ASSET_DRAG_TYPE, id);
  // 部分浏览器（Firefox）只有设置文本类型才会启动拖拽；给外部应用的
  // text/plain 也顺带提供标题，但画布只认上面的私有 MIME。
  dataTransfer.setData("text/plain", payload.title ?? "");
}

export function hasCanvasAssetDrag(dataTransfer: Pick<DataTransfer, "types"> | null): boolean {
  if (!dataTransfer) return false;
  return Array.from(dataTransfer.types).includes(CANVAS_ASSET_DRAG_TYPE);
}

export function takeCanvasAssetDrag(
  dataTransfer: Pick<DataTransfer, "getData"> | null,
): CanvasAssetDragPayload | null {
  if (!dataTransfer) return null;
  const id = dataTransfer.getData(CANVAS_ASSET_DRAG_TYPE);
  if (!id) return null;
  const payload = payloads.get(id) ?? null;
  payloads.delete(id);
  return payload;
}

/** 仅测试用：清空登记表，避免用例之间互相影响。 */
export function resetCanvasAssetDragRegistry(): void {
  payloads.clear();
}
