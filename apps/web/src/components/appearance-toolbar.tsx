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
const CustomApiPanel = lazy(async () => ({
  default: (await import("./custom-api-dialog")).CustomApiPanel,
}));
const CollaborationPanel = lazy(async () => ({
  default: (await import("./collaboration-dialog")).CollaborationPanel,
}));
const PluginSettingsPanel = lazy(async () => ({
  default: (await import("./plugin-settings-panel")).PluginSettingsPanel,
}));

type SettingsSection = "ui" | "apis" | "models" | "local" | "collaboration" | "plugins";
type AppearanceTab = "visual" | "interaction";

/**
 * 配色方案。石墨是沿用的灰调；墨黑把底色压到近纯黑——节点靠 1px 描边分层、
 * 浮层靠内嵌高光与深影，原来并列的「纯黑」已并入这一档；素陶走材质路线，
 * 暖炭底 + 陶土铜强调，画面不显得贴在玻璃上；糖彩是多巴胺路线，玫红强调 +
 * 糖果语义色 + 暖影，底色仍是安静的奶油/茄紫。
 * 四套都跟随深浅主题，且与节点/界面样式正交，可任意组合。
 * 配色是产品级四档（带整套 CSS 方案），不走开放注册。
 */
const colorSchemes: Array<{ id: ColorScheme; label: string }> = [
  { id: "graphite", label: "石墨" },
  { id: "ink", label: "墨黑" },
  { id: "clay", label: "素陶" },
  { id: "soda", label: "糖彩" },
];

const defaultAspectRatios: DefaultNodeAspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "3:4"];

/**
 * 两用面板：
 * - mode="settings"（默认）：设置中心，只放 API 配置 / 模型 / 本地保存 / 协作 / 插件。
 *   顶栏「设置」键打开这里。
 * - mode="appearance"：独立的「界面设置」面板，只有视觉 / 交互两页。
 *   底部 dock 的调色板键打开这里，不再和设置中心混在一起。
 * API 配置 / 模型 / 本地保存由 CustomApiPanel 以受控嵌入形态提供。
 */
export function AppearanceToolbar({
  open,
  triggerRef,
  onClose,
  mode = "settings",
  initialSection = "apis",
  section: controlledSection,
  onSectionChange,
}: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  mode?: "settings" | "appearance";
  /** 首次打开时的板块；此后与画布一致，记住用户上次停留的板块。 */
  initialSection?: SettingsSection;
  /** 受控板块：画布从 ui-shell-store 传入，让 Agent 的 ui_open_panel 能切板块。 */
  section?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
}) {
  const appearanceMode = mode === "appearance";
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const [internalSection, setInternalSection] = useState<SettingsSection>(initialSection);
  const requestedSection = controlledSection ?? internalSection;
  const section: SettingsSection = appearanceMode
    ? "ui"
    : requestedSection === "ui"
      ? "apis"
      : requestedSection;
  const setSection = (next: SettingsSection) => {
    onSectionChange?.(next);
    if (controlledSection === undefined) setInternalSection(next);
  };
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
  const setDefaultNodeAspectRatio = useUiPreferencesStore(
    (state) => state.setDefaultNodeAspectRatio,
  );

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;

    if (open) {
      // 记住真正打开面板的那个控件（顶栏「设置」和 dock 的「UI 设置」是两个按钮，
      // 共用同一个面板）。关闭时必须还给它，否则焦点会跑到另一个按钮上。
      const opener = document.activeElement;
      restoreFocusRef.current =
        opener instanceof HTMLElement && !panel.contains(opener) ? opener : triggerRef.current;
      const frame = window.requestAnimationFrame(() => {
        const selectedPreference = panel.querySelector<HTMLButtonElement>(
          'button[aria-pressed="true"]',
        );
        (selectedPreference ?? panel.querySelector<HTMLButtonElement>("button"))?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }

    const target = restoreFocusRef.current ?? triggerRef.current;
    restoreFocusRef.current = null;
    // 下一帧再交还：同一帧里面板还要挂 inert，浏览器会因为子树失效把焦点抹回
    // body，同步 focus 会被这一步覆盖掉。
    window.requestAnimationFrame(() => target?.focus());
  }, [open, triggerRef]);

  return createPortal(
    <div
      ref={panelRef}
      id={appearanceMode ? "wc-appearance-panel" : "wc-appearance-toolbar"}
      className={`wc-appearance-toolbar wc-ui-settings nodrag nopan nowheel ${
        appearanceMode ? "wc-appearance-panel" : ""
      } ${open ? "is-open" : ""}`}
      role="dialog"
      aria-label={appearanceMode ? "界面设置" : "设置"}
      aria-modal="false"
      aria-hidden={!open}
      inert={open ? undefined : true}
      data-wc-block-canvas-shortcuts
      data-section={section}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="wc-ui-settings-header">
        <span className="wc-ui-settings-title">
          {appearanceMode ? <Palette aria-hidden="true" /> : <Settings aria-hidden="true" />}
          {appearanceMode ? "界面设置" : "设置"}
        </span>
        <button
          type="button"
          className="wc-ui-settings-close"
          aria-label={appearanceMode ? "关闭界面设置" : "关闭设置"}
          title="关闭"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div
        className="wc-ui-settings-tabs"
        role="tablist"
        aria-label="设置板块"
        hidden={appearanceMode}
      >
        <button
          type="button"
          role="tab"
          id="wc-settings-section-tab-apis"
          aria-selected={section === "apis"}
          onClick={() => setSection("apis")}
        >
          <Server aria-hidden="true" />
          API 配置
        </button>
        <button
          type="button"
          role="tab"
          id="wc-settings-section-tab-models"
          aria-selected={section === "models"}
          onClick={() => setSection("models")}
        >
          <Settings2 aria-hidden="true" />
          模型
        </button>
        <button
          type="button"
          role="tab"
          id="wc-settings-section-tab-local"
          aria-selected={section === "local"}
          onClick={() => setSection("local")}
        >
          <FolderDown aria-hidden="true" />
          本地保存
        </button>
        <button
          type="button"
          role="tab"
          id="wc-settings-section-tab-collaboration"
          aria-selected={section === "collaboration"}
          onClick={() => setSection("collaboration")}
        >
          <UsersRound aria-hidden="true" />
          协作
        </button>
        <button
          type="button"
          role="tab"
          id="wc-settings-section-tab-plugins"
          aria-selected={section === "plugins"}
          onClick={() => setSection("plugins")}
        >
          <Puzzle aria-hidden="true" />
          插件
        </button>
      </div>

      {section === "ui" ? (
        <>
          <div
            className="wc-ui-settings-tabs wc-ui-settings-tabs--sub"
            role="tablist"
            aria-label="界面设置类别"
          >
            <button
              type="button"
              role="tab"
              id="wc-ui-settings-tab-visual"
              aria-controls="wc-ui-settings-panel-visual"
              aria-selected={activeTab === "visual"}
              onClick={() => setActiveTab("visual")}
            >
              <Sparkles aria-hidden="true" />
              视觉
            </button>
            <button
              type="button"
              role="tab"
              id="wc-ui-settings-tab-interaction"
              aria-controls="wc-ui-settings-panel-interaction"
              aria-selected={activeTab === "interaction"}
              onClick={() => setActiveTab("interaction")}
            >
              <MousePointer2 aria-hidden="true" />
              交互
            </button>
          </div>

          <div
            id="wc-ui-settings-panel-visual"
            className="wc-ui-settings-panel"
            role="tabpanel"
            aria-labelledby="wc-ui-settings-tab-visual"
            hidden={activeTab !== "visual"}
          >
            <PreferenceGroup
              icon={<Frame aria-hidden="true" />}
              label="节点"
              ariaLabel="节点样式"
              variant="nodes"
            >
              {nodeStyleOptions.map((style) => (
                <PreferenceButton
                  key={style.id}
                  active={canvasVisualStyle === style.id}
                  onClick={() => setCanvasVisualStyle(style.id)}
                >
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup
              icon={<SlidersHorizontal aria-hidden="true" />}
              label="界面"
              ariaLabel="界面与功能栏样式"
            >
              {chromeStyleOptions.map((style) => (
                <PreferenceButton
                  key={style.id}
                  active={chromeVisualStyle === style.id}
                  onClick={() => setChromeVisualStyle(style.id)}
                >
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup
              icon={<Contrast aria-hidden="true" />}
              label="配色"
              ariaLabel="配色方案"
            >
              {colorSchemes.map((scheme) => (
                <PreferenceButton
                  key={scheme.id}
                  active={colorScheme === scheme.id}
                  onClick={() => setColorScheme(scheme.id)}
                >
                  {scheme.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup
              icon={<Maximize2 aria-hidden="true" />}
              label="默认画幅"
              ariaLabel="新建媒体节点默认画幅"
              variant="ratios"
            >
              {defaultAspectRatios.map((ratio) => (
                <PreferenceButton
                  key={ratio}
                  active={defaultNodeAspectRatio === ratio}
                  onClick={() => setDefaultNodeAspectRatio(ratio)}
                >
                  {ratio}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup
              icon={<Grid3x3 aria-hidden="true" />}
              label="背景"
              ariaLabel="背景样式"
              variant="full"
            >
              {backgroundStyleOptions.map((style) => (
                <PreferenceButton
                  key={style.id}
                  active={canvasBackgroundStyle === style.id}
                  onClick={() => setCanvasBackgroundStyle(style.id)}
                >
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup
              icon={<Waves aria-hidden="true" />}
              label="生成"
              ariaLabel="生成动效"
              variant="previews"
            >
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
            id="wc-ui-settings-panel-interaction"
            className="wc-ui-settings-panel wc-ui-settings-panel--interaction"
            role="tabpanel"
            aria-labelledby="wc-ui-settings-tab-interaction"
            hidden={activeTab !== "interaction"}
          >
            <PreferenceGroup
              icon={<MousePointer2 aria-hidden="true" />}
              label="鼠标"
              ariaLabel="鼠标样式"
            >
              {cursorStyleOptions.map((style) => (
                <PreferenceButton
                  key={style.id}
                  active={cursorStyle === style.id}
                  onClick={() => setCursorStyle(style.id)}
                >
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup
              icon={<Spline aria-hidden="true" />}
              label="线形"
              ariaLabel="连线形态"
              variant="edges"
            >
              {edgePathStyleOptions.map((style) => (
                <PreferenceButton
                  key={style.id}
                  active={edgePathStyle === style.id}
                  onClick={() => setEdgePathStyle(style.id)}
                >
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup icon={<Orbit aria-hidden="true" />} label="流动" ariaLabel="连线光效">
              {edgeFlowStyleOptions.map((style) => (
                <PreferenceButton
                  key={style.id}
                  active={edgeFlowStyle === style.id}
                  onClick={() => setEdgeFlowStyle(style.id)}
                >
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>

            <PreferenceGroup
              icon={<Sparkles aria-hidden="true" />}
              label="加号"
              ariaLabel="节点加号样式"
            >
              {nodePortStyleOptions.map((style) => (
                <PreferenceButton
                  key={style.id}
                  active={nodePortStyle === style.id}
                  onClick={() => setNodePortStyle(style.id)}
                >
                  {style.label}
                </PreferenceButton>
              ))}
            </PreferenceGroup>
          </div>
        </>
      ) : !open ? null : (
        <div
          className="wc-ui-settings-embed"
          role="tabpanel"
          aria-labelledby={`wc-settings-section-tab-${section}`}
        >
          <Suspense
            fallback={
              <div className="wc-ui-settings-loading" role="status" aria-label="加载中">
                <LoaderCircle className="is-spinning" aria-hidden="true" />
                <span>正在加载</span>
              </div>
            }
          >
            {section === "collaboration" ? (
              <CollaborationPanel />
            ) : section === "plugins" ? (
              <PluginSettingsPanel />
            ) : (
              <CustomApiPanel section={section} />
            )}
          </Suspense>
        </div>
      )}
    </div>,
    document.body,
  );
}

/**
 * 独立的「界面设置」面板：只有视觉 / 交互两页，不出现 API、模型、协作这些设置项。
 * 底部 dock 的调色板键打开它，顶栏「设置」仍然打开设置中心，两者互不打扰。
 */
export function AppearancePanel(props: {
  open: boolean;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  return <AppearanceToolbar {...props} mode="appearance" />;
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
  /**
   * 决定这一组排成几列（见 appearance-panel.css 的 --* 规则）。档位是开放注册的
   * （外观包/插件都能加），所以**选项数一变就要回来看这里**：格子数写死而选项变多，
   * 多出来的那个会掉到第二行变成孤零零的一格。e2e/appearance-panel-rows.spec.ts
   * 钉住了"每组都排成一行"，掉了行会直接红。
   */
  variant?: "swatches" | "previews" | "ratios" | "nodes" | "edges" | "full";
  children: ReactNode;
}) {
  return (
    <section className={`wc-appearance-group ${variant ? `wc-appearance-group--${variant}` : ""}`}>
      <span className="wc-appearance-label">
        {icon}
        <span>{label}</span>
      </span>
      <div
        className={`wc-appearance-segmented ${variant ? `wc-appearance-segmented--${variant}` : ""}`}
        role="group"
        aria-label={ariaLabel}
      >
        {children}
      </div>
    </section>
  );
}

function PreferenceButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? "is-active" : undefined}
      aria-pressed={active}
      onClick={onClick}
    >
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
      className={`wc-generation-effect-choice is-${effect} ${active ? "is-active" : ""}`}
      aria-label={`${label}生成动效`}
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      <span className="wc-generation-effect-preview" aria-hidden="true">
        <span className="wc-generation-effect-preview-layer is-primary" />
        <span className="wc-generation-effect-preview-layer is-secondary" />
        <span className="wc-generation-effect-preview-progress">
          <span />
        </span>
      </span>
      <span className="wc-generation-effect-label">{label}</span>
    </button>
  );
}
