import type { CloudResource, CloudResourceUsage } from "@weftcanvas/contracts";
import { create } from "zustand";

import { cleanupCloudResources, listCloudResources, mediaContentPath } from "../lib/api-client";
import { ensureMediaAsset } from "../lib/asset-library-store";
import { readSkipCloudUploads, writeSkipCloudUploads } from "../lib/cloud-media-preference";
import { storeMedia } from "../lib/media-store";
import { useCloudProjectStore } from "./cloud-project-store";
import { useIdentityStore } from "./identity-store";
import { useToastStore } from "./toast-store";

type CloudResourceState = {
  open: boolean;
  loading: boolean;
  busy: boolean;
  items: CloudResource[];
  usage: CloudResourceUsage | null;
  error: string | null;
  selected: Record<string, true>;
  progress: { total: number; done: number } | null;
  /** 开启后新建/更新的项目只同步文档，素材留在本地，不再上传占用云端配额。 */
  skipCloudUploads: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  load: (force?: boolean) => Promise<void>;
  toggle: (id: string) => void;
  selectOrphans: () => void;
  clearSelection: () => void;
  setSkipCloudUploads: (value: boolean) => void;
  cleanup: (options: { saveLocally: boolean }) => Promise<void>;
  reset: () => void;
};

export const useCloudResourceStore = create<CloudResourceState>((set, get) => ({
  open: false,
  loading: false,
  busy: false,
  items: [],
  usage: null,
  error: null,
  selected: {},
  progress: null,
  skipCloudUploads: readSkipCloudUploads(),

  openDialog: () => {
    set({ open: true });
    void get().load(true);
  },

  closeDialog: () => {
    if (get().busy) return;
    set({ open: false });
  },

  load: async (force = false) => {
    if (get().loading && !force) return;
    const ownerId = currentOwnerId();
    if (!ownerId) {
      set({ items: [], usage: null, selected: {}, error: "登录后可以管理云端资源" });
      return;
    }
    set({ loading: true, error: null });
    try {
      const result = await listCloudResources();
      if (currentOwnerId() !== ownerId) return;
      set((state) => ({
        items: result.items,
        usage: result.usage,
        loading: false,
        // 已经不在列表里的选中项（被别处删掉/刷新后消失）一并清掉。
        selected: pruneSelection(state.selected, result.items),
      }));
    } catch (cause) {
      if (currentOwnerId() !== ownerId) return;
      set({ loading: false, error: cause instanceof Error ? cause.message : "云端资源读取失败" });
    }
  },

  toggle: (id) => {
    set((state) => {
      const next = { ...state.selected };
      if (next[id]) delete next[id];
      else next[id] = true;
      return { selected: next };
    });
  },

  selectOrphans: () => {
    const orphans = get().items.filter((item) => item.orphaned);
    set({ selected: Object.fromEntries(orphans.map((item) => [item.id, true as const])) });
  },

  clearSelection: () => set({ selected: {} }),

  setSkipCloudUploads: (value) => {
    writeSkipCloudUploads(value);
    set({ skipCloudUploads: value });
  },

  cleanup: async ({ saveLocally }) => {
    if (get().busy) return;
    const ownerId = currentOwnerId();
    if (!ownerId) return;
    const items = get().items;
    const byId = new Map(items.map((item) => [item.id, item]));
    // 只有“画布已删除的遗留素材”可清理；未绑定但在用的素材是本地画布的唯一副本，跳过。
    const targets: CloudResource[] = [];
    for (const id of Object.keys(get().selected)) {
      const item = byId.get(id);
      if (item && item.orphaned) targets.push(item);
    }
    if (!targets.length) {
      useToastStore.getState().show("请先选择要清理的云端资源", "info");
      return;
    }

    set({
      busy: true,
      error: null,
      progress: saveLocally ? { total: targets.length, done: 0 } : null,
    });
    try {
      if (saveLocally) {
        const failures: string[] = [];
        for (let index = 0; index < targets.length; index += 1) {
          const item = targets[index]!;
          try {
            await saveResourceLocally(item);
          } catch (cause) {
            failures.push(`${item.name}（${cause instanceof Error ? cause.message : "保存失败"}）`);
          }
          if (currentOwnerId() !== ownerId) return;
          set({ progress: { total: targets.length, done: index + 1 } });
        }
        if (failures.length) {
          // 有素材没能存到本地就整体放弃删除，避免“没存下来又清掉了”。
          throw new Error(`以下素材未能保存到本地，已取消清理：${failures.join("、")}`);
        }
      }

      const result = await cleanupCloudResources({ mediaIds: targets.map((item) => item.id) });
      if (currentOwnerId() !== ownerId) return;
      const freedLabel = formatBytes(result.freedBytes);
      const skippedReferenced = result.skipped.filter(
        (entry) => entry.reason === "referenced",
      ).length;
      useToastStore
        .getState()
        .show(
          skippedReferenced
            ? `已清理 ${result.deleted.length} 个云端资源（${freedLabel}），${skippedReferenced} 个仍被项目引用已跳过`
            : result.deleted.length
              ? `已清理 ${result.deleted.length} 个云端资源，释放 ${freedLabel}`
              : "没有可清理的云端资源",
          "success",
        );
      const removed = new Set(result.deleted.map((item) => item.id));
      set((state) => ({
        items: state.items.filter((item) => !removed.has(item.id)),
        usage: result.usage,
        selected: Object.fromEntries(
          Object.entries(state.selected).filter(([id]) => !removed.has(id)),
        ),
        busy: false,
        progress: null,
      }));
      void useCloudProjectStore.getState().refresh(ownerId, true);
    } catch (cause) {
      if (currentOwnerId() !== ownerId) return;
      const message = cause instanceof Error ? cause.message : "云端资源清理失败";
      set({ busy: false, progress: null, error: message });
      useToastStore.getState().show(message, "error");
    }
  },

  reset: () =>
    set({
      open: false,
      loading: false,
      busy: false,
      items: [],
      usage: null,
      error: null,
      selected: {},
      progress: null,
    }),
}));

/** 供 cloud-project-media 在同步前判断是否跳过素材上传。 */
async function saveResourceLocally(item: CloudResource) {
  const projectId = item.projectIds[0];
  const response = await fetch(mediaContentPath(item.id, projectId, { download: true }), {
    credentials: "include",
  });
  if (!response.ok) throw new Error("下载失败");
  const blob = await response.blob();
  const file = new File([blob], fileName(item), { type: item.mimeType || blob.type });
  const media = await storeMedia(file, item.kind);
  await ensureMediaAsset(media, item.kind, "local");
}

function fileName(item: CloudResource) {
  const extension = extensionForMime(item.mimeType);
  const base =
    (item.name || item.id).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").slice(0, 120) || item.id;
  return extension && !base.toLowerCase().endsWith(extension) ? `${base}.${extension}` : base;
}

function extensionForMime(mimeType: string) {
  const mime = mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  const known: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
  };
  if (known[mime]) return known[mime];
  const subtype = mime.split("/", 2)[1];
  return subtype && /^[a-z0-9]+$/.test(subtype) ? subtype : "";
}

function pruneSelection(selected: Record<string, true>, items: CloudResource[]) {
  const available = new Set(items.map((item) => item.id));
  return Object.fromEntries(Object.entries(selected).filter(([id]) => available.has(id)));
}

function currentOwnerId() {
  const identity = useIdentityStore.getState();
  return identity.status === "authenticated" ? (identity.session?.user.id ?? null) : null;
}

export function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  const gigabytes = bytes / (1024 * 1024 * 1024);
  return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
}
