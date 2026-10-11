import {
  Contrast,
  FolderDown,
  Frame,
  Grid3x3,
  Maximize2,
  MousePointer2,
  Orbit,
  Puzzle,
  Palette,
  Server,
  Settings,
  Settings2,
  SlidersHorizontal,
  Spline,
  Sparkles,
  UsersRound,
  Waves,
  X,
  LoaderCircle,
} from "lucide-react";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import {
  useUiPreferencesStore,
  type ColorScheme,
  type DefaultNodeAspectRatio,
  type GenerationEffectStyle,
} from "../state/ui-preferences-store";
import { useAppearanceOptions } from "../lib/appearance-registry";

/** 创作设置面板（自定义 API / 模型 / 本地保存）与协作面板按需加载。 */
const CustomApiPanel = lazy(async () => ({ default: (await import("./custom-api-dialog")).CustomApiPanel }));
const CollaborationPanel = lazy(async () => ({ default: (await import("./collaboration-dialog")).CollaborationPanel }));
const PluginSettingsPanel = lazy(async () => ({ default: (await import("./plugin-settings-panel")).PluginSettingsPanel }));

type SettingsSection = "ui" | "apis" | "models" | "local" | "collaboration" | "plugins";
type AppearanceTab = "visual" | "interaction";

/**
 * 配色方案。石墨是沿用的灰调；墨黑把底色压到近纯黑，层级交给描边。
 * 纯黑是质感路线——深而聚的阴影 + 内嵌高光 + 浮起面板，玻璃暗夜观感。
 * 两套都跟随深浅主题，且与节点/界面样式正交，可任意组合。
 * 配色是产品级三档（带整套 CSS 方案），不走开放注册。
 */
const colorSchemes: Array<{ id: ColorScheme; label: string }> = [
  { id: "graphite", label: "石墨" },
  { id: "ink", label: "墨黑" },
  { id: "onyx", label: "纯黑" },
];

const defaultAspectRatios: DefaultNodeAspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4"];

/**
 * 设置中心：界面 / API 配置 / 模型 / 本地保存 / 协作 / 插件 六个一级板块。
 * 顶栏「设置」与 dock 的 UI 设置键都打开这里；界面是默认板块。
 * API 配置 / 模型 / 本地保存由 CustomApiPanel 以受控嵌入形态提供。
 */
export function AppearanceToolbar({
  open,
  triggerRef,
  onClose,
  initialSection = "ui",
}: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  /** 首次打开时的板块；此后与画布一致，记住用户上次停留的板块。 */
  initialSection?: SettingsSection;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [activeTab, setActiveTab] = useState<AppearanceTab>("visual");
  // 外观档位从注册表读取（docs/PLUGIN-ROADMAP.md §4）：外观包装/卸后按钮自动增减。
  const nodeStyleOptions = useAppearanceOptions("canvasVisualStyle");
  const chromeStyleOptions = useAppearanceOptions("chromeVisualStyle");
  const backgroundStyleOptions = useAppearanceOptions("canvasBackgroundStyle");
  const generationEffectOptions = useAppearanceOptions("generationEffectStyle");
  const edgePathStyleOptions = useAppearanceOptions("edgePathStyle");
  const edgeFlowStyleOptions = useAppearanceOptions("edgeFlowStyle");
  const cursorStyleOptions = useAppearanceOptions("cursorStyle");
  const nodePortStyleOptions = useAppearanceOptions("nodePortStyle");
  const canvasVisualStyle = useUiPreferencesStore((state) => state.canvasVisualStyle);
  const setCanvasVisualStyle = useUiPreferencesStore((state) => state.setCanvasVisualStyle);
  const chromeVisualStyle = useUiPreferencesStore((state) => state.chromeVisualStyle);
  const colorScheme = useUiPreferencesStore((state) => state.colorScheme);
  const setColorScheme = useUiPreferencesStore((state) => state.setColorScheme);
  const setChromeVisualStyle = useUiPreferencesStore((state) => state.setChromeVisualStyle);
  const canvasBackgroundStyle = useUiPreferencesStore((state) => state.canvasBackgroundStyle);
  const setCanvasBackgroundStyle = useUiPreferencesStore((state) => state.setCanvasBackgroundStyle);
  const generationEffectStyle = useUiPreferencesStore((state) => state.generationEffectStyle);
  const setGenerationEffectStyle = useUiPreferencesStore((state) => state.setGenerationEffectStyle);
  const edgePathStyle = useUiPreferencesStore((state) => state.edgePathStyle);
  const setEdgePathStyle = useUiPreferencesStore((state) => state.setEdgePathStyle);
  const edgeFlowStyle = useUiPreferencesStore((state) => state.edgeFlowStyle);
  const setEdgeFlowStyle = useUiPreferencesStore((state) => state.setEdgeFlowStyle);
  const nodePortStyle = useUiPreferencesStore((state) => state.nodePortStyle);
  const setNodePortStyle = useUiPreferencesStore((state) => state.setNodePortStyle);
  const cursorStyle = useUiPreferencesStore((state) => state.cursorStyle);
  const setCursorStyle = useUiPreferencesStore((state) => state.setCursorStyle);
  const defaultNodeAspectRatio = useUiPreferencesStore((state) => state.defaultNodeAspectRatio);
  const setDefaultNodeAspectRatio = useUiPreferencesStore((state) => state.setDefaultNodeAspectRatio);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    if (open) {
      const frame = window.requestAnimationFrame(() => {
        const selectedPreference = panel.querySelector<HTMLButtonElement>('button[aria-pressed="true"]');
        (selectedPreference ?? panel.querySelector<HTMLButtonElement>("button"))?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    if (panel.contains(document.activeElement)) triggerRef.current?.focus();
  }, [open, triggerRef]);

  return createPortal(
    <div
      ref={panelRef}
      id="kc-appearance-toolbar"
      className={`kc-appearance-toolbar kc-ui-settings nodrag nopan nowheel ${open ? "is-open" : ""}`}
      role="dialog"
      aria-label="设置"
      aria-modal="false"
      aria-hidden={!open}
      inert={open ? undefined : true}
      data-kc-block-canvas-shortcuts
      data-section={section}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="kc-ui-settings-header">
        <span className="kc-ui-settings-title"><Settings aria-hidden="true" />设置</span>
        <button type="button" className="kc-ui-settings-close" aria-label="关闭设置" title="关闭" onClick={onClose}>
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="kc-ui-settings-tabs" role="tablist" aria-label="设置板块">
        <button
          type="button"
          role="tab"
          id="kc-settings-section-tab-ui"
          aria-controls="kc-ui-settings-panel-visual"
          aria-selected={section === "ui"}
          onClick={() => setSection("ui")}
        >
          <Palette aria-hidden="true" />界面
        </button>
        <button
          type="button"
          role="tab"
          id="kc-settings-section-tab-apis"
          aria-selected={section === "apis"}
          onClick={() => setSection("apis")}
        >
          <Server aria-hidden="true" />API 配置
        </button>
        <button
          type="button"
          role="tab"
          id="kc-settings-section-tab-models"
          aria-selected={section === "models"}
          onClick={() => setSection("models")}
        >
          <Settings2 aria-hidden="true" />模型
        </button>
        <button
          type="button"
          role="tab"
          id="kc-settings-section-tab-local"
          aria-selected={section === "local"}
          onClick={() => setSection("local")}
        >
          <FolderDown aria-hidden="true" />本地保存
        </button>
        <button
          type="button"
          role="tab"
          id="kc-settings-section-tab-collaboration"
          aria-selected={section === "collaboration"}
          onClick={() => setSection("collaboration")}
        >
          <UsersRound aria-hidden="true" />协作
        </button>
        <button
          type="button"
          role="tab"
          id="kc-settings-section-tab-plugins"
          aria-selected={section === "plugins"}
          onClick={() => setSection("plugins")}
        >
          <Puzzle aria-hidden="true" />插件
        </button>
      </div>

      {section === "ui" ? (
        <>
          <div className="kc-ui-settings-tabs kc-ui-settings-tabs--sub" role="tablist" aria-label="界面设置类别">
            <button
              type="button"
              role="tab"
              id="kc-ui-settings-tab-visual"
              aria-controls="kc-ui-settings-panel-visual"
              aria-selected={activeTab === "visual"}
              onClick={() => setActiveTab("visual")}
            >
              <Sparkles aria-hidden="true" />视觉
            </button>
            <button
              type="button"
              role="tab"
              id="kc-ui-settings-tab-interaction"
              aria-controls="kc-ui-settings-panel-interaction"
              aria-selected={activeTab === "interaction"}
              onClick={() => setActiveTab("interaction")}
            >
              <MousePointer2 aria-hidden="true" />交互
            </button>
          </div>

          <div
            id="kc-ui-settings-panel-visual"
            className="kc-ui-settings-panel"
            role="tabpanel"
            aria-labelledby="kc-ui-settings-tab-visual"
            hidden={activeTab !== "visual"}
          >
            <PreferenceGroup icon={<Frame aria-hidden="true" />} label="节点" ariaLabel="节点样式" variant="nodes">
              {nodeStyleOptions.map((style) => (
                <PreferenceButton key={style.id} active={canvasVisualStyle === style.id} onClick={() => setCanvasVisualStyle(style.id)}>
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<SlidersHorizontal aria-hidden="true" />} label="界面" ariaLabel="界面与功能栏样式">
              {chromeStyleOptions.map((style) => (
                <PreferenceButton key={style.id} active={chromeVisualStyle === style.id} onClick={() => setChromeVisualStyle(style.id)}>
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Contrast aria-hidden="true" />} label="配色" ariaLabel="配色方案">
              {colorSchemes.map((scheme) => (
                <PreferenceButton key={scheme.id} active={colorScheme === scheme.id} onClick={() => setColorScheme(scheme.id)}>
                  {scheme.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Maximize2 aria-hidden="true" />} label="默认画幅" ariaLabel="新建媒体节点默认画幅" variant="ratios">
              {defaultAspectRatios.map((ratio) => (
                <PreferenceButton key={ratio} active={defaultNodeAspectRatio === ratio} onClick={() => setDefaultNodeAspectRatio(ratio)}>
                  {ratio}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Grid3x3 aria-hidden="true" />} label="背景" ariaLabel="背景样式" variant="full">
              {backgroundStyleOptions.map((style) => (
                <PreferenceButton key={style.id} active={canvasBackgroundStyle === style.id} onClick={() => setCanvasBackgroundStyle(style.id)}>
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Waves aria-hidden="true" />} label="生成" ariaLabel="生成动效" variant="previews">
              {generationEffectOptions.map((effect) => (
                <GenerationEffectButton
                  key={effect.id}
                  effect={effect.id}
                  label={effect.label}
                  active={generationEffectStyle === effect.id}
                  onClick={() => setGenerationEffectStyle(effect.id)}
                />
              ))}
            </PreferenceGroup>
          </div>

          <div
            id="kc-ui-settings-panel-interaction"
            className="kc-ui-settings-panel kc-ui-settings-panel--interaction"
            role="tabpanel"
            aria-labelledby="kc-ui-settings-tab-interaction"
            hidden={activeTab !== "interaction"}
          >
            <PreferenceGroup icon={<MousePointer2 aria-hidden="true" />} label="鼠标" ariaLabel="鼠标样式">
              {cursorStyleOptions.map((style) => (
                <PreferenceButton key={style.id} active={cursorStyle === style.id} onClick={() => setCursorStyle(style.id)}>
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Spline aria-hidden="true" />} label="线形" ariaLabel="连线形态">
              {edgePathStyleOptions.map((style) => (
                <PreferenceButton key={style.id} active={edgePathStyle === style.id} onClick={() => setEdgePathStyle(style.id)}>
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Orbit aria-hidden="true" />} label="流动" ariaLabel="连线光效">
              {edgeFlowStyleOptions.map((style) => (
                <PreferenceButton key={style.id} active={edgeFlowStyle === style.id} onClick={() => setEdgeFlowStyle(style.id)}>
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Sparkles aria-hidden="true" />} label="加号" ariaLabel="节点加号样式">
              {nodePortStyleOptions.map((style) => (
                <PreferenceButton key={style.id} active={nodePortStyle === style.id} onClick={() => setNodePortStyle(style.id)}>
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>
          </div>
        </>
      ) : !open ? null : (
        <div className="kc-ui-settings-embed" role="tabpanel" aria-labelledby={`kc-settings-section-tab-${section}`}>
          <Suspense fallback={
            <div className="kc-ui-settings-loading" role="status" aria-label="加载中">
              <LoaderCircle className="is-spinning" aria-hidden="true" />
              <span>正在加载</span>
            </div>
          }>
            {section === "collaboration"
              ? <CollaborationPanel />
              : section === "plugins"
                ? <PluginSettingsPanel />
                : <CustomApiPanel section={section} />}
          </Suspense>
        </div>
      )}
    </div>,
    document.body,
  );
}

function PreferenceGroup({
  icon,
  label,
  ariaLabel,
  variant,
  children,
}: {
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  variant?: "swatches" | "previews" | "ratios" | "nodes" | "full";
  children: ReactNode;
}) {
  return (
    <section className={`kc-appearance-group ${variant ? `kc-appearance-group--${variant}` : ""}`}>
      <span className="kc-appearance-label">{icon}<span>{label}</span></span>
      <div className={`kc-appearance-segmented ${variant ? `kc-appearance-segmented--${variant}` : ""}`} role="group" aria-label={ariaLabel}>{children}</div>
    </section>
  );
}

function PreferenceButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={active ? "is-active" : undefined} aria-pressed={active} onClick={onClick}>
      {children}
    </button>
  );
}

function GenerationEffectButton({
  effect,
  label,
  active,
  onClick,
}: {
  effect: GenerationEffectStyle;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`kc-generation-effect-choice is-${effect} ${active ? "is-active" : ""}`}
      aria-label={`${label}生成动效`}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      <span className="kc-generation-effect-preview" aria-hidden="true">
        <span className="kc-generation-effect-preview-layer is-primary" />
        <span className="kc-generation-effect-preview-layer is-secondary" />
        <span className="kc-generation-effect-preview-progress"><span /></span>
      </span>
      <span className="kc-generation-effect-label">{label}</span>
    </button>
  );
}
