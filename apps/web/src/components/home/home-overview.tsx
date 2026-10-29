import { forwardRef, useMemo, useState, type ReactNode } from "react";
import {
  ArrowRight,
  FileUp,
  Image as ImageIcon,
  Music2,
  Plus,
  Video,
  type LucideIcon,
} from "lucide-react";

import {
  filterWorks,
  greetingFor,
  type HomeWork,
  type ProjectDigest,
  type WorkFilter,
} from "../../lib/home-data";
import { HOME_TEMPLATES, type HomeTemplate } from "../../lib/home-templates";
import type { ProjectSummary } from "../../lib/project-summary-storage";
import { HomeComposer, type HomeComposerHandle } from "./home-composer";
import { WorkCard, WorkFilterTabs, WorkSkeletons, countWorks } from "./home-history";
import { NewProjectCard, ProjectCard, type ProjectCardActions } from "./home-projects";
import { TemplateCard } from "./home-templates-section";
import type { HomeTab } from "./home-sidebar";

const INSPIRATIONS = [
  "赛博朋克城市夜景",
  "水彩风格的猫",
  "极简产品摄影",
  "敦煌飞天壁画",
  "微距露珠世界",
];

type QuickAction = {
  id: string;
  title: string;
  body: string;
  icon: LucideIcon;
  tone: "neutral" | "image" | "video" | "audio";
  href?: string;
};

const QUICK_ACTIONS: QuickAction[] = [
  { id: "canvas", title: "新建画布", body: "在无限画布上编排节点", icon: Plus, tone: "neutral" },
  {
    id: "image",
    title: "图片生成",
    body: "一句描述生成画面",
    icon: ImageIcon,
    tone: "image",
    href: "/generate/image",
  },
  {
    id: "video",
    title: "视频生成",
    body: "文生视频与图生视频",
    icon: Video,
    tone: "video",
    href: "/generate/video",
  },
  {
    id: "audio",
    title: "音频生成",
    body: "配乐、音效与旁白",
    icon: Music2,
    tone: "audio",
    href: "/generate/audio",
  },
  { id: "import", title: "导入项目", body: "项目文件或完整备份", icon: FileUp, tone: "neutral" },
];

const RECENT_PROJECT_LIMIT = 7;
const RECENT_WORK_LIMIT = 12;

function SectionHead({
  title,
  count,
  onMore,
  moreLabel = "查看全部",
  children,
}: {
  title: string;
  count?: number;
  onMore?: () => void;
  moreLabel?: string;
  children?: ReactNode;
}) {
  return (
    <header className="wc-home-section-head">
      <h2>
        {title}
        {count ? <span className="wc-home-count">{count}</span> : null}
      </h2>
      {children}
      {onMore ? (
        <button type="button" className="wc-home-link" onClick={onMore}>
          {moreLabel}
          <ArrowRight aria-hidden="true" />
        </button>
      ) : null}
    </header>
  );
}

export const HomeOverview = forwardRef<
  HomeComposerHandle,
  {
    displayName: string | null;
    projects: ProjectSummary[];
    digests: ReadonlyMap<string, ProjectDigest>;
    activeProjectId: string | null;
    works: HomeWork[];
    worksLoading: boolean;
    projectActions: ProjectCardActions;
    onCreateProject: () => void;
    onImportProject: () => void;
    onNavigate: (tab: HomeTab) => void;
    onOpenWork: (work: HomeWork, list: HomeWork[]) => void;
    onUseTemplate: (template: HomeTemplate) => void;
    onTemplateWorkbench: (template: HomeTemplate) => void;
    onInspiration: (idea: string) => void;
    /** 窄屏时新手教程「去工作台」的锚点挂在这里的生成卡上。 */
    tourAnchors?: boolean;
  }
>(function HomeOverview(
  {
    displayName,
    projects,
    digests,
    activeProjectId,
    works,
    worksLoading,
    projectActions,
    onCreateProject,
    onImportProject,
    onNavigate,
    onOpenWork,
    onUseTemplate,
    onTemplateWorkbench,
    onInspiration,
    tourAnchors = false,
  },
  composerRef,
) {
  const [workFilter, setWorkFilter] = useState<WorkFilter>("all");
  const counts = useMemo(() => countWorks(works), [works]);
  const recentWorks = useMemo(
    () => filterWorks(works, workFilter).slice(0, RECENT_WORK_LIMIT),
    [workFilter, works],
  );
  const recentProjects = projects.slice(0, RECENT_PROJECT_LIMIT);
  const featuredTemplates = useMemo(
    () =>
      ["poster-film", "product-cosmetic", "character-sheet", "storyboard-push"].flatMap(
        (id) => HOME_TEMPLATES.find((template) => template.id === id) ?? [],
      ),
    [],
  );

  return (
    <div className="wc-home-overview">
      <section className="wc-home-hero" aria-labelledby="wc-home-greeting">
        <h1 id="wc-home-greeting">
          {greetingFor()}
          {displayName ? `，${displayName}` : ""}
        </h1>
        <p>今天想创作什么？写一句描述，或者继续上次的画布。</p>
        <HomeComposer ref={composerRef} />
        <div className="wc-home-inspirations" aria-label="灵感提示">
          <span>试试</span>
          {INSPIRATIONS.map((idea) => (
            <button key={idea} type="button" onClick={() => onInspiration(idea)}>
              {idea}
            </button>
          ))}
        </div>
      </section>

      <section className="wc-home-section" aria-label="快速开始">
        <div className="wc-home-quick">
          {QUICK_ACTIONS.map(({ id, title, body, icon: Icon, tone, href }) => {
            const content = (
              <>
                <span className={`wc-home-quick-icon is-${tone}`} aria-hidden="true">
                  <Icon />
                </span>
                <span className="wc-home-quick-copy">
                  <strong>{title}</strong>
                  <small>{body}</small>
                </span>
              </>
            );
            return href ? (
              <a
                key={id}
                className="wc-home-quick-item"
                href={href}
                data-wc-tour={tourAnchors ? "goto-workbench" : undefined}
              >
                {content}
              </a>
            ) : (
              <button
                key={id}
                type="button"
                className="wc-home-quick-item"
                onClick={id === "canvas" ? onCreateProject : onImportProject}
              >
                {content}
              </button>
            );
          })}
        </div>
      </section>

      <section className="wc-home-section" aria-label="选择要进入的项目">
        <SectionHead
          title="最近项目"
          count={projects.length}
          onMore={projects.length ? () => onNavigate("projects") : undefined}
        />
        <div className="wc-home-projects is-grid is-overview" role="list">
          <div role="listitem">
            <NewProjectCard onCreate={onCreateProject} />
          </div>
          {recentProjects.map((project) => (
            <div key={project.id} role="listitem">
              <ProjectCard
                project={project}
                digest={digests.get(project.id)}
                active={project.id === activeProjectId}
                layout="grid"
                actions={projectActions}
              />
            </div>
          ))}
        </div>
      </section>

      <section className="wc-home-section" aria-label="最近作品">
        <SectionHead
          title="创作历史"
          count={works.length}
          onMore={works.length ? () => onNavigate("history") : undefined}
        >
          {works.length ? (
            <WorkFilterTabs value={workFilter} onChange={setWorkFilter} counts={counts} />
          ) : null}
        </SectionHead>
        {recentWorks.length ? (
          <div className="wc-home-works is-strip">
            {recentWorks.map((work) => (
              <WorkCard
                key={work.key}
                work={work}
                onOpen={(item) => onOpenWork(item, recentWorks)}
              />
            ))}
          </div>
        ) : worksLoading ? (
          <div className="wc-home-works is-strip">
            <WorkSkeletons count={6} />
          </div>
        ) : (
          <p className="wc-home-hint">
            {works.length
              ? "这个类型下还没有作品。"
              : "生成完成的图片、视频和音频会自动汇总到这里，点开即可预览、下载或复用提示词。"}
          </p>
        )}
      </section>

      <section className="wc-home-section" aria-label="灵感模板">
        <SectionHead title="灵感模板" onMore={() => onNavigate("templates")} moreLabel="更多模板" />
        <div className="wc-home-templates is-compact">
          {featuredTemplates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onUse={onUseTemplate}
              onOpenWorkbench={onTemplateWorkbench}
            />
          ))}
        </div>
      </section>
    </div>
  );
});
