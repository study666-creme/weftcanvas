import { describe, expect, it } from "vitest";

import {
  computeModelMenuPlacement,
  MODEL_MENU_GAP,
  MODEL_MENU_MAX_HEIGHT,
} from "./model-menu-placement";

const VIEWPORT = { viewportWidth: 1440, viewportHeight: 900 };

describe("模型菜单落位", () => {
  it("触发器贴底时朝上开，底边只隔 8px——不按限高留空档", () => {
    const placement = computeModelMenuPlacement({
      ...VIEWPORT,
      trigger: { left: 420, top: 820, bottom: 852 },
    });
    expect(placement.above).toBe(true);
    // 底边到触发器顶边正好一个 gap，与菜单内容多高无关。
    const viewportBottom = VIEWPORT.viewportHeight;
    expect(viewportBottom - placement.offset).toBe(820 - MODEL_MENU_GAP);
  });

  it("触发器在上半屏时朝下开，顶边贴住触发器底边", () => {
    const placement = computeModelMenuPlacement({
      ...VIEWPORT,
      trigger: { left: 120, top: 90, bottom: 122 },
    });
    expect(placement.above).toBe(false);
    expect(placement.offset).toBe(122 + MODEL_MENU_GAP);
  });

  it("限高不超过该侧可用空间：菜单不会被顶出视口、切掉分类标签", () => {
    const placement = computeModelMenuPlacement({
      viewportWidth: 1440,
      viewportHeight: 500,
      trigger: { left: 0, top: 260, bottom: 292 },
    });
    const spaceAbove = 260 - MODEL_MENU_GAP - 8;
    expect(placement.above).toBe(true);
    expect(placement.maxHeight).toBeLessThanOrEqual(spaceAbove);
    // 面板顶边（视口底 - 底边距离 - 限高）仍在视口内。
    const top = 500 - placement.offset - placement.maxHeight;
    expect(top).toBeGreaterThanOrEqual(0);
  });

  it("限高有上限：屏幕再高也不会摊成一整屏", () => {
    const placement = computeModelMenuPlacement({
      trigger: { left: 0, top: 3000, bottom: 3032 },
      viewportWidth: 1440,
      viewportHeight: 3200,
    });
    expect(placement.maxHeight).toBe(MODEL_MENU_MAX_HEIGHT);
  });

  it("左边界越界时夹回视口内", () => {
    const placement = computeModelMenuPlacement({
      ...VIEWPORT,
      trigger: { left: -40, top: 820, bottom: 852 },
    });
    expect(placement.left).toBe(8);
    const right = computeModelMenuPlacement({
      ...VIEWPORT,
      trigger: { left: 1400, top: 820, bottom: 852 },
    });
    expect(right.left).toBe(VIEWPORT.viewportWidth - right.width - 8);
  });
});
