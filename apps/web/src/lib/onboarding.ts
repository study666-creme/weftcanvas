/**
 * 新手教程的步骤表与卡片落位计算（无 React 依赖，便于单测）。
 *
 * 教程跨三个界面，按「入口首屏 → 简易工作台 → 专业画布」的顺序走：
 * 首屏一步（去简易工作台）→ 工作台两步（认识工作台 → 从本界面右上角点「打开
 * 画布」）→ 画布三步（创建节点 / 空格平移 / Ctrl 缩放）。
 * 步骤只存稳定的锚点选择器（各界面元素上的 `data-wc-tour`，手势步骤用
 * `.react-flow__pane`），组件持续测量真实矩形，所以宿主元素改版式不用改步骤表。
 */

export type OnboardingRoute = "home" | "workbench" | "canvas";

/** 用户做出被教的动作后自动前进的判定方式。 */
export type OnboardingAdvance = "node-created" | "space-drag" | "wheel-zoom";

/** 卡片相对锚点的期望方位；`center` = 不贴锚点，居中提示（整屏手势步骤）。 */
export type CoachPlacement = "below" | "above" | "right" | "left" | "center";

export type OnboardingStep = {
  id: string;
  /** 这一步能在哪些界面里走；跨界面靠路由对齐推进（首屏 → 工作台 → 画布）。 */
  routes: readonly OnboardingRoute[];
  /**
   * 锚点选择器：各界面元素上的 `data-wc-tour` 属性，`.react-flow__pane` 用类名。
   * 锚点找不到时教程宁可不画，也不会先摆到屏幕中间再跳过去。
   */
  target: string;
  /**
   * 这一步所属界面本身的选择器。锚点迟迟不出现时，只有界面已经在场（说明是
   * 真出错，而不是"用户还停在登录页"）才用居中卡片兜底。
   */
  surface: string;
  placement: CoachPlacement;
  title: string;
  body: string;
  /** 键帽提示（键盘类步骤）。 */
  keys?: readonly string[];
  /** 主按钮文案，缺省 = 下一步 / 最后一步「完成」。 */
  primaryLabel?: string;
  /** 该步骤的按钮要触发的动作；缺省 = 前进到下一步。 */
  action?: "enter-canvas" | "goto-workbench";
  /** 做出动作即自动前进。 */
  advanceOn?: OnboardingAdvance;
  /** 动手类步骤底部提示（该步不给"下一步"按钮）。 */
  advanceHint?: string;
};

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: "goto-workbench",
    routes: ["home"],
    // 三个生成入口（图片 / 视频 / 音频）都挂这个锚点，教程环套第一个命中的
    // 「图片生成」；文案说明旁边的入口同样可行。
    target: '[data-wc-tour="goto-workbench"]',
    surface: ".wc-entry-gate",
    placement: "below",
    title: "先去简易工作台",
    body: "生成图片、视频、音频都从简易工作台开始，不用打开画布。点顶部任意一个生成入口进去看看。",
    primaryLabel: "去简易工作台",
    action: "goto-workbench",
  },
  {
    id: "workbench",
    routes: ["workbench"],
    target: '[data-wc-tour="workbench"]',
    surface: ".wc-direct-page",
    placement: "below",
    title: "这里是生成工作台",
    body: "写一句描述、选好模型和参数，就能直接生成图片或视频。生成的成果可以落进画布继续编排。",
  },
  {
    id: "enter-canvas",
    routes: ["workbench"],
    target: '[data-wc-tour="enter-canvas"]',
    surface: ".wc-direct-page",
    placement: "below",
    title: "进画布从这里开始",
    body: "点右上角这个按钮，正式进入画布。教程会在画布那边接着走。",
    primaryLabel: "进入画布",
    action: "enter-canvas",
  },
  {
    id: "create-node",
    routes: ["canvas"],
    target: '[data-wc-tour="create-rail"]',
    surface: ".wc-workspace",
    // 卡片放在创建栏下方而不是右边：那正是「+」的节点类型面板展开的位置，
    // 教程卡压在那儿就等于把用户要点的按钮盖住了。
    placement: "below",
    title: "创建第一个节点",
    body: "在画布空白处双击，或者点上面这个「+」选一种节点类型。节点就是画布上的一件素材或一段文字。",
    advanceOn: "node-created",
    advanceHint: "创建一个节点后自动继续",
  },
  {
    id: "space-pan",
    routes: ["canvas"],
    target: ".react-flow__pane",
    surface: ".wc-workspace",
    placement: "center",
    title: "按住空格拖动画面",
    body: "按住空格键不放，再用鼠标拖动，就能平移整块画布；松开空格即恢复正常操作。",
    keys: ["空格键", "拖动"],
    advanceOn: "space-drag",
    advanceHint: "拖一次后自动继续",
  },
  {
    id: "ctrl-zoom",
    routes: ["canvas"],
    target: '[data-wc-tour="zoom"]',
    surface: ".wc-workspace",
    placement: "above",
    title: "按住 Ctrl 滚动缩放",
    body: "按住 Ctrl（Mac 上是 ⌘）滚动滚轮即可放大缩小；左下角这条缩放条也能直接拖。",
    keys: ["Ctrl / ⌘", "滚轮"],
    advanceOn: "wheel-zoom",
    advanceHint: "缩放一次后自动继续",
  },
];

export const ONBOARDING_STORAGE_KEY = "weftcanvas:onboarding:v1";
const ONBOARDING_DONE_VALUE = "done";

/** 这一步在哪些界面里走。 */
export function stepRunsOnRoute(step: OnboardingStep, route: OnboardingRoute): boolean {
  return step.routes.includes(route);
}

/**
 * 该路由的第一个步骤下标。自动开跑按用户落地的路由起步（首屏从「去简易工作台」
 * 起、直接落在工作台就从「认识工作台」起）；「重看新手教程」不走这里——它一律
 * 从第 0 步开始，再一路走进画布（见 onboarding-store 的 replay）。
 */
export function firstStepIndexForRoute(route: OnboardingRoute): number {
  const index = ONBOARDING_STEPS.findIndex((step) => stepRunsOnRoute(step, route));
  return index < 0 ? 0 : index;
}

export function isOnboardingDoneValue(value: unknown): boolean {
  return value === ONBOARDING_DONE_VALUE;
}

export function readOnboardingDone(): boolean {
  try {
    return isOnboardingDoneValue(localStorage.getItem(ONBOARDING_STORAGE_KEY));
  } catch {
    // 存储不可用时按"没看过"处理：教程只在本会话内出现一次，不写坏任何状态。
    return false;
  }
}

export function writeOnboardingDone(): void {
  try {
    localStorage.setItem(ONBOARDING_STORAGE_KEY, ONBOARDING_DONE_VALUE);
  } catch {
    // 写不进去就退化成"每次访问都教一遍"，不影响功能。
  }
}

/** 步骤序号从 0 起，越界一律回落 0，避免存档脏值时白屏。 */
export function normalizeStepIndex(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  if (value < 0 || value >= ONBOARDING_STEPS.length) return 0;
  return value;
}

export type Rect = { left: number; top: number; width: number; height: number };

export const COACH_GAP = 14;
export const COACH_PADDING = 12;
/**
 * 锚点占视口这么大比例时不再画高亮环：整屏画布这种"锚点"围一圈描边只会
 * 让人以为整个画面被选中了，手势步骤只留居中的提示卡。
 */
const SPOTLIGHT_MAX_AREA_RATIO = 0.55;

export type CoachGeometry = {
  left: number;
  top: number;
  /** 实际采用的方位（放不下会换边）。 */
  placement: CoachPlacement;
  /** 高亮环的矩形；null = 这一步不画环。 */
  spotlight: Rect | null;
  /** 箭头贴着卡片的哪条边、在边上的偏移；null = 不画箭头。 */
  arrow: { edge: CoachPlacement; x: number; y: number } | null;
};

export type CoachGeometryInput = {
  target: Rect | null;
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  preferred: CoachPlacement;
};

const OPPOSITE: Record<"below" | "above" | "left" | "right", "below" | "above" | "left" | "right"> =
  { below: "above", above: "below", left: "right", right: "left" };

export function computeCoachGeometry(input: CoachGeometryInput): CoachGeometry {
  const { target, viewport } = input;
  const card = {
    width: Math.max(160, Math.min(input.card.width, viewport.width - COACH_PADDING * 2)),
    height: Math.max(96, input.card.height),
  };

  if (!target || input.preferred === "center") return centered(card, viewport);
  if (target.width * target.height >= viewport.width * viewport.height * SPOTLIGHT_MAX_AREA_RATIO)
    return centered(card, viewport);

  const order: ("below" | "above" | "left" | "right")[] = [
    input.preferred,
    OPPOSITE[input.preferred],
    ...(input.preferred === "below" || input.preferred === "above"
      ? (["right", "left"] as const)
      : (["below", "above"] as const)),
  ];
  const placement =
    order.find((candidate) => fits(candidate, target, card, viewport)) ??
    best(order, target, viewport);

  const centerX = target.left + target.width / 2;
  const centerY = target.top + target.height / 2;
  let left = centerX - card.width / 2;
  let top = centerY - card.height / 2;
  if (placement === "below") top = target.top + target.height + COACH_GAP;
  if (placement === "above") top = target.top - COACH_GAP - card.height;
  if (placement === "right") left = target.left + target.width + COACH_GAP;
  if (placement === "left") left = target.left - COACH_GAP - card.width;

  left = clamp(
    left,
    COACH_PADDING,
    Math.max(COACH_PADDING, viewport.width - COACH_PADDING - card.width),
  );
  top = clamp(
    top,
    COACH_PADDING,
    Math.max(COACH_PADDING, viewport.height - COACH_PADDING - card.height),
  );

  return {
    left: Math.round(left),
    top: Math.round(top),
    placement,
    spotlight: target,
    arrow: {
      edge: placement,
      x: clamp(centerX - left, 20, Math.max(20, card.width - 20)),
      y: clamp(centerY - top, 20, Math.max(20, card.height - 20)),
    },
  };
}

function centered(
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): CoachGeometry {
  const maxLeft = Math.max(COACH_PADDING, viewport.width - COACH_PADDING - card.width);
  const maxTop = Math.max(COACH_PADDING, viewport.height - COACH_PADDING - card.height);
  return {
    left: Math.round(clamp((viewport.width - card.width) / 2, COACH_PADDING, maxLeft)),
    // 贴视口顶部摆放（顶栏之下）：手势步骤要用户在中下部动手拖，
    // 卡片压在中间正好挡住节点和它的提示面板。
    top: Math.round(clamp(viewport.height * 0.12, COACH_PADDING, maxTop)),
    placement: "center",
    spotlight: null,
    arrow: null,
  };
}

function fits(
  placement: "below" | "above" | "left" | "right",
  target: Rect,
  card: { width: number; height: number },
  viewport: { width: number; height: number },
): boolean {
  if (placement === "below")
    return target.top + target.height + COACH_GAP + card.height <= viewport.height - COACH_PADDING;
  if (placement === "above") return target.top - COACH_GAP - card.height >= COACH_PADDING;
  if (placement === "right")
    return target.left + target.width + COACH_GAP + card.width <= viewport.width - COACH_PADDING;
  return target.left - COACH_GAP - card.width >= COACH_PADDING;
}

/** 都放不下时退而求其次：选空间最大的那一侧，卡片随后会被夹进视口。 */
function best(
  order: readonly ("below" | "above" | "left" | "right")[],
  target: Rect,
  viewport: { width: number; height: number },
): "below" | "above" | "left" | "right" {
  const room = (placement: "below" | "above" | "left" | "right") => {
    if (placement === "below") return viewport.height - (target.top + target.height);
    if (placement === "above") return target.top;
    if (placement === "right") return viewport.width - (target.left + target.width);
    return target.left;
  };
  return [...order].sort((a, b) => room(b) - room(a))[0]!;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
