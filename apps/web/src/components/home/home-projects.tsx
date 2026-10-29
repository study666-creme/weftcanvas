import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownUp,
  Copy,
  Download,
  FileUp,
  FolderOpen,
  LayoutGrid,
  List,
  MoreHorizontal,
  PenLine,
  Plus,
  Search,
  Trash2,
  Workflow,
} from "lucide-react";

import {
  formatRelativeTime,
  sortProjects,
  type ProjectDigest,
  type ProjectSort,
} from "../../lib/home-data";
import type { ProjectSummary } from "../../lib/project-summary-storage";
import { HomeMediaThumb } from "./home-media-thumb";
import {
  deleteProject,
  duplicateProject,
  exportProjectFile,
  prefetchCanvas,
  renameProject,
} from "./home-project-actions";

const VIEW_STORAGE_KEY = "weftcanvas:home:project-view:v1";
const SORT_STORAGE_KEY = "weftcanvas:home:project-sort:v1";

function readPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 偏好只是便利，写不进去不影响功能。
  }
}

export type ProjectCardActions = {
  onOpen: (projectId: string) => void;
  onChanged: () => void;
};

function ProjectCover({ digest }: { digest: ProjectDigest | undefined }) {
  const cover = digest?.cover ?? [];
  if (!digest) return <span className="wc-home-cover is-loading" aria-hidden="true" />;
  if (!cover.length)
    return (
      <span className="wc-home-cover is-empty" aria-hidden="true">
        <Workflow />
      </span>
    );
  return (
    <span className={`wc-home-cover is-${Math.min(cover.length, 3)}`} aria-hidden="true">
      {cover.slice(0, 3).map(({ media, kind }) => (
        <HomeMediaThumb
          key={media.id}
          media={media}
          kind={kind}
          hoverPlay={false}
          showBadge={false}
        />
      ))}
    </span>
  );
}

function digestSummary(digest: ProjectDigest | undefined, nodeCount: number) {
  if (!digest) return `${nodeCount} 个节点`;
  const parts: string[] = [];
  if (digest.counts.image) parts.push(`${digest.counts.image} 图`);
  if (digest.counts.video) parts.push(`${digest.counts.video} 视频`);
  if (digest.counts.audio) parts.push(`${digest.counts.audio} 音频`);
  return parts.length ? `${nodeCount} 个节点 · ${parts.join(" ")}` : `${nodeCount} 个节点`;
}

/**
 * 项目卡：点击打开；名称可就地重命名（F2 / 菜单）；「⋯」与右键菜单提供
 * 复制、导出、删除。删除走全局确认对话框，当前项目被删时由项目库自动切换。
 */
export const ProjectCard = memo(function ProjectCard({
  project,
  digest,
  active,
  layout,
  actions,
}: {
  project: ProjectSummary;
  digest: ProjectDigest | undefined;
  active: boolean;
  layout: "grid" | "list";
  actions: ProjectCardActions;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(project.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!renaming) return;
    setDraft(project.name);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }, [renaming, project.name]);

  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setMenu(null);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const commitRename = async () => {
    const name = draft.trim();
    setRenaming(false);
    if (!name || name === project.name) return;
    if (await renameProject(project.id, name)) actions.onChanged();
  };

  const openMenuAt = (x: number, y: number) => {
    const width = 196;
    const height = 220;
    setMenu({
      x: Math.min(x, window.innerWidth - width - 8),
      y: Math.min(y, window.innerHeight - height - 8),
    });
  };

  const onMenuButton = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    openMenuAt(rect.right - 196, rect.bottom + 6);
  };

  const onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    openMenuAt(event.clientX, event.clientY);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (renaming || event.target !== event.currentTarget) return;
    if (event.key === "F2") {
      event.preventDefault();
      setRenaming(true);
    } else if (event.key === "Delete") {
      event.preventDefault();
      void deleteProject(project.id, project.name).then(
        (removed) => removed && actions.onChanged(),
      );
    } else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      openMenuAt(rect.left + 16, rect.top + 40);
    }
  };

  const runMenu = (action: () => void | Promise<unknown>) => {
    setMenu(null);
    void action();
  };

  return (
    <article
      ref={cardRef}
      className={`wc-home-project is-${layout}${active ? " is-active" : ""}`}
      onContextMenu={onContextMenu}
      onPointerEnter={prefetchCanvas}
    >
      <button
        type="button"
        className="wc-home-project-hit"
        aria-label={`打开项目 ${project.name}`}
        onClick={() => actions.onOpen(project.id)}
        onFocus={prefetchCanvas}
        onKeyDown={onKeyDown}
      />
      <ProjectCover digest={digest} />
      <div className="wc-home-project-body">
        {renaming ? (
          <input
            ref={inputRef}
            className="wc-home-project-rename"
            value={draft}
            maxLength={64}
            aria-label="项目名称"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitRename();
              } else if (event.key === "Escape") {
                event.preventDefault();
                setRenaming(false);
              }
            }}
          />
        ) : (
          <strong className="wc-home-project-name" title={project.name}>
            {project.name}
          </strong>
        )}
        <small className="wc-home-project-meta">
          <span>{digestSummary(digest, project.nodeCount)}</span>
          <span aria-hidden="true">·</span>
          <time dateTime={new Date(project.updatedAt).toISOString()}>
            {formatRelativeTime(project.updatedAt)}
          </time>
        </small>
      </div>
      {active ? <span className="wc-home-project-badge">当前</span> : null}
      <button
        type="button"
        className="wc-home-project-more"
        aria-label={`项目操作 ${project.name}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(menu)}
        onClick={onMenuButton}
      >
        <MoreHorizontal aria-hidden="true" />
      </button>
      {menu
        ? createPortal(
            <div
              ref={menuRef}
              className="wc-home-menu"
              role="menu"
              aria-label={`项目操作 ${project.name}`}
              style={{ left: menu.x, top: menu.y }}
              onKeyDown={(event) => {
                const items = [
                  ...(menuRef.current?.querySelectorAll<HTMLButtonElement>(
                    "button[role='menuitem']",
                  ) ?? []),
                ];
                const current = items.indexOf(document.activeElement as HTMLButtonElement);
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  items[(current + 1) % items.length]?.focus();
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  items[(current - 1 + items.length) % items.length]?.focus();
                }
              }}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => runMenu(() => actions.onOpen(project.id))}
              >
                <FolderOpen aria-hidden="true" />
                打开
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runMenu(() => setRenaming(true))}
              >
                <PenLine aria-hidden="true" />
                重命名
                <kbd>F2</kbd>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() =>
                  runMenu(async () => {
                    if (await duplicateProject(project.id)) actions.onChanged();
                  })
                }
              >
                <Copy aria-hidden="true" />
                创建副本
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => runMenu(() => exportProjectFile(project.id))}
              >
                <Download aria-hidden="true" />
                导出项目文件
              </button>
              <span className="wc-home-menu-divider" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() =>
                  runMenu(async () => {
                    if (await deleteProject(project.id, project.name)) actions.onChanged();
                  })
                }
              >
                <Trash2 aria-hidden="true" />
                删除
                <kbd>Del</kbd>
              </button>
            </div>,
            // 菜单挂到主页根节点：卡片悬停时的位移会让 fixed 定位以卡片为参照并被裁切。
            cardRef.current?.closest(".wc-home") ?? document.body,
          )
        : null}
    </article>
  );
});

export function NewProjectCard({
  onCreate,
  layout = "grid",
}: {
  onCreate: () => void;
  layout?: "grid" | "list";
}) {
  return (
    <button
      type="button"
      className={`wc-home-project-new is-${layout}`}
      onClick={onCreate}
      onPointerEnter={prefetchCanvas}
    >
      <span className="wc-home-project-new-icon" aria-hidden="true">
        <Plus />
      </span>
      <span>
        <strong>新建画布</strong>
        <small>从一张空白画布开始</small>
      </span>
    </button>
  );
}

const SORT_LABELS: Record<ProjectSort, string> = {
  updated: "最近编辑",
  created: "创建时间",
  name: "名称",
};

export function HomeProjectsSection({
  projects,
  digests,
  activeProjectId,
  actions,
  onCreate,
  onImport,
}: {
  projects: ProjectSummary[];
  digests: ReadonlyMap<string, ProjectDigest>;
  activeProjectId: string | null;
  actions: ProjectCardActions;
  onCreate: () => void;
  onImport: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<ProjectSort>(() =>
    readPreference(SORT_STORAGE_KEY, ["updated", "created", "name"] as const, "updated"),
  );
  const [layout, setLayout] = useState<"grid" | "list">(() =>
    readPreference(VIEW_STORAGE_KEY, ["grid", "list"] as const, "grid"),
  );
  const visible = useMemo(() => sortProjects(projects, sort, query), [projects, query, sort]);

  return (
    <section className="wc-home-section wc-home-page" aria-labelledby="wc-home-projects-title">
      <header className="wc-home-page-head">
        <div>
          <h1 id="wc-home-projects-title">我的项目</h1>
          <p>
            {projects.length
              ? `共 ${projects.length} 个本地项目，保存在这个浏览器中`
              : "项目保存在这个浏览器中，无需登录即可开始"}
          </p>
        </div>
        <div className="wc-home-page-actions">
          <button type="button" className="wc-home-button" onClick={onImport}>
            <FileUp aria-hidden="true" />
            <span>导入项目</span>
          </button>
          <button type="button" className="wc-home-button is-primary" onClick={onCreate}>
            <Plus aria-hidden="true" />
            <span>新建画布</span>
          </button>
        </div>
      </header>

      <div className="wc-home-toolbar">
        <label className="wc-home-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="搜索项目名称"
            aria-label="搜索项目"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <label className="wc-home-select" title="排序方式">
          <ArrowDownUp aria-hidden="true" />
          <select
            value={sort}
            aria-label="排序方式"
            onChange={(event) => {
              const next = event.target.value as ProjectSort;
              setSort(next);
              writePreference(SORT_STORAGE_KEY, next);
            }}
          >
            {(Object.keys(SORT_LABELS) as ProjectSort[]).map((value) => (
              <option key={value} value={value}>
                {SORT_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <div className="wc-home-segmented" role="radiogroup" aria-label="项目视图">
          {(
            [
              ["grid", LayoutGrid, "网格"],
              ["list", List, "列表"],
            ] as const
          ).map(([value, Icon, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={layout === value}
              aria-label={`${label}视图`}
              title={`${label}视图`}
              className={layout === value ? "is-active" : undefined}
              onClick={() => {
                setLayout(value);
                writePreference(VIEW_STORAGE_KEY, value);
              }}
            >
              <Icon aria-hidden="true" />
            </button>
          ))}
        </div>
      </div>

      {visible.length ? (
        <div className={`wc-home-projects is-${layout}`} role="list" aria-label="项目列表">
          {!query ? (
            <div role="listitem">
              <NewProjectCard onCreate={onCreate} layout={layout} />
            </div>
          ) : null}
          {visible.map((project) => (
            <div key={project.id} role="listitem">
              <ProjectCard
                project={project}
                digest={digests.get(project.id)}
                active={project.id === activeProjectId}
                layout={layout}
                actions={actions}
              />
            </div>
          ))}
        </div>
      ) : query ? (
        <div className="wc-home-empty">
          <Search aria-hidden="true" />
          <strong>没有找到「{query}」</strong>
          <p>换个关键词试试，或清空搜索查看全部项目。</p>
          <button type="button" className="wc-home-button" onClick={() => setQuery("")}>
            清空搜索
          </button>
        </div>
      ) : (
        <div className="wc-home-empty">
          <Workflow aria-hidden="true" />
          <strong>还没有项目</strong>
          <p>新建一张画布，或导入之前导出的项目文件 / 完整备份。</p>
          <div className="wc-home-empty-actions">
            <button type="button" className="wc-home-button is-primary" onClick={onCreate}>
              <Plus aria-hidden="true" />
              <span>新建画布</span>
            </button>
            <button type="button" className="wc-home-button" onClick={onImport}>
              <FileUp aria-hidden="true" />
              <span>导入项目</span>
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
