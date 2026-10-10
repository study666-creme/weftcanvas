import { canvasNodeLabels, type CanvasNodeKind } from "@kachang/contracts";
import { creatableNodeKinds } from "../lib/canvas-features";
import { communityLargeImageUrl, communityPostToInsertable, communityThumbUrl, fetchCommunityPosts, sortCommunityPosts, type CommunitySort } from "../lib/community-client";
import { useToastStore } from "../state/toast-store";
import { Clock, Clapperboard, Eraser, Hand, Heart, LoaderCircle, Plus, Redo2, SlidersHorizontal, Trash2, Undo2, Upload, User, Users } from "lucide-react";
import { useReactFlow } from "@xyflow/react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";

import cardLibraryLogo from "../assets/card-library-logo.png";
import type { CommunityFeedPost } from "@kachang/contracts";
import { nodeCreationDimensions } from "../lib/node-factory";
import { findOpenNodePosition } from "../lib/node-placement";
import { useCanvasStore } from "../state/canvas-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import type { InsertableAsset } from "./resource-drawer";
import type { KachangEdge, KachangNode } from "../types";
import { AppearanceToolbar } from "./appearance-toolbar";
import { CardPreviewLightbox, type CardPreviewItem, type CardPreviewMeta } from "./card-preview-lightbox";
import { CardHoverPreview, type CardHoverPreviewSource } from "./card-hover-preview";
import { CardThumbnail } from "./card-thumbnail";
import { nodeIcons } from "./node-icon";

/**
 * 底部 dock + 创建栏。
 *
 * appearanceOpen 状态已提升到 canvas-workspace，触发器由顶部 TopBarSettings 和
 * 底部 UI 设置按钮共用同一个 ref。两个入口共存：顶部设置键（hover 弹 创作设置/
 * 项目协作 / 点击开「设置」面板）+ 底部 dock 的 UI 设置键（点击开同一面板）。
 */
export const BottomToolbar = memo(function BottomToolbar({
  panMode,
  resourceOpen,
  onTogglePan,
  onToggleResource,
  onOpenDirector,
  onImport,
  onRequestClear,
  getCanvasCenter,
  appearanceOpen,
  appearanceTriggerRef,
  onToggleAppearance,
  onCloseAppearance,
  onInsertAsset,
}: {
  panMode: boolean;
  resourceOpen: boolean;
  onTogglePan: () => void;
  onToggleResource: () => void;
  onOpenDirector: () => void;
  onImport: () => void;
  onRequestClear: () => void;
  getCanvasCenter: () => { x: number; y: number };
  appearanceOpen: boolean;
  appearanceTriggerRef: RefObject<HTMLButtonElement | null>;
  onToggleAppearance: () => void;
  onCloseAppearance: () => void;
  onInsertAsset?: (asset: InsertableAsset) => void;
}) {
  const addNode = useCanvasStore((state) => state.addNode);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const canUndo = useCanvasStore((state) => state.past.length > 0);
  const canRedo = useCanvasStore((state) => state.future.length > 0);
  const hasSelection = useCanvasStore((state) => state.nodes.some((node) => node.selected) || state.edges.some((edge) => edge.selected));
  const hasContent = useCanvasStore((state) => state.nodes.length > 0 || state.edges.length > 0);
  const deleteSelection = useCanvasStore((state) => state.deleteSelection);
  const defaultNodeAspectRatio = useUiPreferencesStore((state) => state.defaultNodeAspectRatio);
  const { getZoom, screenToFlowPosition, setCenter } = useReactFlow<KachangNode, KachangEdge>();
  const dockRef = useRef<HTMLElement>(null);
  const showToast = useToastStore((state) => state.show);

  // 社区流：首次 hover 拉取，5 分钟内复用缓存（缓存逻辑在 community-client）；
  // 失败后 30 秒节流重试，避免每次 hover 都打上游。
  const [communityStatus, setCommunityStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [communityPosts, setCommunityPosts] = useState<CommunityFeedPost[]>([]);
  const [communityThumbs, setCommunityThumbs] = useState<Record<string, string>>({});
  const [communityFailedAt, setCommunityFailedAt] = useState(0);
  const [communitySort, setCommunitySort] = useState<CommunitySort>("random");
  const [insertingPostId, setInsertingPostId] = useState<string | null>(null);
  const [communityPreview, setCommunityPreview] = useState<{ item: CardPreviewItem; post: CommunityFeedPost } | null>(null);
  // 悬停社区卡片 = 视口右侧大图快览；离开弹层列表即收起，点击仍是完整预览层。
  const [communityHover, setCommunityHover] = useState<CardHoverPreviewSource | null>(null);
  const communityLoadingRef = useRef(false);

  // 拉一批（30 条）后在本地按排序渲染；random 用 memo 固定，避免重渲染洗牌跳动
  const sortedCommunityPosts = useMemo(
    () => sortCommunityPosts(communityPosts, communitySort),
    [communityPosts, communitySort],
  );

  const loadCommunity = useCallback((force = false) => {
    if (communityLoadingRef.current) return;
    communityLoadingRef.current = true;
    setCommunityStatus("loading");
    void (async () => {
      try {
        const posts = await fetchCommunityPosts(30, force);
        const thumbs: Record<string, string> = {};
        await Promise.all(posts.map(async (post) => {
          const url = await communityThumbUrl(post).catch(() => null);
          if (url) thumbs[post.id] = url;
        }));
        setCommunityPosts(posts);
        setCommunityThumbs(thumbs);
        setCommunityStatus("ready");
      } catch {
        setCommunityFailedAt(Date.now());
        setCommunityStatus("error");
      } finally {
        communityLoadingRef.current = false;
      }
    })();
  }, []);

  const maybeLoadCommunity = useCallback(() => {
    if (communityStatus === "idle") loadCommunity();
    else if (communityStatus === "error" && Date.now() - communityFailedAt > 30_000) loadCommunity(true);
  }, [communityStatus, communityFailedAt, loadCommunity]);

  // 悬停意图：社区面板是一个远大于 34px 按钮的右侧弹层，光标必须穿过 rail 的
  // 兄弟按钮/空隙才能到达。纯 CSS :hover 在光标离开按钮盒子的瞬间就断链，斜向
  // 移向面板会先落到上方「3D 导演台」上，面板直接消失。这里改成「进入即开 +
  // 离开延迟 320ms 收起」：面板是 wrapper 的 DOM 后代，光标在延迟内落到面板上时
  // React 会重新触发 wrapper 的 mouseenter，收起被取消。延迟窗口比放大鼠标桥几何
  // 更稳，也不会像加宽桥那样压住上方按钮的点击区。
  const [communityOpen, setCommunityOpen] = useState(false);
  const communityCloseTimer = useRef<number | null>(null);

  const cancelCommunityClose = useCallback(() => {
    if (communityCloseTimer.current === null) return;
    window.clearTimeout(communityCloseTimer.current);
    communityCloseTimer.current = null;
  }, []);

  const openCommunity = useCallback(() => {
    cancelCommunityClose();
    setCommunityOpen(true);
    maybeLoadCommunity();
  }, [cancelCommunityClose, maybeLoadCommunity]);

  const scheduleCommunityClose = useCallback(() => {
    cancelCommunityClose();
    communityCloseTimer.current = window.setTimeout(() => {
      communityCloseTimer.current = null;
      setCommunityOpen(false);
      setCommunityHover(null);
    }, 320);
  }, [cancelCommunityClose]);

  useEffect(() => () => {
    if (communityCloseTimer.current !== null) window.clearTimeout(communityCloseTimer.current);
  }, []);

  /** 插入成功返回 true，预览层据此决定是否自动关闭。 */
  const insertCommunityPost = useCallback((post: CommunityFeedPost): Promise<boolean> => {
    if (insertingPostId || !onInsertAsset) return Promise.resolve(false);
    setInsertingPostId(post.id);
    return communityPostToInsertable(post)
      .then((insertable) => {
        if (!insertable) {
          showToast("这张帖子暂时无法加入画布", "error");
          return false;
        }
        onInsertAsset(insertable);
        showToast("已加入画布", "success");
        return true;
      })
      .catch(() => {
        showToast("加入画布失败，请稍后再试", "error");
        return false;
      })
      .finally(() => setInsertingPostId(null));
  }, [insertingPostId, onInsertAsset, showToast]);

  // 点击卡片 = 打开大图预览（不再直接插入）；加入画布只认右侧操作键。
  const openCommunityPreview = useCallback((post: CommunityFeedPost) => {
    const author = (post.authorName || "").trim();
    const likes = post.likes ?? 0;
    const createdAt = post.createdAt ?? 0;
    const meta: CardPreviewMeta[] = [];
    if (author) meta.push({ icon: <User aria-hidden="true" />, text: author, title: "作者" });
    if (likes > 0) meta.push({ icon: <Heart aria-hidden="true" />, text: `${likes}`, title: "点赞" });
    if (createdAt > 0) meta.push({ icon: <Clock aria-hidden="true" />, text: communityDateText(createdAt), title: "发布时间" });
    setCommunityPreview({
      post,
      item: {
        key: post.id,
        title: (post.title || post.prompt || "社区作品").slice(0, 40),
        prompt: post.prompt || "",
        meta,
        footerNote: "来自 prompt-hubs 社区",
        thumbnailUrl: communityThumbs[post.id] ?? "",
        resolveImages: () => communityLargeImageUrl(post),
      },
    });
  }, [communityThumbs]);

  useEffect(() => {
    if (!appearanceOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node) {
        if (dockRef.current?.contains(target)) return;
        // 顶部设置键自己管理开合（点击 = 切换面板），不走"点外关闭"，
        // 否则 pointerdown 先关、click 再开，面板永远关不掉。
        if (target instanceof Element && target.closest(".kc-topbar-settings")) return;
      }
      onCloseAppearance();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseAppearance();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [appearanceOpen, onCloseAppearance]);

  useEffect(() => {
    if (resourceOpen) onCloseAppearance();
  }, [resourceOpen, onCloseAppearance]);

  const createAtCenter = (kind: CanvasNodeKind) => {
    const zoom = getZoom();
    const position = screenToFlowPosition(getCanvasCenter());
    const dimensions = nodeCreationDimensions(kind, defaultNodeAspectRatio);
    const preferred = { x: position.x - dimensions.width / 2, y: position.y - dimensions.height / 2 };
    const openPosition = findOpenNodePosition(preferred, dimensions, useCanvasStore.getState().nodes);
    addNode(kind, openPosition);
    window.requestAnimationFrame(() => {
      void setCenter(
        openPosition.x + dimensions.width / 2,
        openPosition.y + dimensions.height / 2,
        {
          zoom: getZoom(),
          duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180,
        },
      );
    });
  };

  return (
    <>
      <nav className="kc-create-rail" aria-label="创建工具">
        <div className="kc-create-rail-plus-wrapper">
          <button
            type="button"
            className="kc-create-rail-plus"
            aria-label="添加节点"
            aria-haspopup="menu"
            aria-expanded="false"
            title="添加节点"
          >
            <Plus aria-hidden="true" />
          </button>
          <div className="kc-create-rail-popover" role="menu" aria-label="节点类型">
            {creatableNodeKinds.map((kind) => {
              const Icon = nodeIcons[kind];
              const label = canvasNodeLabels[kind];
              return (
                <button
                  key={kind}
                  type="button"
                  role="menuitem"
                  className={`kc-add-node kc-add-node--${kind}`}
                  aria-label={`添加${label}`}
                  title={`添加${label}`}
                  onClick={() => createAtCenter(kind)}
                >
                  <Icon aria-hidden="true" />
                  <span className="kc-add-node-label">{label}</span>
                </button>
              );
            })}
          </div>
        </div>
        <span className="kc-create-rail-divider" aria-hidden="true" />
        <button type="button" aria-label="导入素材" title="导入素材" onClick={onImport}>
          <Upload aria-hidden="true" />
        </button>
        <button type="button" className="kc-director-button" aria-label="打开 3D 导演台" title="3D 导演台" onClick={onOpenDirector}>
          <Clapperboard aria-hidden="true" />
        </button>
        {/* 社区入口：hover 浮现 prompt-hubs 公开社区卡片，点击卡片放大查看，
            加入画布走右侧「画布」键或预览层主操作键（与卡片库同一套
            下载→入库→建节点链路）。数据经画布 API 同源代理拉取。 */}
        <span className="kc-create-rail-divider" aria-hidden="true" />
        <div
          className={`kc-create-rail-community-wrapper${communityOpen ? " is-open" : ""}`}
          onMouseEnter={openCommunity}
          onMouseLeave={scheduleCommunityClose}
        >
          <button
            type="button"
            className="kc-create-rail-community"
            aria-label="社区卡片"
            aria-haspopup="menu"
            title="社区"
          >
            <Users aria-hidden="true" />
          </button>
          <div className="kc-create-rail-community-popover" role="menu" aria-label="社区卡片">
            <div className="kc-community-popover-header">
              <strong>社区卡片</strong>
              <span className="kc-community-popover-hint">来自 prompt-hubs 社区 · 点击卡片放大查看</span>
              <div className="kc-community-popover-tabs" role="group" aria-label="排序">
                {([
                  ["random", "随机"],
                  ["hot", "热门"],
                  ["new", "最新"],
                ] as const).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className={`kc-community-tab ${communitySort === value ? "is-active" : ""}`}
                    aria-pressed={communitySort === value}
                    onClick={() => setCommunitySort(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            {communityStatus === "idle" || communityStatus === "loading" ? (
              <div className="kc-community-popover-list" aria-busy="true">
                {[0, 1, 2, 3].map((i) => (
                  <span className="kc-community-skeleton" key={i} aria-hidden="true" />
                ))}
              </div>
            ) : communityStatus === "error" ? (
              <div className="kc-community-popover-empty">
                社区数据加载失败，
                <button type="button" className="kc-community-retry" onClick={() => loadCommunity(true)}>点击重试</button>
              </div>
            ) : sortedCommunityPosts.length === 0 ? (
              <div className="kc-community-popover-empty">社区还没有作品，去 prompt-hubs 发布第一张吧。</div>
            ) : (
              <div className="kc-community-popover-list" onMouseLeave={() => setCommunityHover(null)}>
                {sortedCommunityPosts.map((post) => {
                  const thumb = communityThumbs[post.id] ?? "";
                  const title = (post.title || post.prompt || "社区作品").slice(0, 40);
                  const author = (post.authorName || "").trim();
                  return (
                    <article
                      key={post.id}
                      role="menuitem"
                      tabIndex={0}
                      className="kc-community-item"
                      title={[title, author ? `作者：${author}` : "", "点击放大查看"].filter(Boolean).join(" · ")}
                      aria-label={`放大查看社区作品${author ? `（作者 ${author}）` : ""}`}
                      onMouseEnter={() => setCommunityHover((current) => current?.key === post.id ? current : {
                        key: post.id,
                        title,
                        thumbnailUrl: thumb,
                        resolveImages: () => communityLargeImageUrl(post),
                      })}
                      onClick={() => openCommunityPreview(post)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter" && event.key !== " ") return;
                        event.preventDefault();
                        openCommunityPreview(post);
                      }}
                    >
                      <CardThumbnail thumbUrl={thumb} title={title} />
                      <div className="kc-community-copy">
                        <strong>{title}</strong>
                        <p>{post.prompt || "无文字内容"}</p>
                      </div>
                      <button
                        type="button"
                        className="kc-community-insert"
                        aria-label={`加入画布 ${title}`}
                        title="直接加入画布"
                        disabled={insertingPostId !== null}
                        onClick={(event) => {
                          event.stopPropagation();
                          insertCommunityPost(post);
                        }}
                      >
                        {insertingPostId === post.id ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Plus aria-hidden="true" />}
                        <span>画布</span>
                      </button>
                    </article>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </nav>

      <nav ref={dockRef} className="kc-edit-dock" aria-label="编辑工具">
        <AppearanceToolbar
          open={appearanceOpen}
          triggerRef={appearanceTriggerRef}
          onClose={onCloseAppearance}
        />
        <div className="kc-edit-dock-side kc-edit-dock-side--left">
          <button type="button" className={panMode ? "is-active" : ""} aria-label="平移画布" title="平移画布" aria-pressed={panMode} onClick={onTogglePan}>
            <Hand aria-hidden="true" />
          </button>
          <span className="kc-edit-dock-divider" aria-hidden="true" />
          <button type="button" aria-label="撤销" title="撤销" disabled={!canUndo} onClick={undo}>
            <Undo2 aria-hidden="true" />
          </button>
          <button type="button" aria-label="重做" title="重做" disabled={!canRedo} onClick={redo}>
            <Redo2 aria-hidden="true" />
          </button>
        </div>
        {/* data-kc-preserve-drawers：这个键自己管理开合（点击 = 切换面板），不能走资源库的
            "点外关闭"——否则快速连点时会先被面板判成点外、再被按钮当成第二次点击，面板永远打不开。 */}
        <button type="button" data-kc-preserve-drawers className={resourceOpen ? "is-active kc-resource-toggle" : "kc-resource-toggle"} aria-label={resourceOpen ? "收起资源库" : "打开资源库"} title="卡片与资产" aria-pressed={resourceOpen} onClick={() => { onCloseAppearance(); onToggleResource(); }}>
          <img className="kc-resource-toggle-logo" src={cardLibraryLogo} alt="" aria-hidden="true" width={24} height={24} draggable={false} />
        </button>
        <div className="kc-edit-dock-side kc-edit-dock-side--right">
          {/* UI 设置键：与顶部"设置"键共用 appearanceOpen，两个入口共存 */}
          <button
            type="button"
            className={appearanceOpen ? "is-active" : ""}
            aria-label={appearanceOpen ? "收起 UI 设置" : "打开 UI 设置"}
            title="UI 设置"
            aria-haspopup="dialog"
            aria-expanded={appearanceOpen}
            aria-controls="kc-appearance-toolbar"
            onClick={onToggleAppearance}
          >
            <SlidersHorizontal aria-hidden="true" />
          </button>
          <button type="button" className="is-danger" aria-label="删除选中内容" title="删除选中内容" disabled={!hasSelection} onClick={deleteSelection}>
            <Trash2 aria-hidden="true" />
          </button>
          <button type="button" className="is-danger" aria-label="清空画布" title="清空画布" disabled={!hasContent} onClick={onRequestClear}>
            <Eraser aria-hidden="true" />
          </button>
        </div>
      </nav>

      {communityPreview ? (
        <CardPreviewLightbox
          item={communityPreview.item}
          actions={[
            {
              label: "加入画布",
              icon: <Plus aria-hidden="true" />,
              variant: "primary",
              busy: insertingPostId === communityPreview.post.id,
              busyLabel: "加入中…",
              onAction: () => {
                void insertCommunityPost(communityPreview.post).then((added) => {
                  if (added) setCommunityPreview(null);
                });
              },
            },
          ]}
          onClose={() => setCommunityPreview(null)}
        />
      ) : null}
      <CardHoverPreview source={communityHover} />
    </>
  );
});

function communityDateText(createdAt: number) {
  return new Date(createdAt).toLocaleDateString("zh-CN", { year: "numeric", month: "short", day: "numeric" });
}