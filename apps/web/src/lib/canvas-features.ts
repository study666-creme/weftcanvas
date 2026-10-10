import { canvasNodeKinds, type CanvasNodeKind } from "@kachang/contracts";

/**
 * 剪辑工作台已上线：剪辑节点创建入口随 creatableNodeKinds 恢复；
 * 时间线同时支持本地/服务器媒体和音乐链接解析出的流式音频
 * （见 clip-composition.collectEditAssets 的 sourceUrl 通道）。
 */
export const CLIP_EDITOR_AVAILABLE = true;

/** 当前不对外提供的节点类型。只影响"新建"，不影响已存在节点的渲染。 */
const HIDDEN_NODE_KINDS: CanvasNodeKind[] = CLIP_EDITOR_AVAILABLE ? [] : ["edit"];

/**
 * 所有"新建节点"入口（底部新建栏、画布右键菜单、连线落点菜单、节点加号）
 * 统一用这份列表，避免漏掉一处又把剪辑节点暴露出去。
 */
export const creatableNodeKinds: CanvasNodeKind[] = canvasNodeKinds.filter(
  (kind) => !HIDDEN_NODE_KINDS.includes(kind),
);
