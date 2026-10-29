import { useState } from "react";
import { ArrowUpRight, Image as ImageIcon, Music2, Video } from "lucide-react";

import {
  HOME_TEMPLATE_CATEGORIES,
  templatesForCategory,
  type HomeTemplate,
  type HomeTemplateCategory,
} from "../../lib/home-templates";

const MODALITY_META = {
  image: { label: "图片", icon: ImageIcon },
  video: { label: "视频", icon: Video },
  audio: { label: "音频", icon: Music2 },
} as const;

export function TemplateCard({
  template,
  onUse,
  onOpenWorkbench,
}: {
  template: HomeTemplate;
  onUse: (template: HomeTemplate) => void;
  onOpenWorkbench: (template: HomeTemplate) => void;
}) {
  const meta = MODALITY_META[template.modality];
  const Icon = meta.icon;
  return (
    <article className={`wc-home-template is-${template.modality}`}>
      <button
        type="button"
        className="wc-home-template-hit"
        aria-label={`使用模板：${template.title}`}
        onClick={() => onUse(template)}
      />
      <header>
        <span className="wc-home-template-icon" aria-hidden="true">
          <Icon />
        </span>
        <strong>{template.title}</strong>
      </header>
      <p>{template.prompt}</p>
      <footer>
        <span className="wc-home-pill">{meta.label}</span>
        {template.ratio ? <span className="wc-home-pill is-quiet">{template.ratio}</span> : null}
        <button
          type="button"
          className="wc-home-template-direct"
          aria-label={`在工作台中打开模板：${template.title}`}
          title="直接去工作台生成"
          onClick={() => onOpenWorkbench(template)}
        >
          <ArrowUpRight aria-hidden="true" />
        </button>
      </footer>
    </article>
  );
}

export function HomeTemplatesSection({
  onUse,
  onOpenWorkbench,
}: {
  onUse: (template: HomeTemplate) => void;
  onOpenWorkbench: (template: HomeTemplate) => void;
}) {
  const [category, setCategory] = useState<HomeTemplateCategory | "all">("all");
  const templates = templatesForCategory(category);
  return (
    <section className="wc-home-section wc-home-page" aria-labelledby="wc-home-templates-title">
      <header className="wc-home-page-head">
        <div>
          <h1 id="wc-home-templates-title">灵感模板</h1>
          <p>写好的起手提示词，点一下填入生成框，再按自己的想法改。</p>
        </div>
      </header>
      <div className="wc-home-toolbar">
        <div className="wc-home-segmented is-text is-scroll" role="tablist" aria-label="模板分类">
          {[{ id: "all" as const, label: "全部" }, ...HOME_TEMPLATE_CATEGORIES].map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={category === item.id}
              className={category === item.id ? "is-active" : undefined}
              onClick={() => setCategory(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="wc-home-templates">
        {templates.map((template) => (
          <TemplateCard
            key={template.id}
            template={template}
            onUse={onUse}
            onOpenWorkbench={onOpenWorkbench}
          />
        ))}
      </div>
    </section>
  );
}
