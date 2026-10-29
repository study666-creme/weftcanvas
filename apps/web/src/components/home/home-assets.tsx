import { useMemo, useState } from "react";
import { Copy, FolderOpen, Library, Quote, Search, Sparkles } from "lucide-react";

import type { AssetLibraryItem, AssetLibraryKind } from "../../lib/asset-library-store";
import { formatRelativeTime, mediaKindOf, type HomeWork } from "../../lib/home-data";
import { useToastStore } from "../../state/toast-store";
import { HomeMediaThumb } from "./home-media-thumb";

type AssetFilter = "all" | AssetLibraryKind;

const FILTERS: { value: AssetFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
  { value: "card", label: "卡片" },
  { value: "prompt", label: "提示词" },
];

const SOURCE_LABEL: Record<AssetLibraryItem["source"], string> = {
  "card-library": "卡片库收藏",
  local: "本地上传",
  canvas: "生成作品",
};

export function assetToWork(item: AssetLibraryItem): HomeWork | null {
  if (!item.media) return null;
  const kind = mediaKindOf(item.media);
  if (!kind) return null;
  return {
    key: item.media.id,
    kind,
    media: item.media,
    prompt: item.prompt.trim(),
    model: null,
    createdAt: item.createdAt,
    origin: { type: "library", assetId: item.id },
  };
}

/**
 * 资产库浏览：与画布底部「卡片与资产」抽屉读同一份本地资产库。主页只做浏览与
 * 复用（预览 / 复制提示词 / 带着提示词去创作）；分类整理与拖入画布仍在画布里完成。
 */
export function HomeAssetsSection({
  assets,
  error,
  onOpenWork,
  onUsePrompt,
  onOpenCanvas,
}: {
  assets: AssetLibraryItem[] | null;
  error: boolean;
  onOpenWork: (work: HomeWork, list: HomeWork[]) => void;
  onUsePrompt: (prompt: string) => void;
  onOpenCanvas: () => void;
}) {
  const [filter, setFilter] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const result: Partial<Record<AssetFilter, number>> = { all: assets?.length ?? 0 };
    for (const item of assets ?? []) result[item.kind] = (result[item.kind] ?? 0) + 1;
    return result;
  }, [assets]);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return (assets ?? []).filter(
      (item) =>
        (filter === "all" || item.kind === filter) &&
        (!needle || `${item.name} ${item.prompt}`.toLocaleLowerCase("zh-CN").includes(needle)),
    );
  }, [assets, filter, query]);
  const mediaWorks = useMemo(() => visible.flatMap((item) => assetToWork(item) ?? []), [visible]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      useToastStore.getState().show("提示词已复制", "success");
    } catch {
      useToastStore.getState().show("无法访问剪贴板，请手动选择复制", "error");
    }
  };

  return (
    <section className="wc-home-section wc-home-page" aria-labelledby="wc-home-assets-title">
      <header className="wc-home-page-head">
        <div>
          <h1 id="wc-home-assets-title">资产库</h1>
          <p>
            保存在这个浏览器里的素材、卡片与提示词
            {assets?.length ? ` · 共 ${assets.length} 项` : ""}
          </p>
        </div>
        <div className="wc-home-page-actions">
          <button type="button" className="wc-home-button" onClick={onOpenCanvas}>
            <FolderOpen aria-hidden="true" />
            <span>在画布中整理</span>
          </button>
        </div>
      </header>

      <div className="wc-home-toolbar">
        <div className="wc-home-segmented is-text" role="tablist" aria-label="资产类型">
          {FILTERS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              className={filter === value ? "is-active" : undefined}
              onClick={() => setFilter(value)}
            >
              {label}
              {counts[value] ? <span className="wc-home-count">{counts[value]}</span> : null}
            </button>
          ))}
        </div>
        <label className="wc-home-search">
          <Search aria-hidden="true" />
          <input
            type="search"
            value={query}
            placeholder="搜索名称或提示词"
            aria-label="搜索资产"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      {assets === null ? (
        <div className="wc-home-works">
          {Array.from({ length: 8 }, (_, index) => (
            <span key={index} className="wc-home-work is-skeleton" aria-hidden="true">
              <span className="wc-home-work-media" />
              <span className="wc-home-work-caption">
                <span className="wc-home-skeleton-line" />
              </span>
            </span>
          ))}
        </div>
      ) : visible.length ? (
        <div className="wc-home-works" role="list" aria-label="资产列表">
          {visible.map((item) => {
            const work = assetToWork(item);
            if (work) {
              return (
                <div role="listitem" key={item.id}>
                  <button
                    type="button"
                    className={`wc-home-work is-${work.kind}`}
                    aria-label={`预览资产：${item.name}`}
                    onClick={() => onOpenWork(work, mediaWorks)}
                  >
                    <span className="wc-home-work-media">
                      <HomeMediaThumb media={work.media} kind={work.kind} alt={item.name} />
                    </span>
                    <span className="wc-home-work-caption">
                      <span className="wc-home-work-title" title={item.name}>
                        {item.name}
                      </span>
                      <span className="wc-home-work-meta">
                        <span>{SOURCE_LABEL[item.source]}</span>
                        <span aria-hidden="true">·</span>
                        <span>{formatRelativeTime(item.updatedAt)}</span>
                      </span>
                    </span>
                  </button>
                </div>
              );
            }
            return (
              <div role="listitem" key={item.id}>
                <article className="wc-home-work is-text">
                  <span className="wc-home-work-media wc-home-prompt-card">
                    <Quote aria-hidden="true" />
                    <span>{item.prompt || item.name}</span>
                  </span>
                  <span className="wc-home-work-caption">
                    <span className="wc-home-work-title" title={item.name}>
                      {item.name}
                    </span>
                    <span className="wc-home-work-actions">
                      <button
                        type="button"
                        className="wc-home-icon-button"
                        aria-label={`复制提示词 ${item.name}`}
                        title="复制提示词"
                        disabled={!item.prompt}
                        onClick={() => void copy(item.prompt)}
                      >
                        <Copy aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="wc-home-icon-button"
                        aria-label={`用提示词创作 ${item.name}`}
                        title="填入生成框"
                        disabled={!item.prompt}
                        onClick={() => onUsePrompt(item.prompt)}
                      >
                        <Sparkles aria-hidden="true" />
                      </button>
                    </span>
                  </span>
                </article>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="wc-home-empty">
          <Library aria-hidden="true" />
          <strong>
            {error ? "资产库暂时无法读取" : assets.length ? "没有符合条件的资产" : "资产库还是空的"}
          </strong>
          <p>
            {error
              ? "浏览器可能禁用了本地存储（例如无痕模式），请检查站点数据权限。"
              : assets.length
                ? "换个类型或关键词试试。"
                : "生成完成的作品、上传的素材和收藏的卡片都会自动进入资产库。"}
          </p>
        </div>
      )}
    </section>
  );
}
