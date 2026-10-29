import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CircleUserRound,
  ExternalLink,
  FolderOpen,
  Image as ImageIcon,
  ImagePlus,
  Library,
  Moon,
  Music2,
  Plus,
  Sparkles,
  Sun,
  Video,
  X,
} from "lucide-react";

import canvasWidePreview from "../assets/product-canvas-wide-1600.jpg";
import { DIRECT_COMPOSER_PROMPT_MAX, useDirectComposer } from "../hooks/use-direct-composer";
import {
  ACTIVE_PROJECT_STORAGE_KEY,
  readProjectSummaryIndex,
} from "../lib/project-summary-storage";
import { WEFTCANVAS_API_SITE_URL } from "../lib/custom-api";

/** 卡片库站点由部署注入（custom-api 的 VITE_WEFTCANVAS_API_BASE_URL）；为空不渲染外链。 */
const CARD_LIBRARY_SITE_URL = WEFTCANVAS_API_SITE_URL;
import { useIdentityStore } from "../state/identity-store";
import type { DirectModality } from "./direct-generation-studio";
import { CategorizedModelSelect } from "./categorized-model-select";
import { GenerationParameterField } from "./generation-parameter-field";

const MODES: { value: DirectModality; label: string; icon: typeof ImageIcon }[] = [
  { value: "image", label: "图片生成", icon: ImageIcon },
  { value: "video", label: "视频生成", icon: Video },
  { value: "audio", label: "音频生成", icon: Music2 },
];

const INSPIRATIONS: Record<DirectModality, string[]> = {
  image: ["赛博朋克城市夜景", "水彩风格的猫", "极简产品摄影", "敦煌飞天壁画", "微距露珠世界"],
  video: ["延时摄影的云海", "雨滴滑落的玻璃窗", "霓虹街道夜行", "篝火旁的星空", "樱花飘落的瞬间"],
  audio: [
    "轻快的钢琴背景音乐",
    "温暖的深夜电台女声开场白",
    "史诗管弦乐战斗主题曲",
    "自然友好的中文产品讲解语音",
    "Lo-fi 学习节奏",
  ],
};

const SHOWCASE: { tone: string; kind: "image" | "video"; prompt: string; span?: boolean }[] = [
  {
    tone: "var(--entry-showcase-1)",
    kind: "image",
    prompt: "雨夜霓虹街道，电影感反光",
    span: true,
  },
  { tone: "var(--entry-showcase-2)", kind: "image", prompt: "赛博朋克城市夜景" },
  { tone: "var(--entry-showcase-3)", kind: "video", prompt: "云海延时，光线流动" },
  { tone: "var(--entry-showcase-4)", kind: "image", prompt: "极简产品摄影" },
  { tone: "var(--entry-showcase-5)", kind: "image", prompt: "水彩风格的猫" },
];

const CAPABILITIES: { icon: typeof ImageIcon; title: string; body: string }[] = [
  { icon: ImageIcon, title: "图片生成", body: "一句话生成可直接使用的画面，多模型与比例可调。" },
  { icon: Video, title: "视频生成", body: "把想法变成有镜头感的动态片段，时长与运动可控。" },
  { icon: Library, title: "画布编排", body: "把生成的资产放进画布，与文本、参考自由连接。" },
];

const HERO_CHIPS: { label: string; tone: "jade" | "blue" | "coral" }[] = [
  { label: "图片生成", tone: "jade" },
  { label: "视频生成", tone: "blue" },
  { label: "画布编排", tone: "coral" },
  { label: "多模型路由", tone: "jade" },
  { label: "参考图驱动", tone: "blue" },
];

export function EntryGate({
  onEnter,
  theme,
  onToggleTheme,
}: {
  onEnter: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const heroRef = useRef<HTMLElement>(null);
  const [projects] = useState(readProjectSummaryIndex);
  const activeProjectId = readActiveProjectId();
  const identityStatus = useIdentityStore((state) => state.status);
  const identitySession = useIdentityStore((state) => state.session);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const recentProjects = projects.slice(0, 3);

  // 生成框的状态与行为与工作台式主页共用（模式 / 模型 / 参数 / 参考素材 / @ 引用 / 提交）。
  const composer = useDirectComposer();
  const {
    mode,
    changeMode,
    prompt,
    updatePrompt,
    promptRef,
    fileInputRef,
    mentionRange,
    mentionIndex,
    visibleMentionCandidates,
    chooseMention,
    mentionReference,
    references,
    removeReference,
    dragActive,
    uploadError,
    models,
    model,
    setModelId,
    parameters,
    setParameter,
    editableParameters,
    materialControls,
    acceptedMimes,
    goGenerate,
    submit,
  } = composer;
  const inspirations = useMemo(() => INSPIRATIONS[mode], [mode]);

  const enterProject = async (projectId: string) => {
    const { useProjectLibraryStore } = await import("../state/project-library-store");
    useProjectLibraryStore.getState().switchProject(projectId);
    if (readActiveProjectId() !== projectId) return;
    onEnter();
  };

  const enterNewProject = async () => {
    const { useProjectLibraryStore } = await import("../state/project-library-store");
    useProjectLibraryStore.getState().createProject();
    onEnter();
  };

  const browseProjects = async () => {
    const { useProjectLibraryStore } = await import("../state/project-library-store");
    useProjectLibraryStore.getState().setOpen(true);
    onEnter();
  };

  useEffect(() => {
    const hero = heroRef.current;
    if (!hero || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        hero.dataset.motion = entry?.isIntersecting ? "running" : "paused";
      },
      { threshold: 0.12 },
    );
    observer.observe(hero);
    return () => observer.disconnect();
  }, []);

  // 首屏保流畅：原先的鼠标聚光/视差层已整体移除。pointermove 每帧写入 CSS 变量
  // 会让合成器持续重算 composer 的 backdrop-filter，光标与输入延迟都明显变差；
  // 上线推广场景下流畅优先于这层装饰，相关 CSS（--spot-*/--par-*）已一并停用。

  return (
    <section className="wc-entry-gate" aria-label="纬线入口">
      <div className="wc-entry-showcase">
        <header className="wc-entry-nav" aria-label="主页导航">
          <a className="wc-entry-brand" href="/" aria-label="返回纬线主页">
            <span className="wc-entry-brand-mark">
              <img src="/weftcanvas-logo-ui.webp" alt="" aria-hidden="true" />
            </span>
            <span>
              <strong>纬线</strong>
              <small>Weftcanvas</small>
            </span>
          </a>
          <nav aria-label="主页分区">
            {/* 新手教程第一步（去简易工作台）的锚点：三个生成入口都挂上，
                教程环只套第一个命中的「图片生成」，文案里说明旁边的入口同样可行。 */}
            <a href="/generate/image" data-wc-tour="goto-workbench">
              <ImageIcon aria-hidden="true" />
              图片生成
            </a>
            <a href="/generate/video" data-wc-tour="goto-workbench">
              <Video aria-hidden="true" />
              视频生成
            </a>
            <a href="/generate/audio" data-wc-tour="goto-workbench">
              <Music2 aria-hidden="true" />
              音频生成
            </a>
            <a href="/canvas">创作画布</a>
            {CARD_LIBRARY_SITE_URL ? (
              <a href={CARD_LIBRARY_SITE_URL} target="_blank" rel="noreferrer">
                卡片库
              </a>
            ) : null}
          </nav>
          <div className="wc-entry-nav-actions">
            <button
              type="button"
              className="wc-entry-theme-action"
              aria-label={theme === "light" ? "切换到深色模式" : "切换到浅色模式"}
              title={theme === "light" ? "深色模式" : "浅色模式"}
              onClick={onToggleTheme}
            >
              {theme === "light" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="wc-entry-account-action"
              aria-label={
                identitySession ? `账号：${identitySession.user.displayName}` : "登录画布账号"
              }
              onClick={() => openAccount("login")}
            >
              <CircleUserRound aria-hidden="true" />
              <span>{identitySession?.user.displayName ?? "登录"}</span>
            </button>
            <button type="button" onClick={onEnter}>
              打开画布
              <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </header>

        <main>
          <section ref={heroRef} className="wc-entry-hero" aria-label="AI 生成入口">
            <div className="wc-entry-hero-media-stage" aria-hidden="true">
              <img
                className="wc-entry-hero-media"
                src={canvasWidePreview}
                alt=""
                width={3102}
                height={1685}
                decoding="async"
                fetchPriority="low"
              />
              <span className="wc-entry-hero-grid" aria-hidden="true" />
              <span className="wc-entry-hero-stars" aria-hidden="true" />
              <span className="wc-entry-hero-glow" aria-hidden="true" />
            </div>
            <span className="wc-entry-hero-shade" aria-hidden="true" />

            <span className="wc-entry-hero-meta wc-entry-hero-meta--left" aria-hidden="true">
              IMAX-CLASS CANVAS
              <i />
              IMAGES · VIDEOS · ORCHESTRATION
            </span>
            <span className="wc-entry-hero-meta wc-entry-hero-meta--right" aria-hidden="true">
              WEFTCANVAS ENGINE
              <i />
              REALTIME · MULTI-MODEL
            </span>
            <a className="wc-entry-hero-cue" href="#capabilities" aria-label="向下滚动探索能力">
              <span>滚动探索</span>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 10l7 7 7-7" />
              </svg>
            </a>

            <div className="wc-entry-hero-copy">
              <span className="wc-entry-kicker">
                <i className="wc-entry-kicker-dot" aria-hidden="true" />
                AI CREATION STUDIO · IMAGE · VIDEO · CANVAS
              </span>
              <h1>
                <span className="wc-entry-hero-line">一句描述</span>
                <span className="wc-entry-hero-line">
                  生成<em>所有画面</em>
                </span>
              </h1>
              <p>图像与视频 AI 创作工作台 —— 选好模型与参数即刻生成，作品可落入画布继续编排。</p>

              <div className="wc-entry-chips" aria-label="核心能力">
                {HERO_CHIPS.map((chip) => (
                  <span key={chip.label} className={`wc-entry-chip is-${chip.tone}`}>
                    <i aria-hidden="true" />
                    {chip.label}
                  </span>
                ))}
              </div>

              <div className="wc-entry-composer wc-entry-composer--neutral" data-mode={mode}>
                <div className="wc-entry-composer-top">
                  <div className="wc-entry-mode-switch" role="tablist" aria-label="生成类型">
                    {MODES.map(({ value, label, icon: Icon }) => (
                      <button
                        key={value}
                        type="button"
                        role="tab"
                        aria-selected={mode === value}
                        className={mode === value ? "is-active" : undefined}
                        onClick={() => changeMode(value)}
                      >
                        <Icon aria-hidden="true" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                <div
                  className={`wc-entry-composer-body${dragActive ? " is-drag-active" : ""}`}
                  onDragOver={composer.onDragOver}
                  onDragLeave={composer.onDragLeave}
                  onDrop={composer.onDrop}
                >
                  <div className="wc-entry-prompt-wrap">
                    <textarea
                      ref={promptRef}
                      className="wc-entry-prompt"
                      rows={2}
                      maxLength={DIRECT_COMPOSER_PROMPT_MAX}
                      placeholder={
                        mode === "image"
                          ? "描述主体、环境、光线和画面气质…"
                          : "描述镜头、动作、节奏和时长感…"
                      }
                      aria-label="生成提示词"
                      value={prompt}
                      onChange={(event) =>
                        updatePrompt(
                          event.target.value,
                          event.target.selectionStart ?? event.target.value.length,
                        )
                      }
                      onKeyDown={composer.handlePromptKeyDown}
                      onPaste={composer.onPaste}
                    />
                    {mentionRange && visibleMentionCandidates.length ? (
                      <div className="wc-entry-mention-menu" role="listbox" aria-label="引用素材">
                        {visibleMentionCandidates.map((candidate, index) => (
                          <button
                            key={candidate.id}
                            type="button"
                            role="option"
                            aria-selected={index === mentionIndex}
                            className={index === mentionIndex ? "is-active" : undefined}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              chooseMention(candidate);
                            }}
                          >
                            <span className="wc-entry-mention-label">@{candidate.label}</span>
                            <span>{candidate.name}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>

                  {references.length ? (
                    <div className="wc-entry-references" aria-label="参考素材">
                      {references.map((reference) => (
                        <figure
                          key={reference.id}
                          className={`wc-entry-reference is-${reference.status} is-${reference.kind}`}
                          title={
                            reference.status === "ready"
                              ? `${reference.name}（点击引用到提示词）`
                              : (reference.error ?? reference.name)
                          }
                        >
                          <button
                            type="button"
                            className="wc-entry-reference-mention"
                            aria-label={
                              reference.status === "ready"
                                ? `引用素材 ${reference.name}`
                                : reference.name
                            }
                            disabled={reference.status !== "ready"}
                            onClick={() => mentionReference(reference)}
                          >
                            {reference.kind === "video" ? (
                              reference.previewUrl ? (
                                <video
                                  src={reference.previewUrl}
                                  muted
                                  playsInline
                                  preload="metadata"
                                />
                              ) : (
                                <Video
                                  aria-hidden="true"
                                  className="wc-entry-reference-kind-icon"
                                />
                              )
                            ) : reference.kind === "audio" ? (
                              <span className="wc-entry-reference-kind-icon" aria-hidden="true">
                                ♪
                              </span>
                            ) : reference.previewUrl ? (
                              <img src={reference.previewUrl} alt={reference.name} />
                            ) : (
                              <span className="wc-entry-reference-loading" aria-hidden="true" />
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label={`移除素材 ${reference.name}`}
                            onClick={() => removeReference(reference)}
                          >
                            <X aria-hidden="true" />
                          </button>
                          {reference.status === "uploading" ? (
                            <i className="wc-entry-reference-progress" aria-hidden="true" />
                          ) : null}
                          {reference.status === "error" ? (
                            <em className="wc-entry-reference-error" aria-hidden="true">
                              !
                            </em>
                          ) : null}
                        </figure>
                      ))}
                    </div>
                  ) : null}
                  {uploadError ? (
                    <p className="wc-entry-upload-error" role="alert">
                      {uploadError}
                    </p>
                  ) : null}

                  <div className="wc-entry-composer-foot">
                    <div className="wc-entry-foot-controls">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept={acceptedMimes || "image/*,video/*,audio/*"}
                        multiple
                        hidden
                        onChange={composer.onFileInput}
                        aria-hidden="true"
                        tabIndex={-1}
                      />
                      <button
                        type="button"
                        className="wc-entry-upload"
                        title={
                          model
                            ? `添加参考素材（支持${materialControls.map((control) => control.label.replace("素材", "")).join("、") || "图片"}，可拖拽或粘贴）`
                            : "添加参考素材"
                        }
                        aria-label="添加参考素材"
                        disabled={!model || !materialControls.length}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <ImagePlus aria-hidden="true" />
                      </button>
                      <div className="wc-entry-model">
                        <CategorizedModelSelect
                          value={model?.id ?? ""}
                          models={models}
                          onChange={setModelId}
                          ariaLabel="模型"
                        />
                      </div>
                      {editableParameters.length ? (
                        <div className="wc-entry-params" aria-label="生成参数">
                          {editableParameters.map((parameter) => (
                            <GenerationParameterField
                              key={`${model?.id ?? "model"}:${parameter.name}`}
                              parameter={parameter}
                              value={parameters[parameter.name]}
                              disabled={false}
                              boundedDuration={mode === "video"}
                              onChange={(value) => setParameter(parameter.name, value)}
                              onValidityChange={() => undefined}
                              menuClassName="wc-entry-select-menu"
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="wc-entry-generate"
                      onClick={submit}
                      disabled={!models.length}
                      aria-label={mode === "image" ? "生成图片" : "生成视频"}
                    >
                      <Sparkles aria-hidden="true" />
                      <span>{mode === "image" ? "生成图片" : "生成视频"}</span>
                    </button>
                  </div>
                </div>
              </div>

              <div className="wc-entry-inspirations" aria-label="灵感提示">
                <span className="wc-entry-inspirations-label">试试</span>
                {inspirations.map((idea) => (
                  <button key={idea} type="button" onClick={() => goGenerate(mode, idea)}>
                    {idea}
                  </button>
                ))}
              </div>
            </div>
          </section>

          <div className="wc-entry-posthero">
            <div className="wc-entry-project-dock" aria-label="选择要进入的项目">
              <header className="wc-entry-project-dock-header">
                <div>
                  <span>继续工作</span>
                  <strong>
                    {identityStatus === "authenticated"
                      ? `${identitySession?.user.displayName ?? "我的"} 的项目`
                      : "最近项目"}
                  </strong>
                </div>
                <button type="button" onClick={() => void browseProjects()}>
                  <FolderOpen aria-hidden="true" />
                  <span>全部项目</span>
                </button>
              </header>
              {recentProjects.length ? (
                <div className="wc-entry-project-list" role="list">
                  {recentProjects.map((project) => (
                    <div key={project.id} className="wc-entry-project-listitem" role="listitem">
                      <button
                        type="button"
                        className={`wc-entry-project-item ${project.id === activeProjectId ? "is-active" : ""}`}
                        onClick={() => void enterProject(project.id)}
                        aria-label={`打开项目 ${project.name}`}
                      >
                        <span className="wc-entry-project-state" aria-hidden="true" />
                        <span className="wc-entry-project-copy">
                          <strong>{project.name}</strong>
                          <small>
                            {project.nodeCount} 个节点 · {formatProjectTime(project.updatedAt)}
                          </small>
                        </span>
                        <ArrowRight aria-hidden="true" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <button
                  type="button"
                  className="wc-entry-project-empty"
                  onClick={() => void enterNewProject()}
                >
                  <span className="wc-entry-project-empty-icon">
                    <Plus aria-hidden="true" />
                  </span>
                  <span>
                    <strong>创建第一张画布</strong>
                    <small>从一个空白项目开始</small>
                  </span>
                  <ArrowRight aria-hidden="true" />
                </button>
              )}
              <footer className="wc-entry-project-dock-footer">
                <span>
                  {projects.length ? `${projects.length} 个项目 · 按最近编辑排序` : "还没有项目"}
                </span>
                {identityStatus === "authenticated" ? (
                  <span className="wc-entry-project-credits">账号已连接</span>
                ) : (
                  <span>本地项目无需登录</span>
                )}
              </footer>
            </div>

            <div className="wc-entry-hero-actions">
              <button className="wc-entry-button" type="button" onClick={onEnter}>
                <span>进入画布</span>
                <ArrowRight aria-hidden="true" strokeWidth={1.8} />
              </button>
              {CARD_LIBRARY_SITE_URL ? (
                <a
                  className="wc-entry-library-link"
                  href={CARD_LIBRARY_SITE_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Library aria-hidden="true" />
                  <span>浏览卡片库</span>
                  <ExternalLink aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>

          <section id="capabilities" className="wc-entry-showcase-grid" aria-label="灵感作品">
            <div className="wc-entry-section-head">
              <span className="wc-entry-kicker">
                <Sparkles aria-hidden="true" />
                灵感
              </span>
              <h2>从一句话到一件作品</h2>
              <p>看看别人用纬线生成的画面，点一张即可带着它的提示词开始。</p>
            </div>
            <div className="wc-entry-works">
              {SHOWCASE.map((work) => (
                <button
                  key={work.prompt}
                  type="button"
                  className={`wc-entry-work${work.span ? " is-wide" : ""}`}
                  style={{ background: work.tone }}
                  onClick={() => goGenerate(work.kind, work.prompt)}
                  aria-label={`用提示词生成：${work.prompt}`}
                >
                  <span className="wc-entry-work-sheen" aria-hidden="true" />
                  <span className="wc-entry-work-overlay" aria-hidden="true">
                    <span className="wc-entry-work-kind">
                      {work.kind === "image" ? "图片" : "视频"}
                    </span>
                    <span className="wc-entry-work-prompt">{work.prompt}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>

          <section className="wc-entry-capabilities" aria-label="创作能力">
            {CAPABILITIES.map(({ icon: Icon, title, body }) => (
              <article key={title}>
                <span className="wc-entry-capability-icon">
                  <Icon aria-hidden="true" />
                </span>
                <strong>{title}</strong>
                <p>{body}</p>
              </article>
            ))}
          </section>

          <footer className="wc-entry-footer">
            <span>纬线</span>
            <p>一句描述，生成图像与视频；回到画布，让创作继续生长。</p>
            <button type="button" onClick={onEnter}>
              进入画布
              <ArrowRight aria-hidden="true" />
            </button>
          </footer>
        </main>
      </div>
    </section>
  );
}

function formatProjectTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "刚刚编辑";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 7 * 24 * 60 * 60_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

function readActiveProjectId() {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}
