import type { CanvasMedia, CanvasNodeKind } from "@kachang/contracts";
import {
  BookmarkCheck,
  BookmarkPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  FileText,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  Images,
  Library,
  LoaderCircle,
  LogIn,
  Music2,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Tag,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { createPortal } from "react-dom";

import {
  createAssetLibraryCategory,
  ensureMediaAsset,
  listAssetLibraryCategories,
  listAssetLibraryItems,
  removeAssetLibraryCategory,
  removeAssetLibraryItem,
  renameAssetLibraryCategory,
  savePromptAssetItem,
  setAssetLibraryItemCategory,
  updateAssetLibraryItem,
  type AssetLibraryCategory,
  type AssetLibraryItem,
  type AssetLibraryKind,
} from "../lib/asset-library-store";
import { listLocalMedia, readMedia, storeMedia } from "../lib/media-store";
import { requestConfirmation } from "../lib/confirmation";
import { useCanvasStore } from "../state/canvas-store";
import { useIdentityStore } from "../state/identity-store";
import { useToastStore } from "../state/toast-store";
import { useMediaUrl } from "../hooks/use-media-url";
import { useDismissOnOutsideClick } from "../hooks/use-dismiss-on-outside-click";
import { CardHoverPreview, type CardHoverPreviewSource } from "./card-hover-preview";
import { CanvasSelect } from "./canvas-select";
import { AccountCardsPanel, accountCardsTabAvailable, useAccountCardsWarmth } from "./account-cards-panel";

// 画布可插入对象的类型已抽到中立模块；此处转出口保持既有 import 路径可用。
export type { InsertableAsset } from "../lib/insertable-asset";
import type { InsertableAsset } from "../lib/insertable-asset";

type LoadState = "idle" | "loading" | "ready" | "error";
type CategoryFilter = "all" | "uncategorized" | string;
type KindFilter = "all" | AssetLibraryKind;
type ResourceContextTarget =
  | { type: "library" }
  | { type: "category"; category: AssetLibraryCategory }
  | { type: "asset"; item: AssetLibraryItem };
type ResourceContextMenuState = ResourceContextTarget & { clientX: number; clientY: number };

export const ResourceDrawer = memo(function ResourceDrawer({
  open,
  onClose,
  onInsert,
}: {
  open: boolean;
  onClose: () => void;
  onInsert: (asset: InsertableAsset) => void;
}) {
  const [tab, setTab] = useState<"cards" | "assets">("assets");
  const [categories, setCategories] = useState<AssetLibraryCategory[]>([]);
  const [assets, setAssets] = useState<AssetLibraryItem[]>([]);
  const authenticated = useIdentityStore((state) => state.status === "authenticated");
  const identityScope = useIdentityStore((state) => state.session?.user.id ?? null);
  const showToast = useToastStore((state) => state.show);
  const drawerRef = useDismissOnOutsideClick<HTMLElement>(open, onClose);
  const assetRefreshInFlight = useRef<Promise<void> | null>(null);
  const assetRefreshQueued = useRef(false);
  const lastAssetMediaSignature = useRef<string | null>(null);

  const refreshAssets = useCallback(() => {
    assetRefreshQueued.current = true;
    if (assetRefreshInFlight.current) return assetRefreshInFlight.current;
    const request = (async () => {
      do {
        assetRefreshQueued.current = false;
        const [storedAssets, storedCategories, localMedia] = await Promise.all([
          listAssetLibraryItems(),
          listAssetLibraryCategories(),
          listLocalMedia(),
        ]);
        const knownMedia = new Set(storedAssets.flatMap((item) => item.media ? [item.media.id] : []));
        const candidates = new Map<string, { media: CanvasMedia; kind: Exclude<AssetLibraryKind, "card" | "prompt">; source: "local" | "canvas" }>();
        const canvasNodes = useCanvasStore.getState().nodes;
        localMedia.forEach(({ media }) => {
          const kind = mediaKind(media);
          if (kind && !knownMedia.has(media.id)) candidates.set(media.id, { media, kind, source: "local" });
        });
        canvasNodes.forEach((node) => {
          const media = node.data.media;
          const kind = media ? mediaKind(media) : null;
          if (media && kind && !knownMedia.has(media.id) && !candidates.has(media.id)) {
            candidates.set(media.id, { media, kind, source: "canvas" });
          }
        });
        for (const candidate of candidates.values()) {
          await ensureMediaAsset(candidate.media, candidate.kind, candidate.source);
        }
        setAssets(await listAssetLibraryItems());
        setCategories(storedCategories);
        lastAssetMediaSignature.current = canvasMediaSignature(canvasNodes);
      } while (assetRefreshQueued.current);
    })();
    assetRefreshInFlight.current = request;
    const clearRequest = () => {
      if (assetRefreshInFlight.current === request) assetRefreshInFlight.current = null;
    };
    void request.then(clearRequest, clearRequest);
    return request;
  }, []);

  useEffect(() => {
    if (!open) return;
    if (lastAssetMediaSignature.current === canvasMediaSignature()) return;
    void refreshAssets().catch((cause) => {
      showToast(errorMessage(cause, "资产库读取失败"), "error");
    });
  }, [open, refreshAssets, showToast]);

  // 卡片库的缓存清理与空闲预热由面板模块自持（开源 stub 为 no-op）。
  useAccountCardsWarmth(identityScope);

  if (!open) return null;

  return (
    <section ref={drawerRef} className={"kc-resource-drawer " + (tab === "cards" && accountCardsTabAvailable && !authenticated ? "is-connection-gate" : "")} role="dialog" aria-label="资源库" aria-modal="false">
      <header className="kc-resource-header">
        <span className="kc-resource-mark" aria-hidden="true"><Library /></span>
        <strong>资源库</strong>
        <div className="kc-resource-tabs" role="tablist" aria-label="资源类型">
          {accountCardsTabAvailable ? (
            <button type="button" role="tab" aria-selected={tab === "cards"} className={tab === "cards" ? "is-active" : ""} onClick={() => setTab("cards")}>卡片库</button>
          ) : null}
          <button type="button" role="tab" aria-selected={tab === "assets"} className={tab === "assets" ? "is-active" : ""} onClick={() => setTab("assets")}>资产库</button>
        </div>
        <button type="button" className="kc-resource-close" aria-label="收起资源库" title="收起" onClick={onClose}><X aria-hidden="true" /></button>
      </header>
      {tab === "cards" && accountCardsTabAvailable ? (
        <AccountCardsPanel
          key={identityScope ?? "anonymous"}
          categories={categories}
          assets={assets}
          authenticated={authenticated && Boolean(identityScope)}
          cacheScope={identityScope}
          onAssetSaved={refreshAssets}
          onInsertAsset={onInsert}
          onClose={onClose}
        />
      ) : (
        <AssetLibraryPanel
          categories={categories}
          assets={assets}
          onRefresh={refreshAssets}
          onInsert={async (item) => {
            if (item.media?.source === "local" && !(await readMedia(item.media.id))) {
              showToast("资产文件已不在本机", "error");
              return;
            }
            const insertable = toInsertableAsset(item);
            if (!insertable) {
              showToast("资产内容暂时不可用", "error");
              return;
            }
            onInsert(insertable);
            onClose();
            showToast("已加入画布", "success");
          }}
        />
      )}
    </section>
  );
});

function AssetLibraryPanel({
  categories,
  assets,
  onRefresh,
  onInsert,
}: {
  categories: AssetLibraryCategory[];
  assets: AssetLibraryItem[];
  onRefresh: () => Promise<void>;
  onInsert: (item: AssetLibraryItem) => Promise<void>;
}) {
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");
  const [query, setQuery] = useState("");
  const [categoryDraft, setCategoryDraft] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [assetBusyId, setAssetBusyId] = useState<string | null>(null);
  const [promptComposerOpen, setPromptComposerOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptSaving, setPromptSaving] = useState(false);
  const [editingItemPromptId, setEditingItemPromptId] = useState<string | null>(null);
  const [itemPromptDraft, setItemPromptDraft] = useState("");
  const [contextMenu, setContextMenu] = useState<ResourceContextMenuState | null>(null);
  // 悬停缩略图时贴着鼠标浮出大图快览；图片与视频都支持，移出网格即收起。
  const [hoverPreview, setHoverPreview] = useState<CardHoverPreviewSource | null>(null);
  const categoryInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const showToast = useToastStore((state) => state.show);

  const categoryCounts = useMemo(() => {
    const counts = new Map<string, number>();
    let uncategorized = 0;
    assets.forEach((item) => {
      if (item.categoryId) counts.set(item.categoryId, (counts.get(item.categoryId) ?? 0) + 1);
      else uncategorized += 1;
    });
    return { counts, uncategorized };
  }, [assets]);

  const filtered = useMemo(() => assets.filter((item) => {
    if (categoryFilter === "uncategorized" && item.categoryId) return false;
    if (categoryFilter !== "all" && categoryFilter !== "uncategorized" && item.categoryId !== categoryFilter) return false;
    if (kindFilter !== "all" && item.kind !== kindFilter) return false;
    const needle = query.trim().toLocaleLowerCase();
    if (needle && !`${item.name}\n${item.prompt}`.toLocaleLowerCase().includes(needle)) return false;
    return true;
  }), [assets, categoryFilter, kindFilter, query]);

  const submitCategory = async (event: FormEvent) => {
    event.preventDefault();
    if (categoryBusy) return;
    const editing = Boolean(editingCategoryId);
    setCategoryBusy(true);
    try {
      if (editingCategoryId) await renameAssetLibraryCategory(editingCategoryId, categoryDraft);
      else await createAssetLibraryCategory(categoryDraft);
      setCategoryDraft("");
      setEditingCategoryId(null);
      await onRefresh();
      showToast(editing ? "文件夹已重命名" : "文件夹已创建", "success");
    } catch (cause) {
      showToast(errorMessage(cause, "文件夹保存失败"), "error");
    } finally {
      setCategoryBusy(false);
    }
  };

  const beginCreateCategory = () => {
    setContextMenu(null);
    setEditingCategoryId(null);
    setCategoryDraft("");
    window.requestAnimationFrame(() => categoryInputRef.current?.focus());
  };

  const beginRenameCategory = (category: AssetLibraryCategory) => {
    setContextMenu(null);
    setEditingCategoryId(category.id);
    setCategoryDraft(category.name);
    window.requestAnimationFrame(() => {
      categoryInputRef.current?.focus();
      categoryInputRef.current?.select();
    });
  };

  const deleteCategory = async (category: AssetLibraryCategory) => {
    if (categoryBusy) return;
    setContextMenu(null);
    const accepted = await requestConfirmation({
      title: "删除文件夹",
      description: `删除文件夹“${category.name}”？`,
      detail: "文件夹里的资产不会被删除，会移动到「未分类」。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!accepted) return;
    setCategoryBusy(true);
    try {
      await removeAssetLibraryCategory(category.id);
      if (categoryFilter === category.id) setCategoryFilter("uncategorized");
      if (editingCategoryId === category.id) {
        setEditingCategoryId(null);
        setCategoryDraft("");
      }
      await onRefresh();
      showToast(`已删除文件夹“${category.name}”，其中资产已移至未分类`, "success");
    } catch (cause) {
      showToast(errorMessage(cause, "文件夹删除失败"), "error");
    } finally {
      setCategoryBusy(false);
    }
  };

  const moveAsset = async (item: AssetLibraryItem, categoryId: string | null) => {
    if (assetBusyId) return;
    setContextMenu(null);
    if (item.categoryId === categoryId) return;
    setAssetBusyId(item.id);
    try {
      await setAssetLibraryItemCategory(item.id, categoryId);
      await onRefresh();
      const categoryName = categories.find((category) => category.id === categoryId)?.name ?? "未分类";
      showToast(`已将“${item.name}”移至${categoryName}`, "success");
    } catch (cause) {
      showToast(errorMessage(cause, "分类更新失败"), "error");
    } finally {
      setAssetBusyId(null);
    }
  };

  // 删除资产：仅移除资产库记录（不触碰画布项目里的媒体），不可恢复所以先确认。
  const deleteAsset = async (item: AssetLibraryItem) => {
    if (assetBusyId) return;
    setContextMenu(null);
    const accepted = await requestConfirmation({
      title: "删除资产",
      description: `将移除资产“${item.name}”，该操作不可恢复。`,
      detail: "已经放进画布的节点不会受到影响。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!accepted) return;
    setAssetBusyId(item.id);
    try {
      await removeAssetLibraryItem(item.id);
      await onRefresh();
      showToast(`已删除“${item.name}”`, "success");
    } catch (cause) {
      showToast(errorMessage(cause, "资产删除失败"), "error");
    } finally {
      setAssetBusyId(null);
    }
  };

  const openContextMenu = (event: ReactMouseEvent, target: ResourceContextTarget) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ ...target, clientX: event.clientX, clientY: event.clientY });
  };

  const openContextMenuFromKeyboard = (event: ReactKeyboardEvent, target: ResourceContextTarget) => {
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    event.preventDefault();
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setContextMenu({ ...target, clientX: rect.left + 18, clientY: rect.top + 18 });
  };

  const uploadFiles = async (files: FileList | null) => {    if (!files?.length || uploading) return;
    setUploading(true);
    let completed = 0;
    try {
      for (const file of Array.from(files)) {
        const kind = fileKind(file);
        if (!kind) continue;
        const media = await storeMedia(file, kind);
        const item = await ensureMediaAsset(media, kind, "local");
        if (categoryFilter !== "all" && categoryFilter !== "uncategorized") {
          await setAssetLibraryItemCategory(item.id, categoryFilter);
        }
        completed += 1;
      }
      await onRefresh();
      showToast(completed ? `${completed} 个资产已加入` : "没有可用的媒体文件", completed ? "success" : "error");
    } catch (cause) {
      showToast(errorMessage(cause, "资产导入失败"), "error");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const activeCategoryId = categoryFilter !== "all" && categoryFilter !== "uncategorized" ? categoryFilter : null;

  const savePromptAsset = async () => {
    const prompt = promptDraft.trim();
    if (!prompt || promptSaving) return;
    setPromptSaving(true);
    try {
      await savePromptAssetItem({ prompt, categoryId: activeCategoryId });
      await onRefresh();
      setPromptDraft("");
      setPromptComposerOpen(false);
      showToast("提示词已存入资产库", "success");
    } catch (cause) {
      showToast(errorMessage(cause, "提示词保存失败"), "error");
    } finally {
      setPromptSaving(false);
    }
  };

  const beginEditItemPrompt = (item: AssetLibraryItem) => {
    setEditingItemPromptId(item.id);
    setItemPromptDraft(item.prompt ?? "");
  };

  const saveItemPrompt = async (item: AssetLibraryItem) => {
    setAssetBusyId(item.id);
    try {
      await updateAssetLibraryItem(item.id, { prompt: itemPromptDraft });
      await onRefresh();
      setEditingItemPromptId(null);
      showToast(itemPromptDraft.trim() ? "提示词已保存" : "提示词已清空", "success");
    } catch (cause) {
      showToast(errorMessage(cause, "提示词保存失败"), "error");
    } finally {
      setAssetBusyId(null);
    }
  };

  return (
    <div className="kc-asset-library-panel">
      <aside className="kc-asset-categories" aria-label="资产分类" onContextMenu={(event) => openContextMenu(event, { type: "library" })}>
        <button type="button" className={categoryFilter === "all" ? "is-active" : ""} onClick={() => setCategoryFilter("all")}><FolderOpen aria-hidden="true" /><span>全部</span><small>{assets.length}</small></button>
        <button type="button" className={categoryFilter === "uncategorized" ? "is-active" : ""} onClick={() => setCategoryFilter("uncategorized")}><Folder aria-hidden="true" /><span>未分类</span><small>{categoryCounts.uncategorized}</small></button>
        <div className="kc-asset-category-list">
          {categories.map((category) => (
            <div className="kc-asset-category-row" key={category.id} onContextMenu={(event) => openContextMenu(event, { type: "category", category })}>
              <button
                type="button"
                className={categoryFilter === category.id ? "is-active" : ""}
                onClick={() => setCategoryFilter(category.id)}
                onKeyDown={(event) => openContextMenuFromKeyboard(event, { type: "category", category })}
              >
                <Folder aria-hidden="true" /><span>{category.name}</span><small>{categoryCounts.counts.get(category.id) ?? 0}</small>
              </button>
            </div>
          ))}
        </div>
        <form className="kc-asset-category-form" onSubmit={(event) => void submitCategory(event)}>
          <input ref={categoryInputRef} aria-label={editingCategoryId ? "重命名文件夹" : "新建文件夹"} placeholder={editingCategoryId ? "文件夹名称" : "新建文件夹"} value={categoryDraft} onChange={(event) => setCategoryDraft(event.target.value)} maxLength={24} />
          <button type="submit" aria-label={editingCategoryId ? "保存文件夹名称" : "添加文件夹"} title={editingCategoryId ? "保存" : "添加"} disabled={!categoryDraft.trim() || categoryBusy}>{categoryBusy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : editingCategoryId ? <Pencil aria-hidden="true" /> : <Plus aria-hidden="true" />}</button>
        </form>
      </aside>

      <div className="kc-asset-library-content">
        <div className="kc-resource-toolbar">
          <label className="kc-resource-search">
            <Search aria-hidden="true" />
            <input aria-label="搜索资产" placeholder="搜索资产" value={query} onChange={(event) => setQuery(event.target.value)} />
          </label>
          <div className="kc-asset-kind-filter" role="group" aria-label="资产类型">
            {(["all", "image", "video", "audio", "prompt"] as const).map((kind) => (
              <button type="button" key={kind} className={kindFilter === kind ? "is-active" : ""} aria-pressed={kindFilter === kind} onClick={() => setKindFilter(kind)}>{kindLabel(kind)}</button>
            ))}
          </div>
          <input ref={fileInputRef} type="file" accept="image/*,video/*,audio/*" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
          <button type="button" className="kc-resource-upload" disabled={uploading} onClick={() => fileInputRef.current?.click()}>{uploading ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Upload aria-hidden="true" />}导入</button>
          <button type="button" className="kc-asset-prompt-new" aria-expanded={promptComposerOpen} onClick={() => setPromptComposerOpen((value) => !value)}><FileText aria-hidden="true" />新建提示词</button>
        </div>

        {promptComposerOpen ? (
          <div className="kc-asset-prompt-composer">
            <textarea
              aria-label="新建提示词"
              placeholder="粘贴或输入提示词，保存后就能像图片一样拖进画布"
              value={promptDraft}
              onChange={(event) => setPromptDraft(event.target.value)}
              rows={3}
              maxLength={4_000}
            />
            <div className="kc-asset-prompt-actions">
              <button type="button" onClick={() => { setPromptComposerOpen(false); setPromptDraft(""); }}>取消</button>
              <button type="button" className="is-primary" disabled={!promptDraft.trim() || promptSaving} onClick={() => void savePromptAsset()}>
                {promptSaving ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Plus aria-hidden="true" />}保存提示词
              </button>
            </div>
          </div>
        ) : null}

        <div className="kc-asset-grid" onMouseLeave={() => setHoverPreview(null)}>
          {!filtered.length ? <div className="kc-resource-empty">暂无资产</div> : filtered.map((item) => {
            const editing = editingItemPromptId === item.id;
            return (
              <article
                className={`kc-asset-item${assetBusyId === item.id ? " is-busy" : ""}${editing ? " is-editing" : ""}`}
                key={item.id}
                tabIndex={0}
                aria-label={`${item.name} 资产`}
                onContextMenu={(event) => openContextMenu(event, { type: "asset", item })}
                onKeyDown={(event) => openContextMenuFromKeyboard(event, { type: "asset", item })}
              >
                <AssetPreview
                  item={item}
                  onHoverStart={(url, kind) => setHoverPreview({
                    key: item.id,
                    title: item.name,
                    thumbnailUrl: url,
                    mediaKind: kind,
                    resolveImages: async () => [url],
                  })}
                  onHoverEnd={() => setHoverPreview((current) => (current?.key === item.id ? null : current))}
                />
                <div className="kc-asset-item-body">
                  {editing ? (
                    <div className="kc-asset-prompt-edit">
                      <textarea
                        aria-label={`${item.name} 的提示词`}
                        placeholder="给这个资产写一条提示词"
                        value={itemPromptDraft}
                        onChange={(event) => setItemPromptDraft(event.target.value)}
                        rows={3}
                        maxLength={4_000}
                      />
                      <div className="kc-asset-prompt-actions">
                        <button type="button" onClick={() => setEditingItemPromptId(null)}>取消</button>
                        <button type="button" className="is-primary" onClick={() => void saveItemPrompt(item)}>保存</button>
                      </div>
                    </div>
                  ) : (
                    <div className="kc-asset-item-copy">
                      <strong title={item.name}>{item.name}</strong>
                      <span className="kc-asset-item-kind">{kindLabel(item.kind)}</span>
                      {item.prompt ? <span className="kc-asset-item-prompt" title={item.prompt}>{item.prompt}</span> : null}
                    </div>
                  )}
                </div>
                {editing ? null : (
                  <div className="kc-asset-item-footer">
                    <CanvasSelect
                      ariaLabel={item.name + " 的分类"}
                      value={item.categoryId || ""}
                      options={[{ value: "", label: "未分类" }, ...categories.map((category) => ({ value: category.id, label: category.name }))]}
                      onChange={(next) => void setAssetLibraryItemCategory(item.id, next || null).then(onRefresh).catch((cause) => showToast(errorMessage(cause, "分类更新失败"), "error"))}
                      className="kc-asset-category-select"
                      variant="compact"
                      menuMinWidth={180}
                    />
                    <div className="kc-asset-item-actions">
                      <button
                        type="button"
                        className="kc-asset-action"
                        aria-label={`将 ${item.name} 加入画布`}
                        title="加入画布"
                        onClick={() => void onInsert(item)}
                      >
                        <Plus aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="kc-asset-action"
                        aria-label={`${item.prompt ? "编辑" : "添加"} ${item.name} 的提示词`}
                        title={item.prompt ? "编辑提示词" : "添加提示词"}
                        onClick={() => beginEditItemPrompt(item)}
                      >
                        <Pencil aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="kc-asset-action is-danger"
                        aria-label={`删除 ${item.name}`}
                        title="删除资产"
                        disabled={assetBusyId === item.id}
                        onClick={() => void deleteAsset(item)}
                      >
                        <Trash2 aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </div>
      {contextMenu ? (
        <ResourceContextMenu
          menu={contextMenu}
          categories={categories}
          onClose={() => setContextMenu(null)}
          onCreateCategory={beginCreateCategory}
          onRenameCategory={beginRenameCategory}
          onDeleteCategory={(category) => void deleteCategory(category)}
          onInsert={(item) => { setContextMenu(null); void onInsert(item); }}
          onMoveAsset={(item, categoryId) => void moveAsset(item, categoryId)}
        />
      ) : null}
      <CardHoverPreview source={hoverPreview} />
    </div>
  );
}

function ResourceContextMenu({
  menu,
  categories,
  onClose,
  onCreateCategory,
  onRenameCategory,
  onDeleteCategory,
  onInsert,
  onMoveAsset,
}: {
  menu: ResourceContextMenuState;
  categories: AssetLibraryCategory[];
  onClose: () => void;
  onCreateCategory: () => void;
  onRenameCategory: (category: AssetLibraryCategory) => void;
  onDeleteCategory: (category: AssetLibraryCategory) => void;
  onInsert: (item: AssetLibraryItem) => void;
  onMoveAsset: (item: AssetLibraryItem, categoryId: string | null) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({
    left: clamp(menu.clientX, 12, window.innerWidth - 232),
    top: clamp(menu.clientY, 12, window.innerHeight - 160),
  });

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const next = {
      left: clamp(menu.clientX, 12, window.innerWidth - element.offsetWidth - 12),
      top: clamp(menu.clientY, 12, window.innerHeight - element.offsetHeight - 12),
    };
    setPosition((current) => current.left === next.left && current.top === next.top ? current : next);
  }, [categories.length, menu.clientX, menu.clientY, menu.type]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus());
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    window.addEventListener("resize", onClose);
    window.addEventListener("scroll", onClose, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const label = menu.type === "asset" ? `${menu.item.name} 资产操作` : menu.type === "category" ? `${menu.category.name} 文件夹操作` : "资产库操作";

  return createPortal(
    <div
      ref={menuRef}
      className="kc-context-menu kc-resource-context-menu"
      role="menu"
      aria-label={label}
      data-kc-preserve-drawers
      data-kc-block-canvas-shortcuts
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {menu.type === "asset" ? (
        <>
          <button role="menuitem" type="button" onClick={() => onInsert(menu.item)}><Plus aria-hidden="true" />加入画布</button>
          <span className="kc-context-menu-divider" aria-hidden="true" />
          <span className="kc-resource-context-heading">移动到文件夹</span>
          <button
            role="menuitemradio"
            type="button"
            aria-checked={!menu.item.categoryId}
            className={!menu.item.categoryId ? "is-current" : undefined}
            onClick={() => onMoveAsset(menu.item, null)}
          >
            <FolderOpen aria-hidden="true" /><span>未分类</span>{!menu.item.categoryId ? <Check aria-hidden="true" /> : null}
          </button>
          {categories.map((category) => {
            const current = menu.item.categoryId === category.id;
            return (
              <button
                role="menuitemradio"
                type="button"
                aria-checked={current}
                className={current ? "is-current" : undefined}
                key={category.id}
                onClick={() => onMoveAsset(menu.item, category.id)}
              >
                <Folder aria-hidden="true" /><span>{category.name}</span>{current ? <Check aria-hidden="true" /> : null}
              </button>
            );
          })}
        </>
      ) : (
        <>
          <button role="menuitem" type="button" onClick={onCreateCategory}><FolderPlus aria-hidden="true" />新建文件夹</button>
          {menu.type === "category" ? (
            <>
              <button role="menuitem" type="button" onClick={() => onRenameCategory(menu.category)}><Pencil aria-hidden="true" />重命名</button>
              <span className="kc-context-menu-divider" aria-hidden="true" />
              <button role="menuitem" type="button" className="is-danger" onClick={() => onDeleteCategory(menu.category)}><Trash2 aria-hidden="true" />删除文件夹</button>
              <span className="kc-resource-context-note">文件夹内资产将移至未分类</span>
            </>
          ) : null}
        </>
      )}
    </div>,
    document.body,
  );
}

function AssetPreview({
  item,
  onHoverStart,
  onHoverEnd,
}: {
  item: AssetLibraryItem;
  /** 悬停缩略图时把可预览的媒资交给上层浮出大图快览（音频/提示词不触发）。 */
  onHoverStart?: (url: string, kind: "image" | "video") => void;
  onHoverEnd?: () => void;
}) {
  const { url, missing } = useMediaUrl(item.media);
  const galleryCount = item.gallery?.length ?? 0;
  const isImage = item.kind === "image" || (item.kind === "card" && Boolean(item.media?.mimeType.startsWith("image/")));
  const isVideo = item.kind === "video" && Boolean(item.media?.mimeType.startsWith("video/"));
  const canPreview = Boolean(url) && !missing && (isImage || isVideo);
  const hoverProps = canPreview && url
    ? {
        onMouseEnter: () => onHoverStart?.(url, isVideo ? "video" : "image"),
        onMouseLeave: () => onHoverEnd?.(),
      }
    : {};
  if (item.kind === "prompt") return <div className="kc-asset-preview kc-asset-preview--prompt"><FileText aria-hidden="true" /></div>;
  if (item.kind === "card" && !url) return <div className="kc-asset-preview kc-asset-preview--placeholder"><FileText aria-hidden="true" /></div>;
  if (isImage) {
    return (
      <div className="kc-asset-preview" {...hoverProps}>
        {url && !missing ? <img src={url} alt="" loading="lazy" /> : <ImageIcon aria-hidden="true" />}
        {galleryCount > 0 ? <span className="kc-asset-gallery-badge" title={`共 ${galleryCount + 1} 张图片`}>{`+${galleryCount}`}</span> : null}
      </div>
    );
  }
  if (isVideo) return <div className="kc-asset-preview" {...hoverProps}>{url && !missing ? <video src={url} muted preload="metadata" /> : <Film aria-hidden="true" />}</div>;
  return <div className="kc-asset-preview kc-asset-preview--placeholder"><Music2 aria-hidden="true" /></div>;
}

function mediaKind(media: CanvasMedia): Exclude<AssetLibraryKind, "card" | "prompt"> | null {
  if (media.mimeType.startsWith("image/")) return "image";
  if (media.mimeType.startsWith("video/")) return "video";
  if (media.mimeType.startsWith("audio/")) return "audio";
  return null;
}

function canvasMediaSignature(nodes = useCanvasStore.getState().nodes) {
  return nodes
    .flatMap((node) => node.data.media ? [node.data.media.id] : [])
    .sort()
    .join("\n");
}

function fileKind(file: File): "image" | "video" | "audio" | null {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return null;
}

function toInsertableAsset(item: AssetLibraryItem): InsertableAsset | null {
  if (item.kind === "card") {
    if (item.media) return { kind: "image", body: item.prompt, media: item.media, extraMedia: item.gallery };
    if (item.prompt) return { kind: "text", body: item.prompt, media: null, extraMedia: [] };
    return null;
  }
  if (item.kind === "prompt") return item.prompt ? { kind: "text", body: item.prompt, media: null, extraMedia: [] } : null;
  if (!item.media) return null;
  return { kind: item.kind, body: item.prompt, media: item.media, extraMedia: item.gallery };
}

function kindLabel(kind: KindFilter) {
  return ({ all: "全部", card: "卡片", image: "图片", video: "视频", audio: "音频", prompt: "提示词" } as const)[kind];
}

function mediaFileName(title: string, mimeType: string, index = 0) {
  const extension = ({ "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif" } as Record<string, string>)[mimeType] || "jpg";
  const base = title.trim().replace(/[\\/:*?"<>|]+/g, "-").slice(0, 80) || "卡片图片";
  return index > 0 ? `${base}-${index + 1}.${extension}` : `${base}.${extension}`;
}

function errorMessage(cause: unknown, fallback: string) {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
