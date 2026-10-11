import type { AssetLibraryCategory, AssetLibraryItem } from "../lib/asset-library-store";
import type { InsertableAsset } from "../lib/insertable-asset";

/**
 * 资源抽屉的「卡片库」面板 —— 公开版空壳（开源版没有托管账号内容库）。
 * 私有实现见私有树同名文件（物化时被本文件覆盖）：tab 隐藏、面板不渲染、
 * 预热不发起，抽屉只剩资产库。
 */
export const accountCardsTabAvailable = false;

export function useAccountCardsWarmth(_identityScope: string | null) {
  // no-op：开源版没有需要预热的远端内容库。
}

export function AccountCardsPanel(_props: {
  categories: AssetLibraryCategory[];
  assets: AssetLibraryItem[];
  authenticated: boolean;
  cacheScope: string | null;
  onAssetSaved: () => Promise<void>;
  onInsertAsset: (asset: InsertableAsset) => void;
  onClose: () => void;
}) {
  return null;
}
