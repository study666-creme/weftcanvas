import { memo, useMemo, useState } from "react";
import { History, Image as ImageIcon, Music2, Search, Sparkles, Video } from "lucide-react";

import {
  filterWorks,
  formatRelativeTime,
  groupWorksByDate,
  type HomeWork,
  type WorkFilter,
} from "../../lib/home-data";
import { HomeMediaThumb } from "./home-media-thumb";

export const WORK_FILTERS: { value: WorkFilter; label: string; icon?: typeof ImageIcon }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片", icon: ImageIcon },
  { value: "video", label: "视频", icon: Video },
  { value: "audio", label: "音频", icon: Music2 },
];

function originLabel(work: HomeWork) {
  if (work.origin.type === "project") return work.origin.projectName;
  if (work.origin.type === "workbench") return "生成工作台";
  return "资产库";
}

export const WorkCard = memo(function WorkCard({
  work,
  onOpen,
}: {
  work: HomeWork;
  onOpen: (work: HomeWork) => void;
}) {
  const title = work.prompt || work.media.name;
  return (
    <button
      type="button"
      className={`wc-home-work is-${work.kind}`}
      onClick={() => onOpen(work)}
      aria-label={`预览作品：${title}`}
    >
      <span className="wc-home-work-media">
        <HomeMediaThumb media={work.media} kind={work.kind} alt={title} />
      </span>
      <span className="wc-home-work-caption">
        <span className="wc-home-work-title" title={title}>
          {title}
        </span>
        <span className="wc-home-work-meta">
          <span className="wc-home-work-origin">{originLabel(work)}</span>
          <span aria-hidden="true">·</span>
          <span>{formatRelativeTime(work.createdAt)}</span>
        </span>
      </span>
    </button>
  );
});

export function WorkFilterTabs({
  value,
  onChange,
  counts,
}: {
  value: WorkFilter;
  onChange: (value: WorkFilter) => void;
  counts?: Partial<Record<WorkFilter, number>>;
}) {
  return (
    <div className="wc-home-segmented is-text" role="tablist" aria-label="作品类型">
      {WORK_FILTERS.map(({ value: option, label }) => (
        <button
          key={option}
          type="button"
          role="tab"
          aria-selected={value === option}
          className={value === option ? "is-active" : undefined}
          onClick={() => onChange(option)}
        >
          {label}
          {counts?.[option] ? <span className="wc-home-count">{counts[option]}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function countWorks(works: readonly HomeWork[]) {
  const counts: Record<WorkFilter, number> = { all: works.length, image: 0, video: 0, audio: 0 };
  for (const work of works) counts[work.kind] += 1;
  return counts;
}

/** 作品骨架：解析项目摘要期间占位，避免整块区域先空再跳出。 */
export function WorkSkeletons({ count = 6 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <span key={index} className="wc-home-work is-skeleton" aria-hidden="true">
          <span className="wc-home-work-media" />
          <span className="wc-home-work-caption">
            <span className="wc-home-skeleton-line" />
            <span className="wc-home-skeleton-line is-short" />
          </span>
        </span>
      ))}
    </>
  );
}

export function HomeHistorySection({
  works,
  loading,
  onOpenWork,
  onStartCreating,
}: {
  works: HomeWork[];
  loading: boolean;
  onOpenWork: (work: HomeWork, list: HomeWork[]) => void;
  onStartCreating: () => void;
}) {
  const [filter, setFilter] = useState<WorkFilter>("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => countWorks(works), [works]);
  const visible = useMemo(() => filterWorks(works, filter, query), [filter, query, works]);
  const groups = useMemo(() => groupWorksByDate(visible), [visible]);

  return (
    <section className="wc-home-section wc-home-page" aria-labelledby="wc-home-history-title">
      <header className="wc-home-page-head">
        <div>
          <h1 id="wc-home-history-title">创作历史</h1>
          <p>
            汇总每个画布项目、生成工作台与资产库里生成过的作品
            {works.length ? ` · 共 ${works.length} 件` : ""}
          </p>
        </div>
      </header>

      <div className="wc-home-toolbar">
        <WorkFilterTabs value={filter} onChange={setFilter} counts={counts} />
        <label className="wc-home-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="搜索提示词、模型或项目"
            aria-label="搜索作品"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {groups.length ? (
        groups.map((group) => (
          <section key={group.bucket} className="wc-home-history-group" aria-label={group.label}>
            <h2 className="wc-home-group-title">
              {group.label}
              <span className="wc-home-count">{group.works.length}</span>
            </h2>
            <div className="wc-home-works">
              {group.works.map((work) => (
                <WorkCard key={work.key} work={work} onOpen={(item) => onOpenWork(item, visible)} />
              ))}
            </div>
          </section>
        ))
      ) : loading ? (
        <div className="wc-home-works">
          <WorkSkeletons count={8} />
        </div>
      ) : works.length ? (
        <div className="wc-home-empty">
          <Search aria-hidden="true" />
          <strong>没有符合条件的作品</strong>
          <p>换个类型或关键词试试。</p>
          <button
            type="button"
            className="wc-home-button"
            onClick={() => {
              setFilter("all");
              setQuery("");
            }}
          >
            查看全部作品
          </button>
        </div>
      ) : (
        <div className="wc-home-empty">
          <History aria-hidden="true" />
          <strong>还没有生成过作品</strong>
          <p>在首页输入一句描述，或在画布节点里生成，完成的作品会自动出现在这里。</p>
          <button type="button" className="wc-home-button is-primary" onClick={onStartCreating}>
            <Sparkles aria-hidden="true" />
            <span>开始创作</span>
          </button>
        </div>
      )}
    </section>
  );
}
