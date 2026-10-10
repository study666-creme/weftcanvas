import type { CanvasMedia } from "@kachang/contracts";
import {
  Boxes,
  Check,
  FileText,
  Film,
  Folder,
  FolderOpen,
  FolderPlus,
  Image as ImageIcon,
  MoreHorizontal,
  Music2,
  Pencil,
  Plus,
  Search,
  Trash2,
  Type,
  X,
} from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from "react";
import { createPortal } from "react-dom";

import {
  isProjectAssetInboxCategory,
  PROJECT_ASSET_SYSTEM_CATEGORIES,
  type ProjectAssetCategory,
  type ProjectAssetItem,
  type ProjectAssetKind,
} from "../lib/asset-library-store";
import { readMedia } from "../lib/media-store";
import { useDismissOnOutsideClick } from "../hooks/use-dismiss-on-outside-click";
import { useMediaThumbUrl, useMediaUrl } from "../hooks/use-media-url";
import { useCanvasStore } from "../state/canvas-store";
import { useProjectAssetStore, type ProjectAssetCategoryFilter, type ProjectAssetKindFilter } from "../state/project-asset-store";
import { useToastStore } from "../state/toast-store";
import type { InsertableAsset } from "./resource-drawer";

const KIND_FILTERS: Array<{ value: ProjectAssetKindFilter; label: string }> = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "prompt", label: "文本" },
];

type PanelMenuState =
  | { type: "item"; x: number; y: number; item: ProjectAssetItem }
  | { type: "category"; x: number; y: number; category: ProjectAssetCategory };

/**
 * 项目工作资产库：左上角触发的小面板，只装当前画布项目里产生的资产。
 * 与全局资源库互不影响——这里是"这个项目要用到的东西"，追求精准快取。
 */
export const ProjectAssetPanel = memo(function ProjectAssetPanel({
  onInsert,
}: {
  onInsert: (asset: InsertableAsset) => void;
}) {
  const open = useProjectAssetStore((state) => state.open);
  const categories = useProjectAssetStore((state) => state.categories);
  const items = useProjectAssetStore((state) => state.items);
  const status = useProjectAssetStore((state) => state.status);
  const query = useProjectAssetStore((state) => state.query);
  const categoryFilter = useProjectAssetStore((state) => state.categoryFilter);
  const kindFilter = useProjectAssetStore((state) => state.kindFilter);
  const projectName = useCanvasStore((state) => state.projectName);
  const setQuery = useProjectAssetStore((state) => state.setQuery);
  const setCategoryFilter = useProjectAssetStore((state) => state.setCategoryFilter);
  const setKindFilter = useProjectAssetStore((state) => state.setKindFilter);
  const setOpen = useProjectAssetStore((state) => state.setOpen);
  const createCategory = useProjectAssetStore((state) => state.createCategory);
  const renameCategory = useProjectAssetStore((state) => state.renameCategory);
  const removeCategory = useProjectAssetStore((state) => state.removeCategory);
  const moveItem = useProjectAssetStore((state) => state.moveItem);
  const renameItem = useProjectAssetStore((state) => state.renameItem);
  const removeItem = useProjectAssetStore((state) => state.removeItem);
  const savePrompt = useProjectAssetStore((state) => state.savePrompt);
  const showToast = useToastStore((state) => state.show);

  const panelRef = useDismissOnOutsideClick<HTMLElement>(open, () => setOpen(false));
  const [menu, setMenu] = useState<PanelMenuState | null>(null);
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [categoryDraft, setCategoryDraft] = useState("");
  const [newCategoryDraft, setNewCategoryDraft] = useState("");
  const [creatingCategory, setCreatingCategory] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [itemDraft, setItemDraft] = useState("");
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  const [promptDraft, setPromptDraft] = useState("");
  const [promptNameDraft, setPromptNameDraft] = useState("");
  const [savingPrompt, setSavingPrompt] = useState(false);
  const categoryInputRef = useRef<HTMLInputElement>(null);
  const newCategoryInputRef = useRef<HTMLInputElement>(null);
  const itemInputRef = useRef<HTMLInputElement>(null);
  const promptInputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editingCategoryId) categoryInputRef.current?.focus();
  }, [editingCategoryId]);
  useEffect(() => {
    if (creatingCategory) window.requestAnimationFrame(() => newCategoryInputRef.current?.focus());
  }, [creatingCategory]);
  useEffect(() => {
    if (editingItemId) itemInputRef.current?.focus();
  }, [editingItemId]);
  useEffect(() => {
    if (promptEditorOpen) window.requestAnimationFrame(() => promptInputRef.current?.focus());
  }, [promptEditorOpen]);

  // Esc 逐层退出：菜单 → 行内编辑 → 提示词编辑器 → 面板。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (menu) { setMenu(null); return; }
      if (editingCategoryId) { setEditingCategoryId(null); return; }
      if (creatingCategory) { setCreatingCategory(false); setNewCategoryDraft(""); return; }
      if (editingItemId) { setEditingItemId(null); return; }
      if (promptEditorOpen) { setPromptEditorOpen(false); setPromptDraft(""); setPromptNameDraft(""); return; }
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creatingCategory, editingCategoryId, editingItemId, menu, open, promptEditorOpen, setOpen]);

  const counts = useMemo(() => {
    const byCategory = new Map<string, number>();
    let uncategorized = 0;
    const byKind = new Map<ProjectAssetKind, number>();
    for (const item of items) {
      if (item.categoryId) byCategory.set(item.categoryId, (byCategory.get(item.categoryId) ?? 0) + 1);
      else uncategorized += 1;
      byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
    }
    return { byCategory, uncategorized, byKind };
  }, [items]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return items.filter((item) => {
      if (categoryFilter === "uncategorized" && item.categoryId) return false;
      if (categoryFilter !== "all" && categoryFilter !== "uncategorized" && item.categoryId !== categoryFilter) return false;
      if (kindFilter !== "all" && item.kind !== kindFilter) return false;
      if (needle && !`${item.name}\n${item.prompt}`.toLocaleLowerCase().includes(needle)) return false;
      return true;
    });
  }, [categoryFilter, items, kindFilter, query]);

  if (!open) return null;

  const categoryOf = (item: ProjectAssetItem) => categories.find((category) => category.id === item.categoryId) ?? null;

  const insertItem = async (item: ProjectAssetItem) => {
    setMenu(null);
    if (item.kind === "prompt") {
      if (!item.prompt) { showToast("这条提示词是空的", "error"); return; }
      onInsert({ kind: "text", body: item.prompt, media: null, extraMedia: [] });
      showToast("已加入画布", "success");
      return;
    }
    if (!item.media) { showToast("资产内容暂时不可用", "error"); return; }
    if (item.media.source === "local" && !(await readMedia(item.media.id))) {
      showToast("资产文件已不在本机", "error");
      return;
    }
    onInsert({ kind: item.kind, body: item.prompt, media: item.media, extraMedia: [] });
    showToast("已加入画布", "success");
  };

  const submitNewCategory = async (event: FormEvent) => {
    event.preventDefault();
    if (!newCategoryDraft.trim()) return;
    if (await createCategory(newCategoryDraft)) {
      setNewCategoryDraft("");
      setCreatingCategory(false);
    }
  };

  const submitCategoryRename = async (event: FormEvent) => {
    event.preventDefault();
    if (!editingCategoryId) return;
    if (await renameCategory(editingCategoryId, categoryDraft)) setEditingCategoryId(null);
  };

  const beginItemRename = (item: ProjectAssetItem) => {
    setMenu(null);
    setEditingItemId(item.id);
    setItemDraft(item.name);
  };

  const submitItemRename = async () => {
    if (!editingItemId) return;
    if (await renameItem(editingItemId, itemDraft)) setEditingItemId(null);
  };

  const submitPrompt = async () => {
    if (savingPrompt || !promptDraft.trim()) return;
    setSavingPrompt(true);
    const ok = await savePrompt({ name: promptNameDraft, prompt: promptDraft });
    setSavingPrompt(false);
    if (ok) {
      setPromptEditorOpen(false);
      setPromptDraft("");
      setPromptNameDraft("");
    }
  };

  const emptyHint = (() => {
    if (query.trim() || kindFilter !== "all") return "没有匹配的资产";
    if (categoryFilter === "all") return status === "loading" ? "正在读取项目资产" : "在画布里生成或导入的资产会自动归位（图片/视频/音频各一堆），在这里分拣取用";
    if (categoryFilter === "uncategorized") return "还没有未分类的资产";
    if (isProjectAssetInboxCategory(categoryFilter)) {
      const inbox = PROJECT_ASSET_SYSTEM_CATEGORIES.find((item) => item.id === categoryFilter);
      return `画布里生成或导入的${inbox?.name.replace("资产", "") ?? "资产"}会自动堆到这里，用「⋯」菜单分拣进你自己建的文件夹`;
    }
    const category = categories.find((item) => item.id === categoryFilter);
    return category?.id === "pcat:prompt" ? "把常用提示词存到这里，随取随用" : `「${category?.name ?? ""}」还没有资产，从堆放区分拣或在画布里右键节点存入`;
  })();

  return (
    <section
      ref={panelRef}
      className="kc-workspace-assets"
      role="dialog"
      aria-label="工作资产库"
      data-kc-preserve-drawers
      data-kc-block-canvas-shortcuts
    >
      <header className="kc-workspace-assets-header">
        <span className="kc-workspace-assets-mark" aria-hidden="true"><Boxes /></span>
        <div className="kc-workspace-assets-titles">
          <strong>工作资产库</strong>
          <small title={`仅「${projectName}」这个画布项目可见，不会进入全站资产库`}>仅本画布项目 · {projectName}</small>
        </div>
        <button type="button" className="kc-workspace-assets-close" aria-label="收起工作资产库" title="收起" onClick={() => setOpen(false)}>
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="kc-workspace-assets-body">
        <aside className="kc-workspace-assets-cats" aria-label="资产分类">
          <button type="button" className={categoryFilter === "all" ? "is-active" : ""} onClick={() => setCategoryFilter("all")}>
            <FolderOpen aria-hidden="true" /><span>全部</span><small>{items.length}</small>
          </button>
          <button type="button" className={categoryFilter === "uncategorized" ? "is-active" : ""} onClick={() => setCategoryFilter("uncategorized")}>
            <Folder aria-hidden="true" /><span>未分类</span><small>{counts.uncategorized}</small>
          </button>
          <div className="kc-workspace-assets-cat-list">
            {categories.map((category) => {
              // 图片/视频堆放区不可删；默认分类与自建文件夹同权（重命名/删除）。
              const manageable = !isProjectAssetInboxCategory(category.id);
              return (
                <div className="kc-workspace-assets-cat-row" key={category.id}>
                  {editingCategoryId === category.id ? (
                    <form className="kc-workspace-assets-cat-edit" onSubmit={submitCategoryRename}>
                      <input
                        ref={categoryInputRef}
                        value={categoryDraft}
                        maxLength={24}
                        aria-label="重命名文件夹"
                        onChange={(event) => setCategoryDraft(event.target.value)}
                        onBlur={() => setEditingCategoryId(null)}
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditingCategoryId(null);
                        }}
                      />
                    </form>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={categoryFilter === category.id ? "is-active" : ""}
                        title={manageable ? category.name : `${category.name} · 画布里生成的${category.name.replace("资产", "")}会自动堆进这里`}
                        onClick={() => setCategoryFilter(category.id)}
                      >
                        <Folder aria-hidden="true" /><span>{category.name}</span>
                        <small>{counts.byCategory.get(category.id) ?? 0}</small>
                      </button>
                      {manageable ? (
                        <button
                          type="button"
                          className="kc-workspace-assets-cat-more"
                          aria-label={`${category.name} 的更多操作`}
                          title="更多操作"
                          onClick={(event) => {
                            const rect = event.currentTarget.getBoundingClientRect();
                            setMenu({ type: "category", x: rect.left, y: rect.bottom + 6, category });
                          }}
                        >
                          <MoreHorizontal aria-hidden="true" />
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              );
            })}
          </div>
          {creatingCategory ? (
            <form className="kc-workspace-assets-cat-edit" onSubmit={(event) => void submitNewCategory(event)}>
              <input
                ref={newCategoryInputRef}
                value={newCategoryDraft}
                placeholder="文件夹名称"
                maxLength={24}
                aria-label="新建文件夹"
                onChange={(event) => setNewCategoryDraft(event.target.value)}
                onBlur={() => { setCreatingCategory(false); setNewCategoryDraft(""); }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") { setCreatingCategory(false); setNewCategoryDraft(""); }
                }}
              />
            </form>
          ) : (
            <button
              type="button"
              className="kc-workspace-assets-cat-add"
              onClick={() => { setCreatingCategory(true); setNewCategoryDraft(""); }}
            >
              <FolderPlus aria-hidden="true" /><span>新建文件夹</span>
            </button>
          )}
        </aside>

        <div className="kc-workspace-assets-main">
          <div className="kc-workspace-assets-toolbar">
            <label className="kc-workspace-assets-search">
              <Search aria-hidden="true" />
              <input aria-label="搜索项目资产" placeholder="搜索资产" value={query} onChange={(event) => setQuery(event.target.value)} />
            </label>
            <div className="kc-workspace-assets-kinds" role="group" aria-label="资产类型">
              {KIND_FILTERS.map((kind) => (
                <button
                  type="button"
                  key={kind.value}
                  className={kindFilter === kind.value ? "is-active" : ""}
                  aria-pressed={kindFilter === kind.value}
                  onClick={() => setKindFilter(kind.value)}
                >
                  {kind.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="kc-workspace-assets-add-prompt"
              aria-label="新增提示词资产"
              title="新增提示词"
              onClick={() => { setPromptEditorOpen(true); setPromptDraft(""); setPromptNameDraft(""); }}
            >
              <Type aria-hidden="true" /><span>提示词</span>
            </button>
          </div>

          {promptEditorOpen ? (
            <div className="kc-workspace-assets-prompt-editor">
              <textarea
                ref={promptInputRef}
                value={promptDraft}
                placeholder="粘贴或写下提示词…"
                rows={3}
                aria-label="提示词内容"
                onChange={(event) => setPromptDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submitPrompt(); }
                }}
              />
              <footer>
                <input
                  value={promptNameDraft}
                  placeholder="名称（可留空）"
                  maxLength={32}
                  aria-label="提示词名称"
                  onChange={(event) => setPromptNameDraft(event.target.value)}
                />
                <span className="kc-workspace-assets-prompt-target">
                  存入 {categoryLabel(categoryFilter, categories)}
                </span>
                <button type="button" onClick={() => { setPromptEditorOpen(false); setPromptDraft(""); setPromptNameDraft(""); }}>取消</button>
                <button type="button" className="is-primary" disabled={!promptDraft.trim() || savingPrompt} onClick={() => void submitPrompt()}>
                  保存
                </button>
              </footer>
            </div>
          ) : null}

          <div className="kc-workspace-assets-grid-wrap">
            {!filtered.length ? (
              <div className="kc-workspace-assets-empty">
                <span aria-hidden="true">{kindFilter === "prompt" || categoryFilter === "pcat:prompt" ? <Type /> : <Boxes />}</span>
                <p>{emptyHint}</p>
                {promptEditorOpen ? null : (
                  <button type="button" onClick={() => { setPromptEditorOpen(true); setPromptDraft(""); setPromptNameDraft(""); }}>
                    <Plus aria-hidden="true" />新增提示词
                  </button>
                )}
              </div>
            ) : (
              <div className="kc-workspace-assets-grid">
                {filtered.map((item, index) => (
                  <article
                    className="kc-workspace-asset-card"
                    key={item.id}
                    style={{ ["--stagger-i" as string]: Math.min(index, 12) }}
                    tabIndex={0}
                    aria-label={`${item.name}，${kindLabel(item.kind)}`}
                    onDoubleClick={() => void insertItem(item)}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      void insertItem(item);
                    }}
                  >
                    <div className="kc-workspace-asset-preview">
                      <AssetPreview item={item} />
                    </div>
                    {editingItemId === item.id ? (
                      <input
                        ref={itemInputRef}
                        className="kc-workspace-asset-rename"
                        value={itemDraft}
                        maxLength={64}
                        aria-label="资产名称"
                        onChange={(event) => setItemDraft(event.target.value)}
                        onBlur={() => void submitItemRename()}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") void submitItemRename();
                          if (event.key === "Escape") setEditingItemId(null);
                        }}
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : (
                      <div className="kc-workspace-asset-meta">
                        <strong title={item.name}>{item.name}</strong>
                        <small>{categoryOf(item)?.name ?? kindLabel(item.kind)}</small>
                      </div>
                    )}
                    <div className="kc-workspace-asset-actions">
                      <button
                        type="button"
                        className="kc-workspace-asset-insert"
                        aria-label={`将 ${item.name} 加入画布`}
                        title="加入画布（双击卡片同效）"
                        onClick={(event) => { event.stopPropagation(); void insertItem(item); }}
                      >
                        <Plus aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="kc-workspace-asset-more"
                        aria-label={`${item.name} 的更多操作`}
                        title="更多操作"
                        onClick={(event) => {
                          event.stopPropagation();
                          const rect = event.currentTarget.getBoundingClientRect();
                          setMenu({ type: "item", x: rect.right, y: rect.bottom + 6, item });
                        }}
                      >
                        <MoreHorizontal aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {menu ? (
        <PanelMenu
          menu={menu}
          categories={categories}
          onClose={() => setMenu(null)}
          onInsert={(item) => void insertItem(item)}
          onMove={(item, categoryId) => { setMenu(null); void moveItem(item.id, categoryId); }}
          onRenameItem={beginItemRename}
          onDeleteItem={(item) => { setMenu(null); void removeItem(item.id); }}
          onRenameCategory={(category) => {
            setMenu(null);
            setCategoryDraft(category.name);
            setEditingCategoryId(category.id);
          }}
          onDeleteCategory={(category) => { setMenu(null); void removeCategory(category.id); }}
        />
      ) : null}
    </section>
  );
});

function PanelMenu({
  menu,
  categories,
  onClose,
  onInsert,
  onMove,
  onRenameItem,
  onDeleteItem,
  onRenameCategory,
  onDeleteCategory,
}: {
  menu: PanelMenuState;
  categories: ProjectAssetCategory[];
  onClose: () => void;
  onInsert: (item: ProjectAssetItem) => void;
  onMove: (item: ProjectAssetItem, categoryId: string | null) => void;
  onRenameItem: (item: ProjectAssetItem) => void;
  onDeleteItem: (item: ProjectAssetItem) => void;
  onRenameCategory: (category: ProjectAssetCategory) => void;
  onDeleteCategory: (category: ProjectAssetCategory) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>(() => clampMenuPosition(menu.x, menu.y, 210, 220));

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const next = clampMenuPosition(menu.x, menu.y, element.offsetWidth, element.offsetHeight);
    setPosition((current) => (current.left === next.left && current.top === next.top ? current : next));
  }, [menu.x, menu.y]);

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  if (menu.type === "item") {
    const { item } = menu;
    return createPortal(
      <div
        ref={menuRef}
        className="kc-context-menu kc-workspace-assets-menu"
        role="menu"
        aria-label={`${item.name} 资产操作`}
        data-kc-preserve-drawers
        data-kc-block-canvas-shortcuts
        style={position}
        onContextMenu={(event) => event.preventDefault()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <button role="menuitem" type="button" onClick={() => onInsert(item)}><Plus aria-hidden="true" />加入画布</button>
        <span className="kc-context-menu-divider" aria-hidden="true" />
        <span className="kc-resource-context-heading">移动到</span>
        <button
          role="menuitemradio"
          type="button"
          aria-checked={!item.categoryId}
          className={!item.categoryId ? "is-current" : undefined}
          onClick={() => onMove(item, null)}
        >
          <FolderOpen aria-hidden="true" /><span>未分类</span>{!item.categoryId ? <Check aria-hidden="true" /> : null}
        </button>
        {categories.map((category) => {
          const current = item.categoryId === category.id;
          return (
            <button
              role="menuitemradio"
              type="button"
              key={category.id}
              aria-checked={current}
              className={current ? "is-current" : undefined}
              onClick={() => onMove(item, category.id)}
            >
              <Folder aria-hidden="true" /><span>{category.name}</span>{current ? <Check aria-hidden="true" /> : null}
            </button>
          );
        })}
        <span className="kc-context-menu-divider" aria-hidden="true" />
        <button role="menuitem" type="button" onClick={() => { onClose(); onRenameItem(item); }}><Pencil aria-hidden="true" />重命名</button>
        <button role="menuitem" type="button" className="is-danger" onClick={() => onDeleteItem(item)}><Trash2 aria-hidden="true" />删除</button>
      </div>,
      document.body,
    );
  }

  const { category } = menu;
  return createPortal(
    <div
      ref={menuRef}
      className="kc-context-menu kc-workspace-assets-menu"
      role="menu"
      aria-label={`${category.name} 文件夹操作`}
      data-kc-preserve-drawers
      data-kc-block-canvas-shortcuts
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button role="menuitem" type="button" onClick={() => onRenameCategory(category)}><Pencil aria-hidden="true" />重命名</button>
      <button role="menuitem" type="button" className="is-danger" onClick={() => onDeleteCategory(category)}><Trash2 aria-hidden="true" />删除文件夹</button>
      <span className="kc-resource-context-note">文件夹内资产将移至未分类</span>
    </div>,
    document.body,
  );
}

function AssetPreview({ item }: { item: ProjectAssetItem }) {
  if (item.kind === "prompt") {
    return (
      <div className="kc-workspace-asset-preview-text">
        <Type aria-hidden="true" />
        <p>{item.prompt.slice(0, 64)}</p>
      </div>
    );
  }
  return <MediaPreview media={item.media} kind={item.kind} />;
}

function MediaPreview({ media, kind }: { media: CanvasMedia | null; kind: Exclude<ProjectAssetKind, "prompt"> }) {
  const thumb = useMediaThumbUrl(kind === "image" ? media : null);
  const video = useMediaUrl(kind === "video" ? media : null);
  if (!media) return <div className="kc-workspace-asset-preview-placeholder" aria-hidden="true"><FileText /></div>;
  if (kind === "image") {
    return thumb.url && !thumb.missing
      ? <img src={thumb.url} alt="" loading="lazy" />
      : <div className="kc-workspace-asset-preview-placeholder" aria-hidden="true"><ImageIcon /></div>;
  }
  if (kind === "video") {
    return video.url && !video.missing
      ? <video src={video.url} muted preload="metadata" tabIndex={-1} />
      : <div className="kc-workspace-asset-preview-placeholder" aria-hidden="true"><Film /></div>;
  }
  return (
    <div className="kc-workspace-asset-preview-placeholder is-audio" aria-hidden="true">
      <Music2 />
      <span>{formatAudioDuration(media.durationMs)}</span>
    </div>
  );
}

function categoryLabel(filter: ProjectAssetCategoryFilter, categories: ProjectAssetCategory[]) {
  if (filter === "all") return "提示词资产";
  if (filter === "uncategorized") return "未分类";
  return categories.find((category) => category.id === filter)?.name ?? "提示词资产";
}

function kindLabel(kind: ProjectAssetKind) {
  return ({ image: "图片", video: "视频", audio: "音频", prompt: "提示词" } as const)[kind];
}

function formatAudioDuration(durationMs: number | null | undefined) {
  if (!durationMs || durationMs <= 0) return "音频";
  const seconds = Math.round(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function clampMenuPosition(x: number, y: number, width: number, height: number): CSSProperties {
  return {
    left: Math.min(Math.max(x - width, 12), Math.max(12, window.innerWidth - width - 12)),
    top: Math.min(Math.max(y, 12), Math.max(12, window.innerHeight - height - 12)),
  };
}
