import { createId } from "@weftcanvas/canvas-core";
import type { CanvasMedia } from "@weftcanvas/contracts";

const DATABASE_NAME = "weftcanvas-asset-library";
const DATABASE_VERSION = 3;
const ASSET_STORE_NAME = "assets";
const CATEGORY_STORE_NAME = "categories";
const SCOPED_ASSET_STORE_NAME = "scoped-assets";
const SCOPED_CATEGORY_STORE_NAME = "scoped-categories";
const SCOPED_TOMBSTONE_STORE_NAME = "scoped-tombstones";
const SCOPE_INDEX_NAME = "scopeId";

export type AssetLibraryKind = "card" | "image" | "video" | "audio" | "prompt";

export type AssetLibraryItem = {
  id: string;
  kind: AssetLibraryKind;
  name: string;
  prompt: string;
  media: CanvasMedia | null;
  /** 多图卡片除封面外的其余媒体（单图卡为空数组）。 */
  gallery: CanvasMedia[];
  categoryId: string | null;
  source: "local" | "canvas";
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AssetLibraryCategory = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      const transaction = request.transaction!;
      if (!database.objectStoreNames.contains(ASSET_STORE_NAME)) {
        database.createObjectStore(ASSET_STORE_NAME, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(CATEGORY_STORE_NAME)) {
        database.createObjectStore(CATEGORY_STORE_NAME, { keyPath: "id" });
      }
      // v2/v3 scoped stores：存量库已存在时复用，不存在时创建，保证 v3 库可正常打开
      const scopedStores: Array<[string, string]> = [
        [SCOPED_ASSET_STORE_NAME, "asset"],
        [SCOPED_CATEGORY_STORE_NAME, "category"],
        [SCOPED_TOMBSTONE_STORE_NAME, "tombstone"],
      ];
      for (const [storeName] of scopedStores) {
        const store = database.objectStoreNames.contains(storeName)
          ? transaction.objectStore(storeName)
          : database.createObjectStore(storeName, { keyPath: "storageId" });
        if (!store.indexNames.contains(SCOPE_INDEX_NAME)) {
          store.createIndex(SCOPE_INDEX_NAME, "scopeId");
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null; // 允许下次重试（此前失败会缓存 rejected promise，点重试也没用）
      reject(request.error ?? new Error("资产库无法打开"));
    };
  });
  return databasePromise;
}

export async function listAssetLibraryItems() {
  return readAll<AssetLibraryItem>(ASSET_STORE_NAME).then((items) =>
    items.sort((left, right) => right.updatedAt - left.updatedAt),
  );
}

export async function listAssetLibraryCategories() {
  return readAll<AssetLibraryCategory>(CATEGORY_STORE_NAME).then((categories) =>
    categories.sort((left, right) => left.createdAt - right.createdAt),
  );
}

export async function ensureMediaAsset(
  media: CanvasMedia,
  kind: Exclude<AssetLibraryKind, "card" | "prompt">,
  source: "local" | "canvas",
) {
  const items = await listAssetLibraryItems();
  const existing = items.find((item) => item.media?.id === media.id);
  if (existing) {
    if ((existing.media?.size ?? 0) > 0 || media.size <= 0) return existing;
    const repaired = { ...existing, media, updatedAt: Date.now() };
    await putRecord(ASSET_STORE_NAME, repaired);
    return repaired;
  }
  const now = Date.now();
  const item: AssetLibraryItem = {
    id: `asset:media:${media.id}`,
    kind,
    name: media.name,
    prompt: "",
    media,
    gallery: [],
    categoryId: null,
    source,
    sourceId: media.id,
    createdAt: now,
    updatedAt: now,
  };
  await putRecord(ASSET_STORE_NAME, item);
  return item;
}

export async function setAssetLibraryItemCategory(itemId: string, categoryId: string | null) {
  if (categoryId && !(await getRecord<AssetLibraryCategory>(CATEGORY_STORE_NAME, categoryId))) {
    throw new Error("分类不存在");
  }
  const item = await getRecord<AssetLibraryItem>(ASSET_STORE_NAME, itemId);
  if (!item) throw new Error("资产不存在");
  const next = { ...item, categoryId, updatedAt: Date.now() };
  await putRecord(ASSET_STORE_NAME, next);
  return next;
}

export async function removeAssetLibraryItem(itemId: string) {
  await deleteRecord(ASSET_STORE_NAME, itemId);
}

/** 新建一条纯提示词资产（没有媒体文件）。 */
export async function savePromptAssetItem(input: {
  name?: string;
  prompt: string;
  categoryId?: string | null;
}) {
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("提示词不能为空");
  const now = Date.now();
  const item: AssetLibraryItem = {
    id: createId("asset"),
    kind: "prompt",
    name: input.name?.trim() || prompt.slice(0, 24),
    prompt: prompt.slice(0, 4000),
    media: null,
    gallery: [],
    categoryId: input.categoryId ?? null,
    source: "local",
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  };
  await putRecord(ASSET_STORE_NAME, item);
  return item;
}

/** 修改资产的名称或提示词；图片/视频资产也能挂上提示词。 */
export async function updateAssetLibraryItem(
  itemId: string,
  patch: { name?: string; prompt?: string },
) {
  const item = await getRecord<AssetLibraryItem>(ASSET_STORE_NAME, itemId);
  if (!item) throw new Error("资产不存在");
  const next: AssetLibraryItem = {
    ...item,
    ...(patch.name !== undefined ? { name: patch.name.trim().slice(0, 64) || item.name } : {}),
    ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim().slice(0, 4000) } : {}),
    updatedAt: Date.now(),
  };
  await putRecord(ASSET_STORE_NAME, next);
  return next;
}

export async function createAssetLibraryCategory(name: string) {
  const normalized = normalizeCategoryName(name);
  const categories = await listAssetLibraryCategories();
  if (
    categories.some(
      (category) => category.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
    )
  ) {
    throw new Error("分类名称已存在");
  }
  const now = Date.now();
  const category: AssetLibraryCategory = {
    id: createId("category"),
    name: normalized,
    createdAt: now,
    updatedAt: now,
  };
  await putRecord(CATEGORY_STORE_NAME, category);
  return category;
}

export async function renameAssetLibraryCategory(categoryId: string, name: string) {
  const normalized = normalizeCategoryName(name);
  const categories = await listAssetLibraryCategories();
  if (
    categories.some(
      (category) =>
        category.id !== categoryId &&
        category.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
    )
  ) {
    throw new Error("分类名称已存在");
  }
  const category = categories.find((item) => item.id === categoryId);
  if (!category) throw new Error("分类不存在");
  const next = { ...category, name: normalized, updatedAt: Date.now() };
  await putRecord(CATEGORY_STORE_NAME, next);
  return next;
}

export async function removeAssetLibraryCategory(categoryId: string) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction([ASSET_STORE_NAME, CATEGORY_STORE_NAME], "readwrite");
    const assetStore = transaction.objectStore(ASSET_STORE_NAME);
    const categoryStore = transaction.objectStore(CATEGORY_STORE_NAME);
    const itemsRequest = assetStore.getAll();
    itemsRequest.onsuccess = () => {
      const now = Date.now();
      categoryStore.delete(categoryId);
      (itemsRequest.result as AssetLibraryItem[])
        .filter((item) => item.categoryId === categoryId)
        .forEach((item) => assetStore.put({ ...item, categoryId: null, updatedAt: now }));
    };
    itemsRequest.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? itemsRequest.error ?? new Error("分类删除失败"));
    transaction.onerror = () => reject(transaction.error ?? new Error("分类删除失败"));
  });
}

export async function collectAssetLibraryMediaIds() {
  if (typeof indexedDB === "undefined") return new Set<string>();
  const items = await listAssetLibraryItems();
  return new Set(
    items.flatMap((item) => [
      ...(item.media ? [item.media.id] : []),
      ...item.gallery.map((media) => media.id),
    ]),
  );
}

function normalizeCategoryName(name: string) {
  const normalized = name.trim().replace(/\s+/g, " ").slice(0, 24);
  if (!normalized) throw new Error("请输入分类名称");
  return normalized;
}

// ===================== 项目工作资产库（scopeId = 画布项目 id） =====================
// 复用 v3 schema 里预留的 scoped stores：每个画布项目一套独立的分类与资产，
// 资产记录 storageId = `${scopeId}:${itemId}`，scopeId 建索引按项目取整库。

export type ProjectAssetKind = "image" | "video" | "audio" | "prompt";

export type ProjectAssetItem = {
  id: string;
  kind: ProjectAssetKind;
  name: string;
  prompt: string;
  media: CanvasMedia | null;
  categoryId: string | null;
  source: "canvas" | "local" | "manual";
  /** 媒体资产的去重键（media.id）；提示词资产为 null。 */
  sourceId: string | null;
  createdAt: number;
  updatedAt: number;
};

export type ProjectAssetCategory = {
  id: string;
  name: string;
  builtin: boolean;
  createdAt: number;
  updatedAt: number;
};

/**
 * 自动收集的堆放区（按类型分开放置，不可删除）：生成的图片、视频各归各位，
 * 由创作者再分拣到下面的默认分类或自建文件夹。
 */
export const PROJECT_ASSET_IMAGE_INBOX_CATEGORY_ID = "pcat:image";
export const PROJECT_ASSET_VIDEO_INBOX_CATEGORY_ID = "pcat:video";
export const PROJECT_ASSET_AUDIO_INBOX_CATEGORY_ID = "pcat:audio";

/**
 * 新项目默认不再预置「人物/场景/声音/提示词」这类文件夹——项目资产库和全站
 * 资产库保持同一套心智：默认只有按类型的堆放区（图片/视频/音频）+ 一个未分类，
 * 其余文件夹由用户按自己的项目建。
 */
export const PROJECT_ASSET_DEFAULT_CATEGORIES: ReadonlyArray<{ id: string; name: string }> = [];

/** 系统分类及展示顺序（堆放区在最前）。 */
export const PROJECT_ASSET_SYSTEM_CATEGORIES = [
  { id: PROJECT_ASSET_IMAGE_INBOX_CATEGORY_ID, name: "图片资产" },
  { id: PROJECT_ASSET_VIDEO_INBOX_CATEGORY_ID, name: "视频资产" },
  { id: PROJECT_ASSET_AUDIO_INBOX_CATEGORY_ID, name: "音频资产" },
] as const;

/** 图片/视频/音频自动收集的固定落点。 */
export const PROJECT_ASSET_INBOX_BY_KIND = {
  image: PROJECT_ASSET_IMAGE_INBOX_CATEGORY_ID,
  video: PROJECT_ASSET_VIDEO_INBOX_CATEGORY_ID,
  audio: PROJECT_ASSET_AUDIO_INBOX_CATEGORY_ID,
} as const;

export function isProjectAssetInboxCategory(categoryId: string) {
  return (
    categoryId === PROJECT_ASSET_IMAGE_INBOX_CATEGORY_ID ||
    categoryId === PROJECT_ASSET_VIDEO_INBOX_CATEGORY_ID ||
    categoryId === PROJECT_ASSET_AUDIO_INBOX_CATEGORY_ID
  );
}

/** 曾经默认预置、现已不再预置的文件夹：为空时清掉，有内容则原样保留。 */
const RETIRED_PROJECT_ASSET_CATEGORY_IDS = new Set([
  "pcat:character",
  "pcat:scene",
  "pcat:sound",
  "pcat:prompt",
]);

type ScopedAssetRecord = ProjectAssetItem & { storageId: string; scopeId: string };
type ScopedCategoryRecord = ProjectAssetCategory & { storageId: string; scopeId: string };
type ScopedTombstoneRecord = {
  storageId: string;
  scopeId: string;
  sourceId: string;
  deletedAt: number;
};

const scopedKey = (scopeId: string, id: string) => `${scopeId}:${id}`;

async function readScoped<T extends { scopeId: string }>(storeName: string, scopeId: string) {
  const database = await openDatabase();
  return new Promise<T[]>((resolve, reject) => {
    const request = database
      .transaction(storeName, "readonly")
      .objectStore(storeName)
      .index(SCOPE_INDEX_NAME)
      .getAll(scopeId);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error("项目资产读取失败"));
  });
}

export async function listProjectAssetCategories(scopeId: string) {
  if (!scopeId) return [];
  const categories = await readScoped<ScopedCategoryRecord>(SCOPED_CATEGORY_STORE_NAME, scopeId);
  const systemOrder = new Map<string, number>(
    PROJECT_ASSET_SYSTEM_CATEGORIES.map((category, index) => [category.id, index]),
  );
  return categories
    .map(({ storageId: _storageId, scopeId: _scopeId, ...category }) => category)
    .sort((left, right) => {
      const leftSystem = systemOrder.get(left.id) ?? Number.POSITIVE_INFINITY;
      const rightSystem = systemOrder.get(right.id) ?? Number.POSITIVE_INFINITY;
      if (leftSystem !== rightSystem) return leftSystem - rightSystem;
      return left.createdAt - right.createdAt;
    });
}

export async function listProjectAssetItems(scopeId: string) {
  if (!scopeId) return [];
  const items = await readScoped<ScopedAssetRecord>(SCOPED_ASSET_STORE_NAME, scopeId);
  return items
    .map(({ storageId: _storageId, scopeId: _scopeId, ...item }) => item)
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt);
}

/**
 * 首次使用时为项目建一套系统分类（按类型的堆放区）。
 * 只在该项目还没有任何分类时创建——之后用户删掉的默认分类不会复活。
 * 顺带清掉历史上预置、现已不再默认提供且仍然为空的文件夹。
 */
export async function ensureProjectAssetCategories(scopeId: string) {
  if (!scopeId) return [];
  await removeRetiredEmptyCategories(scopeId);
  const existing = await listProjectAssetCategories(scopeId);
  if (existing.length) return existing;
  const now = Date.now();
  const seeds = PROJECT_ASSET_SYSTEM_CATEGORIES.map((category): ScopedCategoryRecord => ({
    storageId: scopedKey(scopeId, category.id),
    scopeId,
    id: category.id,
    name: category.name,
    builtin: true,
    createdAt: now,
    updatedAt: now,
  }));
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SCOPED_CATEGORY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SCOPED_CATEGORY_STORE_NAME);
    seeds.forEach((record) => store.put(record));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("默认分类创建失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("默认分类创建失败"));
  });
  return listProjectAssetCategories(scopeId);
}

/** 删除历史默认文件夹中已经没有任何资产的空目录；有内容的保留，避免丢用户归类。 */
async function removeRetiredEmptyCategories(scopeId: string) {
  const categories = await readScoped<ScopedCategoryRecord>(SCOPED_CATEGORY_STORE_NAME, scopeId);
  const retired = categories.filter((category) =>
    RETIRED_PROJECT_ASSET_CATEGORY_IDS.has(category.id),
  );
  if (!retired.length) return;
  const items = await readScoped<ScopedAssetRecord>(SCOPED_ASSET_STORE_NAME, scopeId);
  const used = new Set(
    items.map((item) => item.categoryId).filter((id): id is string => Boolean(id)),
  );
  const removable = retired.filter((category) => !used.has(category.id));
  if (!removable.length) return;
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(SCOPED_CATEGORY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(SCOPED_CATEGORY_STORE_NAME);
    removable.forEach((category) => store.delete(category.storageId));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("默认分类清理失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("默认分类清理失败"));
  });
}

export async function createProjectAssetCategory(scopeId: string, name: string) {
  const normalized = normalizeCategoryName(name);
  const categories = await listProjectAssetCategories(scopeId);
  if (
    categories.some(
      (category) => category.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
    )
  ) {
    throw new Error("分类名称已存在");
  }
  const now = Date.now();
  const category: ProjectAssetCategory = {
    id: createId("pcat"),
    name: normalized,
    builtin: false,
    createdAt: now,
    updatedAt: now,
  };
  await putRecord(SCOPED_CATEGORY_STORE_NAME, {
    ...category,
    storageId: scopedKey(scopeId, category.id),
    scopeId,
  });
  return category;
}

export async function renameProjectAssetCategory(
  scopeId: string,
  categoryId: string,
  name: string,
) {
  const normalized = normalizeCategoryName(name);
  const categories = await listProjectAssetCategories(scopeId);
  if (
    categories.some(
      (category) =>
        category.id !== categoryId &&
        category.name.toLocaleLowerCase() === normalized.toLocaleLowerCase(),
    )
  ) {
    throw new Error("分类名称已存在");
  }
  const category = categories.find((item) => item.id === categoryId);
  if (!category) throw new Error("分类不存在");
  const next: ProjectAssetCategory = { ...category, name: normalized, updatedAt: Date.now() };
  await putRecord(SCOPED_CATEGORY_STORE_NAME, {
    ...next,
    storageId: scopedKey(scopeId, categoryId),
    scopeId,
  });
  return next;
}

export async function removeProjectAssetCategory(scopeId: string, categoryId: string) {
  // 图片/视频堆放区不可删除；默认分类与自建文件夹都可以删（其中资产移至未分类）。
  if (isProjectAssetInboxCategory(categoryId)) {
    throw new Error("图片/视频堆放区是自动收集区，不能删除");
  }
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(
      [SCOPED_ASSET_STORE_NAME, SCOPED_CATEGORY_STORE_NAME],
      "readwrite",
    );
    const assetStore = transaction.objectStore(SCOPED_ASSET_STORE_NAME);
    const scopeIndex = assetStore.index(SCOPE_INDEX_NAME);
    const itemsRequest = scopeIndex.getAll(scopeId);
    itemsRequest.onsuccess = () => {
      const now = Date.now();
      transaction.objectStore(SCOPED_CATEGORY_STORE_NAME).delete(scopedKey(scopeId, categoryId));
      (itemsRequest.result as ScopedAssetRecord[])
        .filter((item) => item.categoryId === categoryId)
        .forEach((item) => assetStore.put({ ...item, categoryId: null, updatedAt: now }));
    };
    itemsRequest.onerror = () => transaction.abort();
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? itemsRequest.error ?? new Error("分类删除失败"));
    transaction.onerror = () => reject(transaction.error ?? new Error("分类删除失败"));
  });
}

/** 画布产物入库：按 sourceId（media.id）去重，重复调用只更新内容。 */
export async function saveProjectAssetFromMedia(
  scopeId: string,
  input: {
    media: CanvasMedia;
    kind: Exclude<ProjectAssetKind, "prompt">;
    name: string;
    prompt: string;
    categoryId?: string | null;
    source?: "canvas" | "local";
  },
) {
  if (!scopeId) throw new Error("项目资产库未就绪");
  const items = await listProjectAssetItems(scopeId);
  const existing = items.find((item) => item.sourceId === input.media.id && item.kind !== "prompt");
  const now = Date.now();
  const item: ProjectAssetItem = {
    id: existing?.id ?? `passet:${input.media.id}`,
    kind: input.kind,
    name: input.name.trim().slice(0, 64) || input.media.name.slice(0, 64) || "未命名资产",
    prompt: input.prompt.trim().slice(0, 4000),
    media: input.media,
    categoryId: input.categoryId === undefined ? (existing?.categoryId ?? null) : input.categoryId,
    source: input.source ?? "canvas",
    sourceId: input.media.id,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await putRecord(SCOPED_ASSET_STORE_NAME, {
    ...item,
    storageId: scopedKey(scopeId, item.id),
    scopeId,
  });
  return item;
}

export async function saveProjectPromptAsset(
  scopeId: string,
  input: { name: string; prompt: string; categoryId?: string | null },
) {
  if (!scopeId) throw new Error("项目资产库未就绪");
  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("提示词内容不能为空");
  const now = Date.now();
  const item: ProjectAssetItem = {
    id: `passet:${createId("prompt")}`,
    kind: "prompt",
    name: input.name.trim().slice(0, 64) || prompt.replace(/\s+/g, " ").slice(0, 28) || "提示词",
    prompt: prompt.slice(0, 4000),
    media: null,
    categoryId: input.categoryId ?? null,
    source: "manual",
    sourceId: null,
    createdAt: now,
    updatedAt: now,
  };
  await putRecord(SCOPED_ASSET_STORE_NAME, {
    ...item,
    storageId: scopedKey(scopeId, item.id),
    scopeId,
  });
  return item;
}

export async function setProjectAssetItemCategory(
  scopeId: string,
  itemId: string,
  categoryId: string | null,
) {
  if (
    categoryId &&
    !(await getRecord<ScopedCategoryRecord>(
      SCOPED_CATEGORY_STORE_NAME,
      scopedKey(scopeId, categoryId),
    ))
  ) {
    throw new Error("分类不存在");
  }
  const record = await getRecord<ScopedAssetRecord>(
    SCOPED_ASSET_STORE_NAME,
    scopedKey(scopeId, itemId),
  );
  if (!record) throw new Error("资产不存在");
  const next: ScopedAssetRecord = { ...record, categoryId, updatedAt: Date.now() };
  await putRecord(SCOPED_ASSET_STORE_NAME, next);
  const { storageId: _storageId, scopeId: _scopeId, ...item } = next;
  return item;
}

export async function renameProjectAssetItem(scopeId: string, itemId: string, name: string) {
  const normalized = name.trim().replace(/\s+/g, " ").slice(0, 64);
  if (!normalized) throw new Error("请输入资产名称");
  const record = await getRecord<ScopedAssetRecord>(
    SCOPED_ASSET_STORE_NAME,
    scopedKey(scopeId, itemId),
  );
  if (!record) throw new Error("资产不存在");
  const next: ScopedAssetRecord = { ...record, name: normalized, updatedAt: Date.now() };
  await putRecord(SCOPED_ASSET_STORE_NAME, next);
  const { storageId: _storageId, scopeId: _scopeId, ...item } = next;
  return item;
}

/** 删除资产并记墓碑：自动收集不会把已删除的资产再捞回来。 */
export async function removeProjectAssetItem(scopeId: string, itemId: string) {
  const record = await getRecord<ScopedAssetRecord>(
    SCOPED_ASSET_STORE_NAME,
    scopedKey(scopeId, itemId),
  );
  await deleteRecord(SCOPED_ASSET_STORE_NAME, scopedKey(scopeId, itemId));
  if (record?.sourceId) {
    await putRecord(SCOPED_TOMBSTONE_STORE_NAME, {
      storageId: scopedKey(scopeId, record.sourceId),
      scopeId,
      sourceId: record.sourceId,
      deletedAt: Date.now(),
    });
  }
}

export async function listProjectAssetTombstoneSourceIds(scopeId: string) {
  if (!scopeId || typeof indexedDB === "undefined") return new Set<string>();
  const records = await readScoped<ScopedTombstoneRecord>(SCOPED_TOMBSTONE_STORE_NAME, scopeId);
  return new Set(records.map((record) => record.sourceId));
}

/** 手动把删过的资产重新入库时清掉墓碑，自动收集才允许再次收录。 */
export async function removeProjectAssetTombstone(scopeId: string, sourceId: string) {
  if (!scopeId || !sourceId) return;
  await deleteRecord(SCOPED_TOMBSTONE_STORE_NAME, scopedKey(scopeId, sourceId));
}

async function readAll<T>(storeName: string) {
  const database = await openDatabase();
  return new Promise<T[]>((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error ?? new Error("资产数据读取失败"));
  });
}

async function getRecord<T>(storeName: string, id: string) {
  const database = await openDatabase();
  return new Promise<T | null>((resolve, reject) => {
    const request = database.transaction(storeName, "readonly").objectStore(storeName).get(id);
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("资产数据读取失败"));
  });
}

async function putRecord<T>(storeName: string, value: T) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("资产数据保存失败"));
  });
}

async function deleteRecord(storeName: string, id: string) {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(id);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("资产数据删除失败"));
  });
}
