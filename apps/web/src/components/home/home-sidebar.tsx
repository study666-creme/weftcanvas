import {
  ExternalLink,
  FolderKanban,
  History,
  Home,
  Image as ImageIcon,
  Library,
  Lightbulb,
  Music2,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  Video,
  Wand2,
  Workflow,
  type LucideIcon,
} from "lucide-react";

import { formatBytes } from "../../lib/home-data";
import { prefetchCanvas } from "./home-project-actions";
import type { StorageEstimate } from "./use-home-library";

export type HomeTab = "home" | "projects" | "history" | "assets" | "templates" | "skills";

export const HOME_TABS: { id: HomeTab; label: string; icon: LucideIcon }[] = [
  { id: "home", label: "首页", icon: Home },
  { id: "projects", label: "我的项目", icon: FolderKanban },
  { id: "history", label: "创作历史", icon: History },
  { id: "assets", label: "资产库", icon: Library },
  { id: "templates", label: "灵感模板", icon: Lightbulb },
  { id: "skills", label: "技能", icon: Wand2 },
];

const GENERATE_LINKS: { href: string; label: string; icon: LucideIcon }[] = [
  { href: "/generate/image", label: "图片生成", icon: ImageIcon },
  { href: "/generate/video", label: "视频生成", icon: Video },
  { href: "/generate/audio", label: "音频生成", icon: Music2 },
];

export function HomeSidebar({
  tab,
  onTab,
  collapsed,
  onToggleCollapsed,
  counts,
  storage,
  cardLibraryUrl,
  shortcutLabel,
  tourAnchors,
  onCreateProject,
  onOpenCanvas,
  onOpenPalette,
}: {
  tab: HomeTab;
  onTab: (tab: HomeTab) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  counts: Partial<Record<HomeTab, number>>;
  storage: StorageEstimate;
  cardLibraryUrl: string;
  shortcutLabel: string;
  /** 是否在生成入口上挂新手教程锚点（窄屏抽屉模式下改挂到首页快速开始）。 */
  tourAnchors: boolean;
  onCreateProject: () => void;
  onOpenCanvas: () => void;
  onOpenPalette: () => void;
}) {
  const usage = storage ? Math.min(1, storage.usage / storage.quota) : 0;

  return (
    <aside
      className="wc-home-sidebar"
      aria-label="主页侧栏"
      data-collapsed={collapsed || undefined}
    >
      <div className="wc-home-sidebar-head">
        <a className="wc-home-brand" href="/" aria-label="纬线主页">
          <span className="wc-home-brand-mark">
            <img src="/weftcanvas-logo-ui.webp" alt="" aria-hidden="true" width={28} height={28} />
          </span>
          <span className="wc-home-brand-copy">
            <strong>纬线</strong>
            <small>Weftcanvas</small>
          </span>
        </a>
        <button
          type="button"
          className="wc-home-icon-button wc-home-collapse"
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          title={collapsed ? "展开侧栏" : "收起侧栏"}
          onClick={onToggleCollapsed}
        >
          {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
        </button>
      </div>

      <div className="wc-home-sidebar-actions">
        <button
          type="button"
          className="wc-home-new"
          onClick={onCreateProject}
          onPointerEnter={prefetchCanvas}
          title="新建画布"
        >
          <Plus aria-hidden="true" />
          <span>新建画布</span>
        </button>
        <button
          type="button"
          className="wc-home-search-trigger"
          onClick={onOpenPalette}
          aria-label="搜索项目、作品与操作"
          title={`搜索（${shortcutLabel}）`}
        >
          <Search aria-hidden="true" />
          <span>搜索</span>
          <kbd>{shortcutLabel}</kbd>
        </button>
      </div>

      <div className="wc-home-sidebar-scroll">
        <nav className="wc-home-nav" aria-label="主页分区">
          {HOME_TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={tab === id ? "is-active" : undefined}
              aria-current={tab === id ? "page" : undefined}
              title={collapsed ? label : undefined}
              onClick={() => onTab(id)}
            >
              <Icon aria-hidden="true" />
              <span>{label}</span>
              {counts[id] ? <span className="wc-home-nav-count">{counts[id]}</span> : null}
            </button>
          ))}
        </nav>

        <div className="wc-home-nav-group" role="group" aria-labelledby="wc-home-generate-label">
          <span className="wc-home-nav-label" id="wc-home-generate-label">
            快速生成
          </span>
          <nav className="wc-home-nav" aria-label="生成入口">
            {GENERATE_LINKS.map(({ href, label, icon: Icon }) => (
              // 新手教程第一步（去简易工作台）的锚点：三个生成入口都挂上，
              // 教程环套第一个命中的「图片生成」。
              <a
                key={href}
                href={href}
                data-wc-tour={tourAnchors ? "goto-workbench" : undefined}
                title={collapsed ? label : undefined}
              >
                <Icon aria-hidden="true" />
                <span>{label}</span>
              </a>
            ))}
            <a
              href="/canvas"
              title={collapsed ? "创作画布" : undefined}
              onPointerEnter={prefetchCanvas}
              onClick={(event) => {
                if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
                event.preventDefault();
                onOpenCanvas();
              }}
            >
              <Workflow aria-hidden="true" />
              <span>创作画布</span>
            </a>
            {cardLibraryUrl ? (
              <a href={cardLibraryUrl} target="_blank" rel="noreferrer" title="卡片库（新窗口）">
                <Library aria-hidden="true" />
                <span>卡片库</span>
                <ExternalLink className="wc-home-nav-trailing" aria-hidden="true" />
              </a>
            ) : null}
          </nav>
        </div>
      </div>

      <div className="wc-home-sidebar-foot">
        {storage ? (
          <div
            className="wc-home-storage"
            title={`本机已用 ${formatBytes(storage.usage)}，可用上限约 ${formatBytes(storage.quota)}`}
          >
            <div className="wc-home-storage-row">
              <span>本地存储</span>
              <span className="is-numeric">{formatBytes(storage.usage)}</span>
            </div>
            <span
              className="wc-home-meter"
              role="meter"
              aria-label="本地存储用量"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(usage * 100)}
            >
              <i style={{ transform: `scaleX(${Math.max(usage, 0.01)})` }} />
            </span>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
