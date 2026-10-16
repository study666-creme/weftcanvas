import { randomUUID } from "node:crypto";

import {
  canvasImportProviderLabels,
  type CanvasImportPreview,
  type CanvasImportProvider,
  type CanvasImportProviderStatus,
  type CanvasImportRequest,
} from "@weftcanvas/contracts";

import {
  adaptLibTVCanvas,
  adaptTapNowCanvas,
  adaptUpDreamShare,
  CanvasImportError,
  type CanvasImportDraft,
} from "./adapt.js";
import { parseCanvasImportReference } from "./reference.js";
import {
  fetchLibTVCanvasDetail,
  fetchTapNowCanvasShare,
  fetchUpDreamShare,
  type CanvasImportSourceOptions,
} from "./source.js";

/**
 * 导入编排：解析标识 → 读来源 → 适配成中间表示 → 换成契约里的预览。
 *
 * 除 LibTV 的画布令牌外没有任何服务端状态，也不需要数据库：素材字节不进服务端
 * 存储，由浏览器经同源代理路径拉进本地媒体库（与拖入本地文件同一条落库路径）。
 */
export const CANVAS_IMPORT_ASSET_PATH = "/api/v1/canvas-import/asset";

export type CanvasImportConfig = {
  /** LibTV 画布令牌：服务端配置，永远不下发到浏览器。 */
  libtvToken?: string;
  /** 出网实现覆盖（测试注入用）；缺省走全局 fetch。 */
  fetch?: typeof globalThis.fetch;
};

export type CanvasImportRuntimeOptions = CanvasImportSourceOptions & {
  now?: () => number;
  createId?: () => string;
};

/**
 * 来源可用性：LibTV 缺令牌时如实报不可用（前端禁用入口并说明还差哪一步），
 * 另外两个是公开分享链接，始终可用。
 */
export function canvasImportProviderStatus(
  config: CanvasImportConfig,
): CanvasImportProviderStatus[] {
  const hasLibTVToken = Boolean(config.libtvToken?.trim());
  return (["libtv", "tapnow", "updream"] as const).map((provider) => ({
    provider,
    available: provider !== "libtv" || hasLibTVToken,
    reason:
      provider === "libtv" && !hasLibTVToken
        ? "服务端尚未配置 LIBTV_CANVAS_TOKEN，LibTV 画布暂时导不进来"
        : "",
  }));
}

export async function loadCanvasImportPreview(
  request: CanvasImportRequest,
  config: CanvasImportConfig,
  options: CanvasImportRuntimeOptions = {},
): Promise<CanvasImportPreview> {
  const provider = request.provider;
  const sourceId = parseCanvasImportReference(provider, request.reference);
  if (!sourceId) {
    throw new CanvasImportError(
      400,
      "IMPORT_REFERENCE_INVALID",
      `没有认出有效的${canvasImportProviderLabels[provider]}标识，请检查链接或分享口令`,
    );
  }
  const runtime = {
    sourceId,
    now: options.now?.() ?? Date.now(),
    createId: options.createId ?? (() => randomUUID()),
    fetch: options.fetch ?? config.fetch,
  };
  let draft: CanvasImportDraft;
  if (provider === "libtv") {
    const token = config.libtvToken?.trim();
    if (!token) {
      throw new CanvasImportError(
        503,
        "IMPORT_PROVIDER_UNAVAILABLE",
        "服务端尚未配置 LIBTV_CANVAS_TOKEN，LibTV 画布暂时导不进来",
      );
    }
    const detail = await fetchLibTVCanvasDetail(sourceId, token, runtime);
    draft = adaptLibTVCanvas(detail, runtime);
  } else if (provider === "tapnow") {
    const detail = await fetchTapNowCanvasShare(sourceId, runtime);
    draft = adaptTapNowCanvas(detail, runtime);
  } else {
    const share = await fetchUpDreamShare(sourceId, runtime);
    draft = adaptUpDreamShare(share, runtime);
  }

  return {
    provider,
    sourceId,
    projectName: draft.projectName,
    batchId: draft.batchId,
    nodes: draft.nodes.map((node) => ({
      key: node.key,
      kind: node.kind,
      title: node.title,
      body: node.body,
      prompt: node.prompt,
      model: node.model,
      position: node.position,
      width: node.width,
      height: node.height,
      status: node.status,
      error: node.error,
      sourceType: node.sourceType,
      asset: node.asset
        ? {
            // 上游直链换成同源代理路径：浏览器只会请求这个路径。
            path: buildAssetProxyPath(provider, node.asset.url),
            mimeType: node.asset.mimeType,
            width: node.asset.width,
            height: node.asset.height,
            durationMs: node.asset.durationMs,
          }
        : null,
    })),
    edges: draft.edges,
    skipped: draft.skipped,
    warnings: draft.warnings,
  };
}

export function buildAssetProxyPath(provider: CanvasImportProvider, upstreamUrl: string) {
  const params = new URLSearchParams({ p: provider, u: upstreamUrl });
  return `${CANVAS_IMPORT_ASSET_PATH}?${params.toString()}`;
}
