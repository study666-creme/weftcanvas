import type { CanvasMedia, CanvasNodeKind } from "@kachang/contracts";

/** 画布可插入对象：媒体节点（image/video/audio）或纯文本节点。社区弹层/资源面板复用。 */
export type InsertableAsset = {
  kind: CanvasNodeKind;
  body: string;
  media: CanvasMedia | null;
  /** 多图卡片：其余图片依次排布在主图右侧。 */
  extraMedia: CanvasMedia[];
};
