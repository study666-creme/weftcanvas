import { describe, expect, it } from "vitest";

import {
  computeCoachGeometry,
  COACH_GAP,
  firstStepIndexForRoute,
  isOnboardingDoneValue,
  normalizeStepIndex,
  ONBOARDING_STEPS,
} from "./onboarding";

const VIEWPORT = { width: 1440, height: 900 };
const CARD = { width: 316, height: 196 };

describe("新手教程步骤表", () => {
  it("按「生成工作台 → 画布」的顺序推进，步骤 id 唯一", () => {
    const ids = ONBOARDING_STEPS.map((step) => step.id);
    expect(new Set(ids).size).toBe(ids.length);
    // 前两步在入口首屏与生成工作台上都成立（各挂一份同名锚点），之后整段都在画布里。
    expect(ONBOARDING_STEPS[0]!.routes).toContain("home");
    expect(ONBOARDING_STEPS[0]!.routes).toContain("workbench");
    expect(ONBOARDING_STEPS[1]!.routes).toContain("workbench");
    const firstCanvas = ONBOARDING_STEPS.findIndex((step) => step.routes.includes("canvas"));
    expect(firstCanvas).toBeGreaterThan(0);
    expect(
      ONBOARDING_STEPS.slice(firstCanvas).every((step) => step.routes.includes("canvas")),
    ).toBe(true);
    // 从工作台进来的访客也是从第 0 步起步：前两步就长在工作台上。
    expect(firstStepIndexForRoute("workbench")).toBe(0);
  });

  it("教的是需求里那三件事：创建节点、空格平移、Ctrl 缩放", () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      "workbench",
      "enter-canvas",
      "create-node",
      "space-pan",
      "ctrl-zoom",
    ]);
    const pan = ONBOARDING_STEPS.find((step) => step.id === "space-pan")!;
    expect(pan.keys).toContain("Space");
    const zoom = ONBOARDING_STEPS.find((step) => step.id === "ctrl-zoom")!;
    expect(zoom.keys).toContain("Ctrl / ⌘");
    expect(ONBOARDING_STEPS.find((step) => step.id === "create-node")!.advanceOn).toBe(
      "node-created",
    );
  });

  it("每个步骤都有锚点与文案，画布步骤都挂在画布路由上", () => {
    for (const step of ONBOARDING_STEPS) {
      expect(step.target.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
    }
    expect(firstStepIndexForRoute("home")).toBe(0);
    expect(firstStepIndexForRoute("canvas")).toBe(2);
  });

  it("存档只认显式的 done，脏值一律回落未看过", () => {
    expect(isOnboardingDoneValue("done")).toBe(true);
    expect(isOnboardingDoneValue("1")).toBe(false);
    expect(isOnboardingDoneValue(null)).toBe(false);
    expect(isOnboardingDoneValue(undefined)).toBe(false);
  });

  it("步骤下标越界一律回落第一步", () => {
    expect(normalizeStepIndex(2)).toBe(2);
    expect(normalizeStepIndex(-1)).toBe(0);
    expect(normalizeStepIndex(99)).toBe(0);
    expect(normalizeStepIndex(1.5)).toBe(0);
    expect(normalizeStepIndex("3")).toBe(0);
    expect(normalizeStepIndex(null)).toBe(0);
  });
});

describe("卡片落位", () => {
  const target = { left: 560, top: 400, width: 320, height: 120 };

  it("放得下就用期望方位，箭头贴着卡片指向锚点中心", () => {
    const geometry = computeCoachGeometry({
      target,
      card: CARD,
      viewport: VIEWPORT,
      preferred: "below",
    });

    expect(geometry.placement).toBe("below");
    expect(geometry.top).toBe(target.top + target.height + COACH_GAP);
    // 卡片与锚点同一竖中线。
    expect(geometry.left + CARD.width / 2).toBe(target.left + target.width / 2);
    expect(geometry.spotlight).toEqual(target);
    expect(geometry.arrow?.edge).toBe("below");
    expect(geometry.arrow?.x).toBe(CARD.width / 2);
  });

  it("下面放不下就翻到上面，卡片仍完整落在视口内", () => {
    const geometry = computeCoachGeometry({
      target: { left: 560, top: 720, width: 320, height: 140 },
      card: CARD,
      viewport: VIEWPORT,
      preferred: "below",
    });

    expect(geometry.placement).toBe("above");
    expect(geometry.top).toBeGreaterThanOrEqual(12);
    expect(geometry.top + CARD.height).toBeLessThanOrEqual(VIEWPORT.height - 12);
  });

  it("四个方向都放不下时，卡片被夹进视口而不是露到屏幕外", () => {
    const geometry = computeCoachGeometry({
      target: { left: 150, top: 150, width: 200, height: 100 },
      card: CARD,
      viewport: { width: 500, height: 400 },
      preferred: "below",
    });

    expect(geometry.left).toBeGreaterThanOrEqual(12);
    expect(geometry.left + CARD.width).toBeLessThanOrEqual(500 - 12);
    expect(geometry.top).toBeGreaterThanOrEqual(12);
    expect(geometry.top + CARD.height).toBeLessThanOrEqual(400 - 12);
  });

  it("整屏锚点不画高亮环，只留居中提示", () => {
    const geometry = computeCoachGeometry({
      target: { left: 0, top: 0, width: VIEWPORT.width, height: VIEWPORT.height },
      card: CARD,
      viewport: VIEWPORT,
      preferred: "below",
    });

    expect(geometry.spotlight).toBeNull();
    expect(geometry.arrow).toBeNull();
    expect(geometry.placement).toBe("center");
    // 提示卡贴顶部（顶栏之下）：手势要在中下部动手，卡片不能压在中间。
    expect(geometry.top).toBe(Math.round(VIEWPORT.height * 0.12));
    expect(geometry.left + CARD.width / 2).toBe(VIEWPORT.width / 2);
  });

  it("锚点还没量到也能给出可用的居中卡片", () => {
    const geometry = computeCoachGeometry({
      target: null,
      card: CARD,
      viewport: VIEWPORT,
      preferred: "below",
    });
    expect(geometry.spotlight).toBeNull();
    expect(geometry.left + CARD.width / 2).toBe(VIEWPORT.width / 2);
  });

  it("窄视口下卡片宽度被夹到可用宽度，不会横向溢出", () => {
    const geometry = computeCoachGeometry({
      target: null,
      card: CARD,
      viewport: { width: 320, height: 720 },
      preferred: "below",
    });
    expect(geometry.left).toBe(12);
  });
});
