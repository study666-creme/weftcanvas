import type { CloudProjectUsage } from "@weftcanvas/contracts";
import { create } from "zustand";

/**
 * 云端素材配额贴士：用量接近/超出配额时在画布顶部挂一条可叉掉的提示条
 * （非弹窗）。叉掉只对“当前严重程度”生效——用量继续恶化（百分比上升或
 * 进入更严重的档位）时贴士自动重新出现，保证足够的缓冲提醒。
 */

export type StorageTipLevel = "nearing" | "critical" | "over" | "grace";

export type StorageTipState = {
  usage: CloudProjectUsage | null;
  visible: boolean;
  /** 由 usage 计算出的当前档位；null = 无需提示。 */
  level: StorageTipLevel | null;
  /** 当前档位对应的用量百分比（grace 态无百分比）。 */
  percent: number | null;
  reevaluate: (
    usage: CloudProjectUsage | null,
    grace?: CloudProjectUsage["storageGrace"] | null,
  ) => void;
  dismiss: () => void;
  reset: () => void;
};

const DISMISSED_KEY = "weftcanvas:storage-tip-dismissed:v1";
const NEARING_THRESHOLD = 0.8;
const CRITICAL_THRESHOLD = 0.95;

type DismissedRecord = { level: StorageTipLevel; percent: number; dismissedAt: number };

function readDismissed(): DismissedRecord | null {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DismissedRecord;
    if (typeof parsed.level !== "string" || typeof parsed.percent !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeDismissed(record: DismissedRecord | null) {
  try {
    if (!record) window.localStorage.removeItem(DISMISSED_KEY);
    else window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(record));
  } catch {
    /* localStorage 不可用时贴士不可关闭，功能不受影响 */
  }
}

const LEVEL_SEVERITY: Record<StorageTipLevel, number> = {
  nearing: 0,
  critical: 1,
  over: 2,
  grace: 3,
};

/**
 * 判断 dismissed 记录是否仍应压制当前提示：
 * - 更严重档位 → 重新出现；
 * - 同档位但百分比恶化超过 5 个百分点 → 重新出现（渐进恶化仍可见）。
 */
function suppressionStillValid(
  dismissed: DismissedRecord,
  level: StorageTipLevel,
  percent: number | null,
) {
  if (LEVEL_SEVERITY[level] > LEVEL_SEVERITY[dismissed.level]) return false;
  if (percent !== null && dismissed.percent !== null && percent - dismissed.percent >= 5)
    return false;
  return true;
}

export function quotaLevel(usage: CloudProjectUsage | null): {
  level: StorageTipLevel | null;
  percent: number | null;
} {
  if (!usage) return { level: null, percent: null };
  const quota = usage.entitlements.mediaStorageBytes;
  if (!quota) return { level: null, percent: null };
  const percent = Math.round((usage.mediaStorageBytes / quota) * 1000) / 10;
  if (usage.mediaStorageBytes > quota) return { level: "over", percent };
  if (percent >= CRITICAL_THRESHOLD * 100) return { level: "critical", percent };
  if (percent >= NEARING_THRESHOLD * 100) return { level: "nearing", percent };
  return { level: null, percent };
}

export const useStorageTipStore = create<StorageTipState>((set, get) => ({
  usage: null,
  visible: false,
  level: null,
  percent: null,

  reevaluate: (usage, grace) => {
    const { level: quotaTipLevel, percent } = quotaLevel(usage);
    const graceActive = !!grace && !!grace.deadline && Date.parse(grace.deadline) > Date.now();
    const level: StorageTipLevel | null = graceActive ? "grace" : quotaTipLevel;
    if (!level) {
      writeDismissed(null);
      set({ usage, visible: false, level: null, percent: null });
      return;
    }
    const dismissed = readDismissed();
    const visible = !dismissed || !suppressionStillValid(dismissed, level, percent);
    set({ usage, visible, level, percent });
  },

  dismiss: () => {
    const { level, percent } = get();
    if (!level) return;
    writeDismissed({ level, percent: percent ?? 0, dismissedAt: Date.now() });
    set({ visible: false });
  },

  reset: () => {
    set({ usage: null, visible: false, level: null, percent: null });
    writeDismissed(null);
  },
}));
