import { Database, Eraser, TriangleAlert, X } from "lucide-react";
import { memo, useEffect } from "react";
import type { ReactNode } from "react";

import { useCloudProjectStore } from "../state/cloud-project-store";
import { useCloudResourceStore } from "../state/cloud-resource-store";
import { useStorageTipStore } from "../state/storage-tip-store";

function formatGb(bytes: number) {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}

function daysRemaining(deadline: string) {
  const ms = Date.parse(deadline) - Date.now();
  return Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/**
 * 云端素材配额贴士条：挂在顶栏下方、画布上方，可叉掉；不是弹窗、不阻断
 * 操作。叉掉只对当前严重程度生效，用量恶化（更严重档位或百分比上升 ≥5）
 * 时自动重新出现。可见性由 storage-tip-store 计算（usage 由 cloud-project
 * store 的 refresh 驱动重算）。
 */
export const StorageTipBanner = memo(function StorageTipBanner() {
  const usage = useCloudProjectStore((state) => state.usage);
  const ownerId = useCloudProjectStore((state) => state.ownerId);
  const visible = useStorageTipStore((state) => state.visible);
  const level = useStorageTipStore((state) => state.level);
  const percent = useStorageTipStore((state) => state.percent);
  const dismiss = useStorageTipStore((state) => state.dismiss);
  const openCloudResources = useCloudResourceStore((state) => state.openDialog);

  useEffect(() => {
    // usage 为 null（登出/未登录）时重置贴士状态。
    if (!ownerId) useStorageTipStore.getState().reset();
  }, [ownerId]);

  if (!ownerId || !visible || !level || !usage) return null;

  const quota = usage.entitlements.mediaStorageBytes;
  const used = usage.mediaStorageBytes;

  let body: ReactNode;
  if (level === "grace" && usage.storageGrace) {
    body = (
      <>
        <strong>云端空间将在 {daysRemaining(usage.storageGrace.deadline)} 天后调整</strong>
        <span>
          会员配额已变化（已用 {formatGb(usage.storageGrace.usageBytes)} / 可用 {formatGb(usage.storageGrace.quotaBytes)}）。
          请整理素材或续费会员；到期后将自动从最旧的未绑定素材开始清理至配额内，画布节点引用的素材最后才会被清理。
        </span>
      </>
    );
  } else if (level === "over") {
    body = (
      <>
        <strong>云端素材空间已用满</strong>
        <span>继续保存将自动清理最旧的未绑定素材为新内容腾出空间（已用 {formatGb(used)} / {formatGb(quota)}）。</span>
      </>
    );
  } else {
    body = (
      <>
        <strong>云端素材空间即将用满（{percent}%）</strong>
        <span>
          已用 {formatGb(used)} / {formatGb(quota)}。用满后继续使用将自动清理最旧的未绑定素材。
        </span>
      </>
    );
  }

  return (
    <div
      className={`kc-storage-tip kc-storage-tip--${level}`}
      role="status"
      data-quota-level={level}
    >
      {level === "nearing" || level === "critical" ? <Database aria-hidden="true" /> : <TriangleAlert aria-hidden="true" />}
      <div className="kc-storage-tip-body">{body}</div>
      <button type="button" className="kc-storage-tip-clean" onClick={openCloudResources}>
        <Eraser aria-hidden="true" />清理云端资源
      </button>
      <button type="button" className="kc-storage-tip-close" aria-label="关闭提示" onClick={dismiss}>
        <X aria-hidden="true" />
      </button>
    </div>
  );
});
