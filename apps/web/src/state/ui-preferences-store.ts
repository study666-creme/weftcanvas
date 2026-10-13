import { create } from "zustand";

import type { ModelModality } from "@weftcanvas/contracts";

import { isRegisteredAppearanceValue, type AppearanceSlot } from "../lib/appearance-registry";
// 内置档位必须先于本模块的 normalize 注册（read 在模块求值期执行）。
import "../lib/builtin-appearance";
import { isDefaultNodeAspectRatio, type DefaultNodeAspectRatio } from "../lib/node-size";

export type { DefaultNodeAspectRatio } from "../lib/node-size";

/**
 * 外观档位 ID（docs/PLUGIN-ROADMAP.md §4）：开放注册后从闭合联合放宽为
 * string 别名。"值是否合法"的唯一判定源是外观注册表——read normalize 拒绝
 * 未注册值并回落默认；setter 不重复校验（UI 只渲染注册档位，未注册值写了
 * 也会在下次读取时回落，测试覆盖该行为）。
 */
export type StyleOptionId = string;

export type NodePortStyle = StyleOptionId;
/**
 * 画布界面风格。`airy`（疏朗）是宽间距、近直角的开阔版本；`cosmos`（深空）与
 * `lingjing`（灵境）已下线，历史存档在读取时归一化回默认值，不会白屏也不会
 * 静默套用别的风格。
 */
export type CanvasVisualStyle = StyleOptionId;
export type NodeVisualStyle = StyleOptionId;
export type CanvasBackgroundStyle = StyleOptionId;
export type GenerationEffectStyle = StyleOptionId;
export type EdgePathStyle = StyleOptionId;
export type EdgeFlowStyle = StyleOptionId;
/**
 * 画布伙伴样式。`whale` 是 DeepSeek 娘（鲸鱼娘）——蓝发、鲸尾、女仆围裙的默认形象；
 * `bear` / `robot` 是历史样式，保留在选择器里随时可切回。
 */
export type CompanionStyle = "whale" | "bear" | "robot";
/** 鼠标样式：classic=质感自定义指针，precision=精确十字指针（原生光标）。 */
export type CursorStyle = StyleOptionId;
/**
 * 配色方案，与节点/界面样式、深浅主题三者正交。
 * `graphite`（石墨）是现有的灰调版本，偏商业；`ink`（墨黑）把底色压到近纯黑、
 * 层级完全交给 1px 描边与明度，不再靠灰色渐变。
 * `onyx`（纯黑）是新加的质感纯黑——深而聚的阴影、内嵌高光、浮起面板，
 * 不同于 ink 的「纯黑怼纯黑」，更接近玻璃暗夜观感。
 */
export type ColorScheme = "graphite" | "ink" | "onyx";

/**
 * 伙伴可以趴上去的面板。键名是稳定的业务名，组件里再映射成选择器——
 * 别把 CSS 选择器存进 localStorage，改类名会把这个功能整个弄坏。
 */
export type CompanionDock =
  | "edit-dock"
  | "node-config"
  | "node-prompt"
  | "agent-drawer"
  | "resource-drawer"
  | "workspace-assets"
  | "appearance"
  | "topbar"
  | "project-sidebar"
  | "activity-panel"
  | "create-rail"
  | "zoom-control"
  | "shortcuts"
  | "account-dialog"
  | "clip-editor";

/**
 * 伙伴被拖到哪了。null = 默认位置（画布顶部居中，和小熊 / 机器人一致）。
 * - free：x/y 相对工作区的像素，x 是伙伴的中心点、y 是顶边。
 * - dock：趴在某个面板的顶边上，x 记成面板宽度里的比例（0..1），
 *   这样面板变宽变窄、窗口缩放时她都贴在同一条边上。
 */
export type CompanionAnchor =
  { kind: "free"; x: number; y: number } | { kind: "dock"; dock: CompanionDock; x: number };

export const COMPANION_DOCKS: readonly CompanionDock[] = [
  "edit-dock",
  "node-config",
  "node-prompt",
  "agent-drawer",
  "resource-drawer",
  "workspace-assets",
  "appearance",
  "topbar",
  "project-sidebar",
  "activity-panel",
  "create-rail",
  "zoom-control",
  "shortcuts",
  "account-dialog",
  "clip-editor",
];

export function normalizeCompanionAnchor(value: unknown): CompanionAnchor | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as { kind?: unknown; x?: unknown; y?: unknown; dock?: unknown };
  if (candidate.kind === "free") {
    if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x)) return null;
    if (typeof candidate.y !== "number" || !Number.isFinite(candidate.y)) return null;
    return { kind: "free", x: candidate.x, y: candidate.y };
  }
  if (candidate.kind === "dock") {
    if (
      typeof candidate.dock !== "string" ||
      !COMPANION_DOCKS.includes(candidate.dock as CompanionDock)
    )
      return null;
    if (typeof candidate.x !== "number" || !Number.isFinite(candidate.x)) return null;
    return {
      kind: "dock",
      dock: candidate.dock as CompanionDock,
      x: Math.min(0.94, Math.max(0.06, candidate.x)),
    };
  }
  return null;
}

/** 每个模态记住的上一次生成设置，用于新建节点时自动恢复模型与参数。 */
export type LastMediaGenerationSettings = {
  modelId: string;
  parameters: Record<string, unknown>;
  maxOutputTokens: number | null;
};

const STORAGE_KEY = "weftcanvas:ui-preferences:v1";

type UiPreferencesState = {
  nodePortStyle: NodePortStyle;
  colorScheme: ColorScheme;
  chromeVisualStyle: CanvasVisualStyle;
  canvasVisualStyle: NodeVisualStyle;
  canvasBackgroundStyle: CanvasBackgroundStyle;
  generationEffectStyle: GenerationEffectStyle;
  edgePathStyle: EdgePathStyle;
  edgeFlowStyle: EdgeFlowStyle;
  companionStyle: CompanionStyle;
  companionAnchor: CompanionAnchor | null;
  cursorStyle: CursorStyle;
  defaultNodeAspectRatio: DefaultNodeAspectRatio;
  lastMediaGeneration: Partial<Record<ModelModality, LastMediaGenerationSettings>>;
  setNodePortStyle: (style: NodePortStyle) => void;
  setColorScheme: (scheme: ColorScheme) => void;
  setChromeVisualStyle: (style: CanvasVisualStyle) => void;
  setCanvasVisualStyle: (style: NodeVisualStyle) => void;
  setCanvasBackgroundStyle: (style: CanvasBackgroundStyle) => void;
  setGenerationEffectStyle: (style: GenerationEffectStyle) => void;
  setEdgePathStyle: (style: EdgePathStyle) => void;
  setEdgeFlowStyle: (style: EdgeFlowStyle) => void;
  setCompanionStyle: (style: CompanionStyle) => void;
  setCompanionAnchor: (anchor: CompanionAnchor | null) => void;
  setCursorStyle: (style: CursorStyle) => void;
  setDefaultNodeAspectRatio: (aspectRatio: DefaultNodeAspectRatio) => void;
  setLastMediaGeneration: (modality: ModelModality, settings: LastMediaGenerationSettings) => void;
};

type StoredUiPreferences = {
  nodePortStyle: NodePortStyle;
  colorScheme: ColorScheme;
  chromeVisualStyle: CanvasVisualStyle;
  canvasVisualStyle: NodeVisualStyle;
  canvasBackgroundStyle: CanvasBackgroundStyle;
  generationEffectStyle: GenerationEffectStyle;
  edgePathStyle: EdgePathStyle;
  edgeFlowStyle: EdgeFlowStyle;
  companionStyle: CompanionStyle;
  companionAnchor: CompanionAnchor | null;
  cursorStyle: CursorStyle;
  defaultNodeAspectRatio: DefaultNodeAspectRatio;
  lastMediaGeneration: Partial<Record<ModelModality, LastMediaGenerationSettings>>;
};

const initialPreferences = readUiPreferences();

export const useUiPreferencesStore = create<UiPreferencesState>((set) => ({
  ...initialPreferences,
  setNodePortStyle: (nodePortStyle) => set((state) => persistPreferences(state, { nodePortStyle })),
  setColorScheme: (colorScheme) => set((state) => persistPreferences(state, { colorScheme })),
  setChromeVisualStyle: (chromeVisualStyle) =>
    set((state) => persistPreferences(state, { chromeVisualStyle })),
  setCanvasVisualStyle: (canvasVisualStyle) =>
    set((state) => persistPreferences(state, { canvasVisualStyle })),
  setCanvasBackgroundStyle: (canvasBackgroundStyle) =>
    set((state) => persistPreferences(state, { canvasBackgroundStyle })),
  setGenerationEffectStyle: (generationEffectStyle) =>
    set((state) => persistPreferences(state, { generationEffectStyle })),
  setEdgePathStyle: (edgePathStyle) => set((state) => persistPreferences(state, { edgePathStyle })),
  setEdgeFlowStyle: (edgeFlowStyle) => set((state) => persistPreferences(state, { edgeFlowStyle })),
  setCompanionStyle: (companionStyle) =>
    set((state) => persistPreferences(state, { companionStyle })),
  setCompanionAnchor: (companionAnchor) =>
    set((state) => persistPreferences(state, { companionAnchor })),
  setCursorStyle: (cursorStyle) => set((state) => persistPreferences(state, { cursorStyle })),
  setDefaultNodeAspectRatio: (defaultNodeAspectRatio) =>
    set((state) => persistPreferences(state, { defaultNodeAspectRatio })),
  setLastMediaGeneration: (modality, settings) =>
    set((state) =>
      persistPreferences(state, {
        lastMediaGeneration: { ...state.lastMediaGeneration, [modality]: settings },
      }),
    ),
}));

function readUiPreferences(): StoredUiPreferences {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as {
      nodePortStyle?: unknown;
      colorScheme?: unknown;
      chromeVisualStyle?: unknown;
      canvasVisualStyle?: unknown;
      canvasBackgroundStyle?: unknown;
      generationEffectStyle?: unknown;
      edgePathStyle?: unknown;
      edgeFlowStyle?: unknown;
      companionStyle?: unknown;
      companionAnchor?: unknown;
      cursorStyle?: unknown;
      defaultNodeSize?: unknown;
      defaultNodeAspectRatio?: unknown;
      lastMediaGeneration?: unknown;
    } | null;
    const canvasVisualStyle = normalizeStyleOption(
      "canvasVisualStyle",
      stored?.canvasVisualStyle,
      "airy",
    );
    const legacyChromeFallback = isRegisteredAppearanceValue("chromeVisualStyle", canvasVisualStyle)
      ? (canvasVisualStyle as StyleOptionId)
      : ("airy" as StyleOptionId);
    return {
      nodePortStyle: normalizeStyleOption("nodePortStyle", stored?.nodePortStyle, "classic"),
      colorScheme:
        stored?.colorScheme === "ink" || stored?.colorScheme === "onyx"
          ? stored.colorScheme
          : "graphite",
      canvasVisualStyle,
      // Older v1 records used one preset for nodes and chrome. Copy it once so
      // the upgrade has no visual jump, then persist both controls separately.
      chromeVisualStyle: normalizeStyleOption(
        "chromeVisualStyle",
        stored?.chromeVisualStyle,
        legacyChromeFallback,
      ),
      canvasBackgroundStyle: normalizeStyleOption(
        "canvasBackgroundStyle",
        stored?.canvasBackgroundStyle,
        "layered-grid",
      ),
      generationEffectStyle: normalizeStyleOption(
        "generationEffectStyle",
        stored?.generationEffectStyle,
        "beam",
      ),
      edgePathStyle: normalizeStyleOption("edgePathStyle", stored?.edgePathStyle, "taut"),
      edgeFlowStyle: normalizeStyleOption("edgeFlowStyle", stored?.edgeFlowStyle, "stream"),
      companionStyle:
        stored?.companionStyle === "robot"
          ? "robot"
          : stored?.companionStyle === "bear"
            ? "bear"
            : "whale",
      // 默认「质感」：自绘光标接回画布后它就是最像"产品角色"的一档；
      // 存过的用户偏好原样保留（只认 "precision" 这个显式值）。
      cursorStyle: normalizeStyleOption("cursorStyle", stored?.cursorStyle, "classic"),
      defaultNodeAspectRatio: isDefaultNodeAspectRatio(stored?.defaultNodeAspectRatio)
        ? stored.defaultNodeAspectRatio
        : "16:9",
      lastMediaGeneration: normalizeLastMediaGeneration(stored?.lastMediaGeneration),
      companionAnchor: normalizeCompanionAnchor(stored?.companionAnchor),
    };
  } catch {
    return {
      nodePortStyle: "classic",
      colorScheme: "graphite",
      chromeVisualStyle: "airy",
      canvasVisualStyle: "airy",
      canvasBackgroundStyle: "layered-grid",
      generationEffectStyle: "beam",
      edgePathStyle: "taut",
      edgeFlowStyle: "stream",
      companionStyle: "whale",
      cursorStyle: "classic",
      defaultNodeAspectRatio: "16:9",
      lastMediaGeneration: {},
      companionAnchor: null,
    };
  }
}

function persistPreferences(state: UiPreferencesState, change: Partial<StoredUiPreferences>) {
  const preferences: StoredUiPreferences = {
    nodePortStyle: state.nodePortStyle,
    colorScheme: state.colorScheme,
    chromeVisualStyle: state.chromeVisualStyle,
    canvasVisualStyle: state.canvasVisualStyle,
    canvasBackgroundStyle: state.canvasBackgroundStyle,
    generationEffectStyle: state.generationEffectStyle,
    edgePathStyle: state.edgePathStyle,
    edgeFlowStyle: state.edgeFlowStyle,
    companionStyle: state.companionStyle,
    companionAnchor: state.companionAnchor,
    cursorStyle: state.cursorStyle,
    defaultNodeAspectRatio: state.defaultNodeAspectRatio,
    lastMediaGeneration: state.lastMediaGeneration,
    ...change,
  };
  writeUiPreferences(preferences);
  return preferences;
}

function normalizeLastMediaGeneration(
  value: unknown,
): Partial<Record<ModelModality, LastMediaGenerationSettings>> {
  if (!value || typeof value !== "object") return {};
  const entries = Object.entries(value as Record<string, unknown>);
  const normalized: Partial<Record<ModelModality, LastMediaGenerationSettings>> = {};
  for (const [modality, settings] of entries) {
    if (modality !== "text" && modality !== "image" && modality !== "video" && modality !== "audio")
      continue;
    if (!settings || typeof settings !== "object") continue;
    const candidate = settings as Partial<LastMediaGenerationSettings>;
    if (typeof candidate.modelId !== "string" || !candidate.modelId) continue;
    if (!candidate.parameters || typeof candidate.parameters !== "object") continue;
    normalized[modality] = {
      modelId: candidate.modelId,
      parameters: candidate.parameters as Record<string, unknown>,
      maxOutputTokens:
        typeof candidate.maxOutputTokens === "number" ? candidate.maxOutputTokens : null,
    };
  }
  return normalized;
}

/**
 * 外观档位的注册表化 normalize：只有当前注册表里存在的值才被接受，
 * 未知/历史存量值回落默认（cosmos、灵境等下线档即由此消失）。
 */
function normalizeStyleOption(
  slot: AppearanceSlot,
  value: unknown,
  fallback: StyleOptionId,
): StyleOptionId {
  return isRegisteredAppearanceValue(slot, value) ? (value as StyleOptionId) : fallback;
}

function writeUiPreferences(preferences: StoredUiPreferences) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // The preference remains active for this session when storage is unavailable.
  }
}
