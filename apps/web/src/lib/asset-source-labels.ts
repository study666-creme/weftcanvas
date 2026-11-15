import type { AssetLibraryItem } from "./asset-library-store";

/**
 * 公开树（物化覆盖）：没有卡片库，资产只有本地上传与画布产物两类来源。
 */
export const ASSET_SOURCE_LABEL: Record<AssetLibraryItem["source"], string> = {
  local: "本地上传",
  canvas: "生成作品",
};
