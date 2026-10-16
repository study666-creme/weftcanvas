import type {
  CanvasImportNode,
  CanvasImportPreview,
  CanvasMedia,
  CanvasNodeData,
  CanvasNodeKind,
} from "@weftcanvas/contracts";
import type { XYPosition } from "@xyflow/react";

import { storeMedia } from "./media-store";

/**
 * 第三方画布导入的浏览器侧：把预览里的相对布局摆到当前视口中心，再逐个把素材
 * 经同源代理路径拉进本地媒体库（与拖入本地文件同一条落库路径）。
 *
 * 素材字节不进服务端存储：导入的是别人的画布内容，没有理由占用创作者的云端配额；
 * 节点里也只存本地媒体 id，不落任何第三方直链。
 */

/** 导入节点的尺寸范围：对方画布可能有大图或细长条，画布上的节点是预览，收进可读框。 */
const IMPORT_MAX_LONG_EDGE = 720;
const IMPORT_MIN_SHORT_EDGE = 120;
const IMPORT_FALLBACK_SIZE = { width: 180, height: 120 } as const;

export type ImportedGraphPlanNode = {
  key: string;
  kind: CanvasNodeKind;
  position: XYPosition;
  width: number;
  height: number;
  data: Partial<CanvasNodeData>;
};

export type ImportedGraphPlan = {
  nodes: ImportedGraphPlanNode[];
  edges: Array<{ sourceIndex: number; targetIndex: number }>;
};

/**
 * 整块居中：先算来源画布的包围盒，再平移，让包围盒中心落在 anchor 上，
 * 节点之间的相对位置与来源完全一致（导入后不会散成一堆）。
 */
export function planImportedGraph(
  preview: CanvasImportPreview,
  anchor: XYPosition,
): ImportedGraphPlan {
  const source = preview.nodes;
  if (!source.length) return { nodes: [], edges: [] };
  const minX = Math.min(...source.map((node) => node.position.x));
  const minY = Math.min(...source.map((node) => node.position.y));
  const maxX = Math.max(...source.map((node) => node.position.x + node.width));
  const maxY = Math.max(...source.map((node) => node.position.y + node.height));
  const offsetX = anchor.x - (minX + maxX) / 2;
  const offsetY = anchor.y - (minY + maxY) / 2;

  const indexByKey = new Map<string, number>();
  const nodes = source.map((node, index) => {
    indexByKey.set(node.key, index);
    const size = fitImportedSize(node);
    return {
      key: node.key,
      kind: node.kind as CanvasNodeKind,
      position: { x: node.position.x + offsetX, y: node.position.y + offsetY },
      width: size.width,
      height: size.height,
      data: importedNodeData(node, preview),
    };
  });

  const edges: ImportedGraphPlan["edges"] = [];
  for (const edge of preview.edges) {
    const sourceIndex = indexByKey.get(edge.source);
    const targetIndex = indexByKey.get(edge.target);
    if (sourceIndex === undefined || targetIndex === undefined) continue;
    edges.push({ sourceIndex, targetIndex });
  }
  return { nodes, edges };
}

/** 视口中心对应的画布坐标：与画布插入动作的落点换算保持一致（screen → flow）。 */
export function viewportCenterInFlow(
  viewport: { x: number; y: number; zoom: number },
  size: { width: number; height: number } = {
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  },
): XYPosition {
  const zoom = Number.isFinite(viewport.zoom) && viewport.zoom > 0 ? viewport.zoom : 1;
  return {
    x: (size.width / 2 - viewport.x) / zoom,
    y: (size.height / 2 - viewport.y) / zoom,
  };
}

/**
 * 节点数据：文本节点把正文写进 body；图片/视频/音频节点的 body 留给来源提示词
 * （节点上不显示它，但换 kind、复用配置、导出时都还在）。来源身份写进
 * importedFrom，重复导入能认出同一个来源节点。
 */
export function importedNodeData(
  node: CanvasImportNode,
  preview: CanvasImportPreview,
  now = Date.now(),
): Partial<CanvasNodeData> {
  const failed = node.status === "error";
  return {
    body: node.kind === "text" ? node.body || node.prompt : node.prompt,
    // 有素材的节点先挂"取素材中"，取到后置回 false；对方的占位/失败节点不挂。
    ...(node.asset ? { uploading: true } : {}),
    status: failed ? ("error" as const) : ("idle" as const),
    ...(failed && node.error
      ? { generation: { error: node.error } as CanvasNodeData["generation"] }
      : {}),
    importedFrom: {
      provider: preview.provider,
      sourceId: preview.sourceId,
      sourceName: preview.projectName,
      nodeKey: node.key,
      batchId: preview.batchId,
      sourceType: node.sourceType,
      importedAt: now,
    },
  };
}

/**
 * 按来源尺寸收进可读框：最长边不超过 720、最短边不小于 120，比例全程保持。
 * 两个约束冲突时（例如 1:10 的细长条）以长边上限为准——宁可细，不能超出画布可读范围。
 */
export function fitImportedSize(node: Pick<CanvasImportNode, "width" | "height">) {
  const rawWidth = Number.isFinite(node.width) && node.width > 0 ? node.width : 0;
  const rawHeight = Number.isFinite(node.height) && node.height > 0 ? node.height : 0;
  if (!rawWidth || !rawHeight) return { ...IMPORT_FALLBACK_SIZE };
  const longEdge = Math.max(rawWidth, rawHeight);
  const shortEdge = Math.min(rawWidth, rawHeight);
  let scale = Math.min(1, IMPORT_MAX_LONG_EDGE / longEdge);
  if (shortEdge * scale < IMPORT_MIN_SHORT_EDGE) {
    scale = Math.min(IMPORT_MAX_LONG_EDGE / longEdge, IMPORT_MIN_SHORT_EDGE / shortEdge);
  }
  return {
    width: Math.max(1, Math.round(rawWidth * scale)),
    height: Math.max(1, Math.round(rawHeight * scale)),
  };
}

/** 素材本地落库的类型：只有图片/视频/音频有字节，文本节点没有。 */
export function importedMediaKind(node: CanvasImportNode): "image" | "video" | "audio" | null {
  if (!node.asset) return null;
  if (node.kind === "image" || node.kind === "video" || node.kind === "audio") return node.kind;
  return null;
}

export function importedAssetFileName(node: CanvasImportNode, mimeType: string) {
  const extension = mimeType.split("/")[1]?.split("+")[0] ?? "bin";
  const base = (node.title || node.key).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60) || "导入素材";
  return `${base}.${extension === "jpeg" ? "jpg" : extension}`;
}

/** 取一个素材：同源代理路径 + 60 秒超时；失败原因原样抛出，由调用方如实报给用户。 */
export async function fetchImportedAsset(node: CanvasImportNode): Promise<CanvasMedia> {
  const kind = importedMediaKind(node);
  if (!node.asset || !kind) throw new Error("这个节点没有可取的素材");
  let response: Response;
  try {
    response = await fetch(node.asset.path, {
      credentials: "include",
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("素材下载超时或网络中断");
  }
  if (!response.ok) {
    throw new Error(await readAssetError(response));
  }
  const blob = await response.blob();
  const mimeType = blob.type || node.asset.mimeType;
  const file = new File([blob], importedAssetFileName(node, mimeType), { type: mimeType });
  return storeMedia(file, kind);
}

async function readAssetError(response: Response) {
  if (response.status === 413) return "这个素材超出了可导入的大小上限";
  if (response.status === 415) return "这个素材不是受支持的图片、视频或音频";
  if (response.status === 400) return "这个素材的地址不在允许代拉的域名里";
  try {
    const parsed = (await response.json()) as { error?: { message?: string } };
    if (parsed.error?.message) return parsed.error.message;
  } catch {
    // 代理路径只回 JSON 错误体；解析不出来就用下面的兜底文案。
  }
  return "素材暂时拉不到，节点已保留为占位";
}
