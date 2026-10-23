import { useUiPreferencesStore } from "../state/ui-preferences-store";

const SKIP_CLOUD_UPLOAD_KEY = "weftcanvas:cloud-media-preference:v1";

/**
 * “不再保存素材到云端”偏好。放在独立模块，避免 cloud-project-media 为了读这个
 * 开关反向依赖 cloud-resource-store（后者又依赖 cloud-project-store，形成环）。
 */
export function readSkipCloudUploads() {
  if (typeof localStorage === "undefined") return false;
  try {
    const raw = localStorage.getItem(SKIP_CLOUD_UPLOAD_KEY);
    if (!raw) return false;
    const value = JSON.parse(raw) as { skipCloudUploads?: unknown };
    return value.skipCloudUploads === true;
  } catch {
    return false;
  }
}

export function writeSkipCloudUploads(value: boolean) {
  try {
    localStorage.setItem(SKIP_CLOUD_UPLOAD_KEY, JSON.stringify({ skipCloudUploads: value }));
  } catch {
    // 隐私模式等存储不可用时仍保留本次会话的内存选择。
  }
}

/**
 * 同步读取当前开关：云同步在上传素材前调用。
 *
 * 两个入口都算「不上传云端」：清理云端资源里的旧开关，与设置 → 本地保存里
 * 的「只保存本地」——后者是创作者主动选择的数据边界，云项目保存同样不能
 * 把素材带上去。
 */
export function cloudUploadsSkipped() {
  if (readSkipCloudUploads()) return true;
  return useUiPreferencesStore.getState().localMediaOnly;
}
