/**
 * 模型选择器浮层的视口内落位（纯计算，便于单测）。
 *
 * 两个线上问题都是这里算错的直接后果：
 *  - 朝上开时按 `top = 矩形顶 - 限高` 摆放：菜单内容比限高矮就留出一大段空档，
 *    看上去「菜单飘在老远处，不在按钮正上方」。改成写 `bottom`，底边永远距
 *    触发器 8px，高度由内容自己决定。
 *  - 限高用 `Math.max(180, …)` 兜底：可用空间不足 180 时反而比空间大，菜单被
 *    顶出视口，顶部那行分类标签只剩半行。限高必须严格 ≤ 该侧可用空间。
 */

export const MODEL_MENU_GAP = 8;
export const MODEL_MENU_MARGIN = 8;
export const MODEL_MENU_MAX_WIDTH = 560;
export const MODEL_MENU_MAX_HEIGHT = 400;

export type ModelMenuPlacement = {
  left: number;
  width: number;
  maxHeight: number;
  /** 朝上 = 面板底边贴触发器顶边。 */
  above: boolean;
  /** 朝上时是距视口底部的距离，朝下时是距视口顶部的距离。 */
  offset: number;
};

export function computeModelMenuPlacement({
  trigger,
  viewportWidth,
  viewportHeight,
}: {
  trigger: { left: number; top: number; bottom: number };
  viewportWidth: number;
  viewportHeight: number;
}): ModelMenuPlacement {
  const width = Math.min(MODEL_MENU_MAX_WIDTH, viewportWidth - MODEL_MENU_MARGIN * 2);
  const spaceAbove = trigger.top - MODEL_MENU_GAP - MODEL_MENU_MARGIN;
  const spaceBelow = viewportHeight - trigger.bottom - MODEL_MENU_GAP - MODEL_MENU_MARGIN;
  // 空间更多的一侧胜出：生成台/节点面板贴底时，上方通常更宽裕。
  const above = spaceAbove >= spaceBelow;
  // 限高严格取该侧可用空间（不再用「至少 180」兜底）：多一个像素就会把面板
  // 顶出视口，顶部那行分类标签只剩半行。
  const maxHeight = Math.min(MODEL_MENU_MAX_HEIGHT, Math.max(0, above ? spaceAbove : spaceBelow));
  return {
    left: Math.max(
      MODEL_MENU_MARGIN,
      Math.min(trigger.left, viewportWidth - width - MODEL_MENU_MARGIN),
    ),
    width,
    maxHeight,
    above,
    offset: above ? viewportHeight - trigger.top + MODEL_MENU_GAP : trigger.bottom + MODEL_MENU_GAP,
  };
}
