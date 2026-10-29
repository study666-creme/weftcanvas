/**
 * 「把素材交给 Agent」的落点与可引用判定。
 *
 * 三个入口共用这里：从节点端口拖线到 Agent 引用口（或 Agent 形象）、把整个节点拖到
 * 引用口 / 形象身上、点引用口的加号在面板里勾选。Agent 形象与引用口都在 ReactFlow
 * 的节点层之外，连线与节点拖拽都由 xyflow 捕获指针，松手事件不会落到它们身上，所以
 * 只能用松手坐标判定。
 */

export type CompanionDropNode = {
  id: string;
  data: {
    kind?: string;
    media?: { name: string } | null;
  };
};

export type DragPointerEvent = MouseEvent | TouchEvent | PointerEvent;

/** d3-drag 的原生事件在鼠标/触笔下带 clientX/Y，触屏只有 changedTouches。 */
export function dragEventPoint(event: DragPointerEvent): { x: number; y: number } | null {
  if ("clientX" in event && typeof event.clientX === "number") {
    return { x: event.clientX, y: event.clientY };
  }
  const touch = "changedTouches" in event ? event.changedTouches[0] : undefined;
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
}

/** `padding` 把命中区向外扩一圈：小圆形目标不要求鼠标正好落在像素边界以内。 */
export function isPointOverElement(
  x: number,
  y: number,
  element: Element | null,
  padding = 0,
): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  if (!rect.width && !rect.height) return false;
  return (
    x >= rect.left - padding &&
    x <= rect.right + padding &&
    y >= rect.top - padding &&
    y <= rect.bottom + padding
  );
}

/** 只有带图片/视频素材的节点能作为 Agent 参考素材；返回 null 表示不可引用。 */
export function companionLinkableKind(node: CompanionDropNode): "image" | "video" | null {
  if (!node.data.media) return null;
  if (node.data.kind === "image") return "image";
  if (node.data.kind === "video") return "video";
  return null;
}

export type AgentLinkRejection = "missing" | "unsupported" | "linked" | "full";

export type AgentLinkVerdict =
  { ok: true; kind: "image" | "video" } | { ok: false; reason: AgentLinkRejection };

/** 这个节点现在能不能引用给 Agent；拖线开始时用来预告，松手时用来裁决。 */
export function agentLinkVerdict(
  node: CompanionDropNode | null | undefined,
  linkedNodeIds: readonly string[],
  maxLinked: number,
): AgentLinkVerdict {
  if (!node) return { ok: false, reason: "missing" };
  const kind = companionLinkableKind(node);
  if (!kind) return { ok: false, reason: "unsupported" };
  if (linkedNodeIds.includes(node.id)) return { ok: false, reason: "linked" };
  if (linkedNodeIds.length >= maxLinked) return { ok: false, reason: "full" };
  return { ok: true, kind };
}

export function agentLinkRejectionMessage(reason: AgentLinkRejection, maxLinked: number) {
  switch (reason) {
    case "linked":
      return "这个节点已经引用给 Agent 了";
    case "full":
      return `最多引用 ${maxLinked} 个素材节点`;
    case "missing":
      return "这个节点已经不在画布上了";
    default:
      return "只有带图片或视频的节点能引用给 Agent";
  }
}
