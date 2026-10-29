import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CircleUserRound,
  FileUp,
  FolderKanban,
  History,
  Image as ImageIcon,
  Lightbulb,
  Library,
  Menu,
  Moon,
  Music2,
  PanelLeft,
  Plus,
  Sparkles,
  Sun,
  Video,
  Wand2,
  Workflow,
} from "lucide-react";

import "../../home-dashboard.css";
import { WEFTCANVAS_API_SITE_URL } from "../../lib/custom-api";
import type { HomeWork } from "../../lib/home-data";
import { HOME_TEMPLATES, type HomeTemplate } from "../../lib/home-templates";
import { useIdentityStore } from "../../state/identity-store";
import { HomeAssetsSection } from "./home-assets";
import { HomeCommandPalette, type PaletteItem } from "./home-command-palette";
import type { HomeComposerHandle } from "./home-composer";
import { HomeHistorySection } from "./home-history";
import { HomeOverview } from "./home-overview";
import {
  createProject as createProjectAction,
  importProjectFile,
  openProject as openProjectAction,
  prefetchCanvas,
} from "./home-project-actions";
import { HomeProjectsSection, type ProjectCardActions } from "./home-projects";
import { HOME_TABS, HomeSidebar, type HomeTab } from "./home-sidebar";
import { HomeSkillsSection } from "./home-skills";
import { HomeTemplatesSection } from "./home-templates-section";
import { HomeWorkPreview } from "./home-work-preview";
import { useHomeLibrary } from "./use-home-library";

const COLLAPSE_STORAGE_KEY = "weftcanvas:home:sidebar-collapsed:v1";
const TAB_IDS = new Set<HomeTab>(HOME_TABS.map((tab) => tab.id));

function tabFromLocation(): HomeTab {
  const value = new URLSearchParams(window.location.search).get("tab");
  return value && TAB_IDS.has(value as HomeTab) ? (value as HomeTab) : "home";
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const SHORTCUT_LABEL = isMac ? "⌘K" : "Ctrl K";

const NARROW_QUERY = "(max-width: 960px)";

/** 窄屏时侧栏收进抽屉：新手教程的「去工作台」锚点改挂到首页的快速开始卡上。 */
function useNarrowLayout() {
  const [narrow, setNarrow] = useState(() => window.matchMedia?.(NARROW_QUERY).matches ?? false);
  useEffect(() => {
    const query = window.matchMedia?.(NARROW_QUERY);
    if (!query) return;
    const sync = () => setNarrow(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  return narrow;
}

function isTypingTarget(target: EventTarget | null) {
  const element = target as HTMLElement | null;
  if (!element) return false;
  return Boolean(
    element.closest("input, textarea, select, [contenteditable='true'], [role='dialog']"),
  );
}

/**
 * 工作台式主页（首屏）。左侧栏：新建 / 搜索 / 分区导航 / 快速生成 / 存储用量；
 * 主区按分区切换：首页（生成框 + 快速开始 + 最近项目 + 创作历史 + 灵感模板）、
 * 我的项目、创作历史、资产库、灵感模板、技能。分区写在 `?tab=`，刷新与前进后退都能还原。
 *
 * 所有内容都来自浏览器里的真实数据（本地项目库、资产库、工作台历史）；没有数据时
 * 给出空状态与下一步，不放占位作品。
 */
export function HomeDashboard({
  onEnter,
  theme,
  onToggleTheme,
}: {
  onEnter: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const [tab, setTab] = useState<HomeTab>(tabFromLocation);
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [preview, setPreview] = useState<{ list: HomeWork[]; index: number } | null>(null);
  const composerRef = useRef<HomeComposerHandle>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const pendingFill = useRef<{ prompt: string; modality?: HomeTemplate["modality"] } | null>(null);

  const identityStatus = useIdentityStore((state) => state.status);
  const identitySession = useIdentityStore((state) => state.session);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const identityUserId = identitySession?.user.id ?? null;
  const displayName = identitySession?.user.displayName ?? null;

  const narrow = useNarrowLayout();
  const library = useHomeLibrary(identityUserId);
  const { projects, refreshProjects } = library;

  const navigate = useCallback((next: HomeTab, { push = true } = {}) => {
    setTab(next);
    setDrawerOpen(false);
    const url = new URL(window.location.href);
    if (next === "home") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    const href = `${url.pathname}${url.search}${url.hash}`;
    if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      if (push) window.history.pushState(null, "", href);
      else window.history.replaceState(null, "", href);
    }
    mainRef.current?.scrollTo({ top: 0 });
  }, []);

  useEffect(() => {
    const onPop = () => setTab(tabFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // 切回首页后再把模板/历史提示词放进生成框（生成框只在首页分区挂载）。
  useEffect(() => {
    if (tab !== "home" || !pendingFill.current) return;
    const { prompt, modality } = pendingFill.current;
    pendingFill.current = null;
    requestAnimationFrame(() => composerRef.current?.fill(prompt, modality));
  }, [tab]);

  const fillComposer = useCallback(
    (prompt: string, modality?: HomeTemplate["modality"]) => {
      if (tab === "home" && composerRef.current) {
        composerRef.current.fill(prompt, modality);
        return;
      }
      pendingFill.current = { prompt, modality };
      navigate("home");
    },
    [navigate, tab],
  );

  const toggleCollapsed = () => {
    setCollapsed((value) => {
      const next = !value;
      try {
        localStorage.setItem(COLLAPSE_STORAGE_KEY, next ? "1" : "0");
      } catch {
        // 偏好只是便利。
      }
      return next;
    });
  };

  const openProject = useCallback(
    (projectId: string) => {
      setPreview(null);
      void openProjectAction(projectId, onEnter);
    },
    [onEnter],
  );
  const createProject = useCallback(
    () => void createProjectAction(onEnter, projects.length > 0),
    [onEnter, projects.length],
  );
  const openCanvas = useCallback(() => onEnter(), [onEnter]);
  const requestImport = useCallback(() => importInputRef.current?.click(), []);

  const projectActions = useMemo<ProjectCardActions>(
    () => ({ onOpen: openProject, onChanged: refreshProjects }),
    [openProject, refreshProjects],
  );

  const openWork = useCallback((work: HomeWork, list: HomeWork[]) => {
    const index = Math.max(
      0,
      list.findIndex((item) => item.key === work.key),
    );
    setPreview({ list, index });
  }, []);

  const templateWorkbench = useCallback((template: HomeTemplate) => {
    const query = new URLSearchParams({ prompt: template.prompt });
    window.location.assign(`/generate/${template.modality}?${query.toString()}`);
  }, []);

  // ⌘K / Ctrl+K 打开搜索；「/」聚焦生成框（不在输入时）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !isTypingTarget(event.target)) {
        event.preventDefault();
        if (tab !== "home") navigate("home");
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, tab]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const counts = useMemo(
    () => ({
      projects: projects.length,
      history: library.works.length,
      assets: library.assets?.length ?? 0,
    }),
    [library.assets, library.works.length, projects.length],
  );

  const paletteItems = useMemo<PaletteItem[]>(() => {
    const actions: PaletteItem[] = [
      {
        id: "action-new",
        group: "操作",
        label: "新建画布",
        icon: <Plus />,
        keywords: "new canvas project 项目",
        run: createProject,
      },
      {
        id: "action-canvas",
        group: "操作",
        label: "打开画布",
        hint: "继续当前项目",
        icon: <Workflow />,
        keywords: "open canvas",
        run: openCanvas,
      },
      {
        id: "action-image",
        group: "操作",
        label: "图片生成",
        icon: <ImageIcon />,
        keywords: "image 生图 工作台",
        run: () => window.location.assign("/generate/image"),
      },
      {
        id: "action-video",
        group: "操作",
        label: "视频生成",
        icon: <Video />,
        keywords: "video 工作台",
        run: () => window.location.assign("/generate/video"),
      },
      {
        id: "action-audio",
        group: "操作",
        label: "音频生成",
        icon: <Music2 />,
        keywords: "audio music 音乐 工作台",
        run: () => window.location.assign("/generate/audio"),
      },
      {
        id: "action-import",
        group: "操作",
        label: "导入项目",
        hint: "项目文件或完整备份",
        icon: <FileUp />,
        keywords: "import json zip 备份",
        run: requestImport,
      },
      {
        id: "action-theme",
        group: "操作",
        label: theme === "light" ? "切换到深色模式" : "切换到浅色模式",
        icon: theme === "light" ? <Moon /> : <Sun />,
        keywords: "theme dark light 主题 夜间 白天",
        run: onToggleTheme,
      },
      {
        id: "action-sidebar",
        group: "操作",
        label: collapsed ? "展开侧栏" : "收起侧栏",
        icon: <PanelLeft />,
        keywords: "sidebar 侧栏",
        run: toggleCollapsed,
      },
      ...(
        [
          ["projects", "前往我的项目", FolderKanban],
          ["history", "前往创作历史", History],
          ["assets", "前往资产库", Library],
          ["templates", "前往灵感模板", Lightbulb],
          ["skills", "前往技能", Wand2],
        ] as const
      ).map(([id, label, Icon]) => ({
        id: `goto-${id}`,
        group: "操作",
        label,
        icon: <Icon />,
        run: () => navigate(id),
      })),
    ];
    const projectItems: PaletteItem[] = projects.map((project) => ({
      id: `project-${project.id}`,
      group: "项目",
      label: project.name,
      hint: `${project.nodeCount} 个节点`,
      icon: <Workflow />,
      run: () => openProject(project.id),
    }));
    const workItems: PaletteItem[] = library.works.slice(0, 60).map((work, index, list) => ({
      id: `work-${work.key}`,
      group: "作品",
      label: work.prompt || work.media.name,
      hint: work.origin.type === "project" ? work.origin.projectName : undefined,
      icon: work.kind === "image" ? <ImageIcon /> : work.kind === "video" ? <Video /> : <Music2 />,
      keywords: work.model ?? "",
      run: () => setPreview({ list: [...list], index }),
    }));
    const templateItems: PaletteItem[] = HOME_TEMPLATES.map((template) => ({
      id: `template-${template.id}`,
      group: "模板",
      label: template.title,
      hint: "填入生成框",
      icon: <Sparkles />,
      keywords: template.prompt,
      run: () => fillComposer(template.prompt, template.modality),
    }));
    return [...actions, ...projectItems, ...workItems, ...templateItems];
    // toggleCollapsed 只读 setState，稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    collapsed,
    createProject,
    fillComposer,
    library.works,
    navigate,
    onToggleTheme,
    openCanvas,
    openProject,
    projects,
    requestImport,
    theme,
  ]);

  const tabLabel = HOME_TABS.find((item) => item.id === tab)?.label ?? "首页";

  return (
    <section
      className="wc-home"
      aria-label="纬线主页"
      data-sidebar={collapsed ? "collapsed" : "expanded"}
      data-drawer={drawerOpen ? "open" : undefined}
    >
      <HomeSidebar
        tab={tab}
        onTab={(next) => navigate(next)}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        counts={counts}
        storage={library.storage}
        cardLibraryUrl={WEFTCANVAS_API_SITE_URL}
        shortcutLabel={SHORTCUT_LABEL}
        tourAnchors={!narrow}
        onCreateProject={createProject}
        onOpenCanvas={openCanvas}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <button
        type="button"
        className="wc-home-scrim"
        aria-label="关闭侧栏"
        tabIndex={drawerOpen ? 0 : -1}
        onClick={() => setDrawerOpen(false)}
      />

      <div className="wc-home-main-column">
        <header className="wc-home-topbar">
          <button
            type="button"
            className="wc-home-icon-button wc-home-menu-toggle"
            aria-label="打开侧栏"
            aria-expanded={drawerOpen}
            onClick={() => setDrawerOpen(true)}
          >
            <Menu aria-hidden="true" />
          </button>
          <span className="wc-home-topbar-title" aria-hidden={tab === "home"}>
            {tabLabel}
          </span>
          <div className="wc-home-topbar-actions">
            <button
              type="button"
              className="wc-home-icon-button wc-entry-theme-action"
              aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}
              title={theme === "light" ? "深色模式" : "浅色模式"}
              onClick={onToggleTheme}
            >
              {theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="wc-home-account"
              aria-label={identitySession ? `账号：${displayName}` : "登录画布账号"}
              onClick={() => openAccount("login")}
            >
              {identitySession ? (
                <span className="wc-home-avatar" aria-hidden="true">
                  {(displayName ?? "?").trim().slice(0, 1).toUpperCase()}
                </span>
              ) : (
                <CircleUserRound aria-hidden="true" />
              )}
              <span>
                {identitySession
                  ? displayName
                  : identityStatus === "unavailable"
                    ? "本地模式"
                    : "登录"}
              </span>
            </button>
            <button
              type="button"
              className="wc-home-button is-primary wc-home-open-canvas"
              onClick={openCanvas}
              onPointerEnter={prefetchCanvas}
              onFocus={prefetchCanvas}
            >
              <span>打开画布</span>
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </header>

        <main ref={mainRef} className="wc-home-main" data-tab={tab}>
          <div className="wc-home-content">
            {tab === "home" ? (
              <HomeOverview
                ref={composerRef}
                displayName={displayName}
                projects={projects}
                digests={library.digests}
                activeProjectId={library.activeProjectId}
                works={library.works}
                worksLoading={library.worksLoading}
                projectActions={projectActions}
                onCreateProject={createProject}
                onImportProject={requestImport}
                onNavigate={navigate}
                onOpenWork={openWork}
                onUseTemplate={(template) => fillComposer(template.prompt, template.modality)}
                onTemplateWorkbench={templateWorkbench}
                onInspiration={(idea) => fillComposer(idea)}
                tourAnchors={narrow}
              />
            ) : tab === "projects" ? (
              <HomeProjectsSection
                projects={projects}
                digests={library.digests}
                activeProjectId={library.activeProjectId}
                actions={projectActions}
                onCreate={createProject}
                onImport={requestImport}
              />
            ) : tab === "history" ? (
              <HomeHistorySection
                works={library.works}
                loading={library.worksLoading}
                onOpenWork={openWork}
                onStartCreating={() => navigate("home")}
              />
            ) : tab === "assets" ? (
              <HomeAssetsSection
                assets={library.assets}
                error={library.assetsError}
                onOpenWork={openWork}
                onUsePrompt={(prompt) => fillComposer(prompt)}
                onOpenCanvas={openCanvas}
              />
            ) : tab === "skills" ? (
              <HomeSkillsSection />
            ) : (
              <HomeTemplatesSection
                onUse={(template) => fillComposer(template.prompt, template.modality)}
                onOpenWorkbench={templateWorkbench}
              />
            )}
          </div>
        </main>
      </div>

      <input
        ref={importInputRef}
        type="file"
        hidden
        accept="application/json,.json,.weftcanvas,application/zip,.zip"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (!file) return;
          void importProjectFile(file).then((imported) => {
            refreshProjects();
            if (imported) navigate("projects");
          });
        }}
      />

      {preview ? (
        <HomeWorkPreview
          works={preview.list}
          index={preview.index}
          onIndexChange={(index) =>
            setPreview((current) => (current ? { ...current, index } : null))
          }
          onClose={() => setPreview(null)}
          onReusePrompt={(work) => {
            setPreview(null);
            fillComposer(work.prompt, work.kind);
          }}
          onOpenProject={openProject}
        />
      ) : null}

      {paletteOpen ? (
        <HomeCommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      ) : null}
    </section>
  );
}
