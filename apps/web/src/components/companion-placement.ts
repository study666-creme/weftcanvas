import type { CompanionAnchor, CompanionDock } from "../state/ui-preferences-store";

export type DockTarget = { key: CompanionDock; selector: string };

/**
 * 可以趴上去的面板。新增面板时在这里登记即可——
 * 选择器只在运行时用来量位置，localStorage 里存的是稳定的业务键。
 */
export const DOCK_TARGETS: readonly DockTarget[] = [
  { key: "edit-dock", selector: ".wc-edit-dock" },
  { key: "node-config", selector: ".wc-node-config-shell" },
  { key: "node-prompt", selector: ".wc-node-prompt-shell" },
  { key: "agent-drawer", selector: ".wc-agent-drawer" },
  { key: "resource-drawer", selector: ".wc-resource-drawer" },
  { key: "workspace-assets", selector: ".wc-workspace-assets" },
  { key: "appearance", selector: ".wc-appearance-toolbar" },
];

/**
 * 「墙壁后探头」的两个观感来源：**只露脑袋不够**——用户要的是正常人从墙后
 * 探头：脸 + 小手扶墙 + 一点衣物裙摆。所以竖直的墙用**侧身**贴（脸朝画布、
 * 背和长发藏在墙后），横向面板用正面趴（头和胸口在边沿上方）。
 *
 * - PEEK_WALL_VISIBLE：侧身贴墙时，身宽露出多少（其余在墙后）。
 *   按钮宽 80（= --whale-w 68 + 12）、侧身 sprite 宽 0.88*68 ≈ 59.8 且在按钮里
 *   居中，所以按钮系数 0.46 ≈ sprite 露出 45%（脸 + 前襟 + 裙摆一角）。
 *   改 CSS 里侧面的缩放系数，这里要跟着调。
 * - PEEK_LEDGE_HIDDEN：趴横向面板顶边时，身高有多少被面板盖住。
 */
export const PEEK_WALL_VISIBLE = 0.46;
export const PEEK_LEDGE_HIDDEN = 0.34;
/** 探头时她的 z-index 压到面板之下多少，让面板真的画在她上面。 */
export const DOCK_Z_STEP = 4;
/** 松手时离默认位置多近算「放回原位」。 */
export const RESET_RADIUS = 76;
/** 默认停留位（画布顶部居中）的纵向偏移。 */
export const DEFAULT_TOP = 26;

export type Rect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type Placement = {
  /** 伙伴中心点的横向位置（相对定位父级）。 */
  x: number;
  /** 伙伴顶边的纵向位置。 */
  y: number;
  /** 趴在面板上时压到面板之下的 z-index；自由摆放时不需要。 */
  z?: number;
  /** 命中的停靠面板。 */
  dock?: CompanionDock;
  /** 竖直的墙（抽屉左缘）在父级坐标系里的 x——小手贴片贴着它画。 */
  wall?: { x: number };
  /** 横向面板的顶边在父级坐标系里的 y。 */
  ledge?: { y: number };
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function toRect(element: Element): Rect | null {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height,
  };
}

function dockElement(dock: CompanionDock): Element | null {
  const target = DOCK_TARGETS.find((entry) => entry.key === dock);
  return target ? document.querySelector(target.selector) : null;
}

/** 趴着时的层级：压到所趴面板之下，让面板把她下半身遮住。 */
function panelZ(element: Element): number {
  const parsed = Number.parseFloat(window.getComputedStyle(element).zIndex);
  return Number.isFinite(parsed) ? parsed : 20;
}

/**
 * 真正能趴的面板：在 DOM 里、有面积、可见，且不是整屏的幕布容器——
 * 否则一次拖拽会命中某个透明的全屏包装层，把她「粘」在一块看不见的板上。
 */
function isDockableSurface(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 4 || rect.height <= 4) return false;
  const viewport = window.innerWidth * window.innerHeight;
  if (rect.width * rect.height > viewport * 0.8) return false;
  try {
    if (typeof element.checkVisibility === "function" && !element.checkVisibility()) return false;
  } catch {
    /* 没有 checkVisibility 的环境就放过，命中测试还会兜底 */
  }
  return true;
}

/**
 * 落点处最上面的可见元素。做命中测试时把自己暂时藏起来——
 * 不然她正好压在落点上，永远只能命中她自己。
 * visibility 同步改、同步还原，不会真的闪一帧。
 */
function probeHitElement(x: number, y: number, self: HTMLElement | null): Element | null {
  if (!self) return document.elementFromPoint(x, y);
  const previous = self.style.visibility;
  self.style.visibility = "hidden";
  const hit = document.elementFromPoint(x, y);
  self.style.visibility = previous;
  return hit;
}

/**
 * 松手位置趴在哪块面板上：对落点做真实命中测试，再沿祖先链找登记过的面板。
 * 返回命中的元素本身，调用方可以直接量它的矩形。
 */
export function findDockTargetAt(
  x: number,
  y: number,
  self: HTMLElement | null = null,
): { key: CompanionDock; element: Element; z: number } | null {
  const hit = probeHitElement(x, y, self);
  if (!hit) return null;
  for (let el: Element | null = hit; el; el = el.parentElement) {
    const target = DOCK_TARGETS.find((entry) => el!.matches(entry.selector));
    if (target && isDockableSurface(el)) return { key: target.key, element: el, z: panelZ(el) };
  }
  return null;
}

/**
 * 把 anchor 解析成实际摆放位置。返回值一律是「相对定位父级」的坐标
 * （left/top 直接喂给内联样式），因为锚点存的就是相对坐标。
 * - null → 用 CSS 默认位（顶部居中）。
 * - free → 按存的像素摆，夹在工作区里。
 * - dock → 量面板现在的位置贴上去；面板不在了或顶边没空间就回默认位。
 */
export function resolveCompanionPlacement(
  anchor: CompanionAnchor | null,
  size: { width: number; height: number },
  bounds: Rect,
): Placement | null {
  if (!anchor) return null;
  const halfWidth = size.width / 2;

  if (anchor.kind === "free") {
    return {
      x: clamp(anchor.x, halfWidth - 6, bounds.width - halfWidth + 6),
      y: clamp(anchor.y, 4, bounds.height - size.height - 4),
    };
  }

  const element = dockElement(anchor.dock);
  if (!element || !isDockableSurface(element)) return null;
  const rect = toRect(element);
  if (!rect) return null;

  // 面板矩形换算成相对坐标，和锚点同一个坐标系。
  const left = rect.left - bounds.left;
  const top = rect.top - bounds.top;
  const z = panelZ(element);

  if (anchor.dock === "agent-drawer") {
    // 墙壁后探头（竖直的墙）：侧身贴在抽屉左缘，脸和前襟露在画布侧，
    // 背和长发藏在抽屉后面。x 是中心点：
    //   露出 sprite 左段 PEEK_WALL_VISIBLE ⇒ sprite 左缘 = left - PEEK_WALL_VISIBLE * width
    //   ⇒ x = left - width * (PEEK_WALL_VISIBLE - 0.5)
    // （两侧都按**按钮**宽算；sprite 在按钮里居中，所以比例换算成立。）
    const x = clamp(
      left - size.width * (PEEK_WALL_VISIBLE - 0.5),
      -size.width * 0.4,
      bounds.width - halfWidth,
    );
    const y = clamp(
      top + rect.height * anchor.x - size.height * 0.5,
      Math.max(4, top + 4),
      Math.min(bounds.height - size.height - 4, top + rect.height - size.height),
    );
    // wall.x = 墙面（抽屉左缘）在父级坐标系里的位置，小手贴片贴着它画。
    return { x, y, z: Math.max(1, z - DOCK_Z_STEP), dock: anchor.dock, wall: { x: left } };
  }

  // 趴横向面板的顶边（另一面「墙」横过来了）：正面趴，头和胸口在边沿上方，
  // 下缘 PEEK_LEDGE_HIDDEN 段身高被面板盖住。面板 z 更高，遮挡是真的。
  const y = top - size.height * (1 - PEEK_LEDGE_HIDDEN);
  if (y < 2) return null;

  return {
    x: clamp(left + rect.width * anchor.x, halfWidth - 6, bounds.width - halfWidth + 6),
    y,
    z: Math.max(1, z - DOCK_Z_STEP),
    dock: anchor.dock,
    ledge: { y: top },
  };
}

/** 松手时是否应该回到默认位（拖回了出生点附近）。入参用相对坐标。 */
export function shouldResetToDefault(
  x: number,
  y: number,
  size: { width: number },
  bounds: Rect,
): boolean {
  const dx = x - bounds.width / 2;
  const dy = y - DEFAULT_TOP;
  return Math.hypot(dx, dy) <= RESET_RADIUS + size.width / 6;
}

/** 把一个任意点位夹回工作区内（拖拽过程中逐帧用）。 */
export function clampPlacement(
  x: number,
  y: number,
  size: { width: number; height: number },
  bounds: Rect,
): Placement {
  return {
    x: clamp(x, bounds.left + size.width / 2 - 6, bounds.right - size.width / 2 + 6),
    y: clamp(y, bounds.top + 4, bounds.bottom - size.height - 4),
  };
}
