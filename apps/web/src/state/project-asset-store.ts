import { create } from "zustand";

import {
  createProjectAssetCategory,
  ensureProjectAssetCategories,
  listProjectAssetCategories,
  listProjectAssetItems,
  listProjectAssetTombstoneSourceIds,
  PROJECT_ASSET_INBOX_BY_KIND,
  removeProjectAssetCategory,
  removeProjectAssetItem,
  removeProjectAssetTombstone,
  renameProjectAssetCategory,
  renameProjectAssetItem,
  saveProjectAssetFromMedia,
  saveProjectPromptAsset,
  setProjectAssetItemCategory,
  type ProjectAssetCategory,
  type ProjectAssetItem,
  type ProjectAssetKind,
} from "../lib/asset-library-store";
import { collectCanvasMediaCaptures, projectAssetKindOfMedia } from "../lib/project-asset-capture";
import type { CanvasMedia } from "@kachang/contracts";
import { useCanvasStore } from "./canvas-store";
import { useToastStore } from "./toast-store";

export type ProjectAssetCategoryFilter = "all" | "uncategorized" | string;
export type ProjectAssetKindFilter = "all" | ProjectAssetKind;

type ProjectAssetState = {
  open: boolean;
  /** 面板当前展示的项目范围（画布 projectId）。 */
  scopeId: string | null;
  categories: ProjectAssetCategory[];
  items: ProjectAssetItem[];
  status: "idle" | "loading" | "ready" | "error";
  query: string;
  categoryFilter: ProjectAssetCategoryFilter;
  kindFilter: ProjectAssetKindFilter;
  /** 面板收起期间自动收集到的数量，打开时清零（触发按钮上的小角标）。 */
  pendingNew: number;
  toggle: () => void;
  setOpen: (open: boolean) => void;
  setQuery: (query: string) => void;
  setCategoryFilter: (filter: ProjectAssetCategoryFilter) => void;
  setKindFilter: (filter: ProjectAssetKindFilter) => void;
  refresh: () => Promise<void>;
  createCategory: (name: string) => Promise<boolean>;
  renameCategory: (categoryId: string, name: string) => Promise<boolean>;
  removeCategory: (categoryId: string) => Promise<boolean>;
  moveItem: (itemId: string, categoryId: string | null) => Promise<void>;
  renameItem: (itemId: string, name: string) => Promise<boolean>;
  removeItem: (itemId: string) => Promise<void>;
  /** 画布节点右键「存入工作资产库」：媒体入堆放区，纯文本入提示词。 */
  saveNodeAsset: (input: { media: CanvasMedia | null; body: string }) => Promise<boolean>;
  savePrompt: (input: { name: string; prompt: string }) => Promise<boolean>;
};

export const useProjectAssetStore = create<ProjectAssetState>((set, get) => ({
  open: false,
  scopeId: null,
  categories: [],
  items: [],
  status: "idle",
  query: "",
  categoryFilter: "all",
  kindFilter: "all",
  pendingNew: 0,

  toggle: () => get().setOpen(!get().open),

  setOpen: (open) => {
    if (!open) {
      set({ open: false, query: "" });
      return;
    }
    const scopeId = useCanvasStore.getState().projectId;
    set({ open: true, scopeId, query: "", pendingNew: 0, status: get().scopeId === scopeId && get().status === "ready" ? "ready" : "loading" });
    void get().refresh();
  },

  setQuery: (query) => set({ query }),
  setCategoryFilter: (categoryFilter) => set({ categoryFilter }),
  setKindFilter: (kindFilter) => set({ kindFilter }),

  refresh: async () => {
    const scopeId = useCanvasStore.getState().projectId;
    set({ scopeId, status: get().status === "ready" && get().scopeId === scopeId ? "ready" : "loading" });
    try {
      const [categories, items] = await Promise.all([
        ensureProjectAssetCategories(scopeId),
        listProjectAssetItems(scopeId),
      ]);
      // 面板打开期间切换了项目：旧项目的结果不再写入。
      if (get().open && get().scopeId === scopeId) set({ categories, items, status: "ready" });
      else if (!get().open) set({ categories, items, status: "ready" });
    } catch {
      if (get().scopeId === scopeId) set({ status: "error" });
    }
  },

  createCategory: async (name) => {
    try {
      await createProjectAssetCategory(useCanvasStore.getState().projectId, name);
      await get().refresh();
      useToastStore.getState().show(`文件夹「${name.trim().slice(0, 24)}」已创建`, "success");
      return true;
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "文件夹创建失败"), "error");
      return false;
    }
  },

  renameCategory: async (categoryId, name) => {
    try {
      await renameProjectAssetCategory(useCanvasStore.getState().projectId, categoryId, name);
      await get().refresh();
      return true;
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "文件夹重命名失败"), "error");
      return false;
    }
  },

  removeCategory: async (categoryId) => {
    const category = get().categories.find((item) => item.id === categoryId);
    try {
      await removeProjectAssetCategory(useCanvasStore.getState().projectId, categoryId);
      if (get().categoryFilter === categoryId) set({ categoryFilter: "uncategorized" });
      await get().refresh();
      useToastStore.getState().show(`已删除文件夹「${category?.name ?? ""}」，其中资产已移至未分类`, "success");
      return true;
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "文件夹删除失败"), "error");
      return false;
    }
  },

  moveItem: async (itemId, categoryId) => {
    try {
      await setProjectAssetItemCategory(useCanvasStore.getState().projectId, itemId, categoryId);
      await get().refresh();
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "分类更新失败"), "error");
    }
  },

  renameItem: async (itemId, name) => {
    try {
      await renameProjectAssetItem(useCanvasStore.getState().projectId, itemId, name);
      await get().refresh();
      return true;
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "资产重命名失败"), "error");
      return false;
    }
  },

  removeItem: async (itemId) => {
    try {
      await removeProjectAssetItem(useCanvasStore.getState().projectId, itemId);
      await get().refresh();
      useToastStore.getState().show("资产已删除", "success");
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "资产删除失败"), "error");
    }
  },

  saveNodeAsset: async ({ media, body }) => {
    const scopeId = useCanvasStore.getState().projectId;
    const prompt = body.trim();
    try {
      if (media) {
        const kind = projectAssetKindOfMedia(media);
        if (!kind) {
          useToastStore.getState().show("该资产类型暂不支持入库", "error");
          return false;
        }
        const [items, categories] = await Promise.all([
          listProjectAssetItems(scopeId),
          listProjectAssetCategories(scopeId),
        ]);
        const already = items.some((item) => item.sourceId === media.id && item.kind !== "prompt");
        await saveProjectAssetFromMedia(scopeId, {
          media,
          kind,
          name: prompt,
          prompt,
          categoryId: captureCategoryId(kind, categories),
          source: "canvas",
        });
        // 手动入库意味着用户明确要它：清掉墓碑，之后删除前不再被自动收集忽略。
        await removeProjectAssetTombstone(scopeId, media.id);
        await get().refresh();
        useToastStore.getState().show(already ? "已在工作资产库" : "已存入工作资产库", "success");
        return true;
      }
      if (!prompt) {
        useToastStore.getState().show("这个节点没有可入库的内容", "error");
        return false;
      }
      const items = await listProjectAssetItems(scopeId);
      if (items.some((item) => item.kind === "prompt" && item.prompt === prompt)) {
        useToastStore.getState().show("已在工作资产库", "success");
        return true;
      }
      await saveProjectPromptAsset(scopeId, { name: "", prompt, categoryId: promptFallbackCategoryId(get()) });
      await get().refresh();
      useToastStore.getState().show("已存入工作资产库", "success");
      return true;
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "存入工作资产库失败"), "error");
      return false;
    }
  },

  savePrompt: async (input) => {
    // 当前选中的具体文件夹优先（含默认分类），没有合适落点时优先「提示词资产」，
    // 它被删了就落未分类——默认分类可删除，兜底不能假设它一定存在。
    const { categoryFilter, categories } = get();
    const filterValid = categoryFilter !== "all" && categoryFilter !== "uncategorized"
      && categories.some((category) => category.id === categoryFilter);
    const categoryId = filterValid ? categoryFilter : promptFallbackCategoryId(get());
    try {
      await saveProjectPromptAsset(useCanvasStore.getState().projectId, { ...input, categoryId });
      await get().refresh();
      useToastStore.getState().show("提示词已存入资产库", "success");
      return true;
    } catch (cause) {
      useToastStore.getState().show(errorMessage(cause, "提示词保存失败"), "error");
      return false;
    }
  },
}));

/** 提示词资产的兜底落点：「提示词资产」默认分类还在就用它，被删了落未分类。 */
function promptFallbackCategoryId(state: { categories: ProjectAssetCategory[] }) {
  return state.categories.some((category) => category.id === "pcat:prompt") ? "pcat:prompt" : null;
}

/**
 * 自动收集/手动入库的落点：图片、视频、音频各进自己的堆放区。
 * 堆放区被用户删掉时回落到未分类，绝不写进一个不存在的分类。
 */
function captureCategoryId(kind: Exclude<ProjectAssetKind, "prompt">, categories: ProjectAssetCategory[]) {
  const inboxId = PROJECT_ASSET_INBOX_BY_KIND[kind];
  return categories.some((category) => category.id === inboxId) ? inboxId : null;
}

/** 自动收集把新资产写进库里后调用：面板开着就刷新，收着就累计角标。 */
function notifyExternalCapture(scopeId: string, count: number) {
  const state = useProjectAssetStore.getState();
  if (!state.open || state.scopeId !== scopeId) {
    useProjectAssetStore.setState({ pendingNew: state.pendingNew + count });
    return;
  }
  void state.refresh();
}

/** 项目切换后让打开着的面板跟上新项目的库。 */
function notifyScopeChanged(scopeId: string) {
  const state = useProjectAssetStore.getState();
  if (!state.open || state.scopeId === scopeId) return;
  useProjectAssetStore.setState({ scopeId, status: "loading", categoryFilter: "all" });
  void state.refresh();
}

// ===================== 自动收集引擎 =====================

const CAPTURE_DEBOUNCE_MS = 420;

let engineStarted = false;
let seededScopeId: string | null = null;
let seedReady = false;
const knownSourceIds = new Set<string>();
const captureQueue = new Map<string, { media: CanvasMedia; kind: Exclude<ProjectAssetKind, "prompt">; prompt: string }>();
let captureTimer: number | null = null;

/**
 * 画布资产自动入库：订阅画布 store，把新出现的媒体（生成结果、上传、
 * 导入、导演台截图）收进当前项目的资产库。全程后台进行，失败静默——
 * 收藏是锦上添花，不能打扰创作主流程。
 */
export function startProjectAssetAutoCapture() {
  if (engineStarted || typeof window === "undefined") return;
  engineStarted = true;
  void seedScope(useCanvasStore.getState().projectId);
  useCanvasStore.subscribe((state, previous) => {
    if (state.projectId !== previous.projectId) {
      void seedScope(state.projectId);
      return;
    }
    scheduleCaptureScan(state.projectId);
  });
}

async function seedScope(scopeId: string) {
  seededScopeId = scopeId;
  seedReady = false;
  knownSourceIds.clear();
  captureQueue.clear();
  if (captureTimer !== null) {
    window.clearTimeout(captureTimer);
    captureTimer = null;
  }
  try {
    const [items, tombstones] = await Promise.all([
      listProjectAssetItems(scopeId),
      listProjectAssetTombstoneSourceIds(scopeId),
    ]);
    if (seededScopeId !== scopeId) return;
    for (const item of items) if (item.sourceId) knownSourceIds.add(item.sourceId);
    for (const sourceId of tombstones) knownSourceIds.add(sourceId);
  } catch {
    // 种子失败也要放行扫描：入库本身按 sourceId 幂等，最坏是重复写入被去重。
  }
  if (seededScopeId !== scopeId) return;
  seedReady = true;
  notifyScopeChanged(scopeId);
  scheduleCaptureScan(scopeId);
}

function scheduleCaptureScan(scopeId: string) {
  if (!seedReady || seededScopeId !== scopeId) return;
  const canvas = useCanvasStore.getState();
  for (const capture of collectCanvasMediaCaptures(canvas.nodes)) {
    if (knownSourceIds.has(capture.media.id)) continue;
    captureQueue.set(capture.media.id, capture);
  }
  if (!captureQueue.size) return;
  if (captureTimer !== null) return;
  captureTimer = window.setTimeout(() => {
    captureTimer = null;
    void flushCaptureQueue();
  }, CAPTURE_DEBOUNCE_MS);
}

async function flushCaptureQueue() {
  const scopeId = useCanvasStore.getState().projectId;
  if (!captureQueue.size) return;
  if (seededScopeId !== scopeId) {
    captureQueue.clear();
    return;
  }
  const entries = [...captureQueue.values()];
  captureQueue.clear();
  let captured = 0;
  // 音频没有专属堆放区：归「声音资产」，被删了就落未分类（每次收集时现查，不缓存）。
  const categories = await listProjectAssetCategories(scopeId);
  for (const entry of entries) {
    try {
      await saveProjectAssetFromMedia(scopeId, {
        media: entry.media,
        kind: entry.kind,
        name: entry.prompt,
        prompt: entry.prompt,
        categoryId: captureCategoryId(entry.kind, categories),
        source: "canvas",
      });
      knownSourceIds.add(entry.media.id);
      captured += 1;
    } catch {
      // 单个入库失败不阻断其余资产，也不弹打扰。
    }
  }
  if (captured) notifyExternalCapture(scopeId, captured);
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}
