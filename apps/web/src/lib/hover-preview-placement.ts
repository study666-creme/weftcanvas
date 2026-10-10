/**
 * 卡片悬浮大图的定位计算（无 React 依赖，便于单测与独立校验）。
 *
 * 规则：贴着鼠标右侧出现，右侧放不下就翻到左侧，整体始终被约束在视口内；
 * 高图按可用高度等比缩小，因此不会有一部分掉到浏览器外面。
 */

/** 鼠标与浮层之间的空隙。 */
export const HOVER_CURSOR_GAP = 16;
/** 浮层与视口边缘的最小距离。 */
export const HOVER_VIEWPORT_PADDING = 12;
const MAX_WIDTH = 460;
const MIN_WIDTH = 180;
/** 最高不超过视口高度的这个比例。 */
const MAX_HEIGHT_RATIO = 0.82;
/** 浮层内边距 + 边框的固定占用。 */
const CHROME_WIDTH = 22;
const CHROME_HEIGHT = 22;
/** 标题行高度（含与图片之间的 8px 间距）。 */
const CAPTION_BLOCK_HEIGHT = 30;
/** 图片允许被压到的最小高度，避免极端视口下算成 0。 */
const MIN_IMAGE_HEIGHT = 96;

export type HoverPreviewPlacement = {
  left: number;
  top: number;
  width: number;
  /** 按图片宽高比算出的浮层高度（已含内边距与标题行）。 */
  height: number;
  /** 浮层高度上限：图片宽高比与假设不符时也不会长出视口。 */
  maxHeight: number;
};

export type HoverPreviewPlacementInput = {
  anchor: { x: number; y: number };
  viewport: { width: number; height: number };
  /** naturalWidth / naturalHeight，未知时传 1。 */
  aspect: number;
  hasCaption: boolean;
};

export function computeHoverPreviewPlacement(input: HoverPreviewPlacementInput): HoverPreviewPlacement {
  const { anchor, viewport } = input;
  const aspect = Number.isFinite(input.aspect) && input.aspect > 0 ? input.aspect : 1;
  const chromeHeight = CHROME_HEIGHT + (input.hasCaption ? CAPTION_BLOCK_HEIGHT : 0);

  // 纵向上限：视口的 82%，且上下各留出 padding。
  const maxHeight = Math.max(
    MIN_IMAGE_HEIGHT + chromeHeight,
    Math.min(viewport.height * MAX_HEIGHT_RATIO, viewport.height - HOVER_VIEWPORT_PADDING * 2),
  );
  const maxImageHeight = Math.max(MIN_IMAGE_HEIGHT, maxHeight - chromeHeight);

  // 横向：优先放鼠标右侧，那一侧太窄才翻到左边。
  const roomRight = viewport.width - anchor.x - HOVER_CURSOR_GAP - HOVER_VIEWPORT_PADDING;
  const roomLeft = anchor.x - HOVER_CURSOR_GAP - HOVER_VIEWPORT_PADDING;
  const flip = roomRight < MIN_WIDTH && roomLeft > roomRight;
  const room = Math.max(0, flip ? roomLeft : roomRight);
  let width = Math.max(80, Math.min(MAX_WIDTH, room));

  // 高图先按高度上限等比缩窄；收窄是安全方向，宽度不会因此重新超出可用空间。
  let imageHeight = (width - CHROME_WIDTH) / aspect;
  if (imageHeight > maxImageHeight) {
    imageHeight = maxImageHeight;
    width = Math.max(80, Math.min(room || MAX_WIDTH, imageHeight * aspect + CHROME_WIDTH));
    imageHeight = Math.max(1, (width - CHROME_WIDTH) / aspect);
  }
  const height = imageHeight + chromeHeight;

  // 先取整再夹取，保证 left + width 与 top + height 精确落在视口内（不留半像素尾巴）。
  const roundedWidth = Math.round(width);
  const roundedHeight = Math.round(height);
  const maxLeft = Math.max(HOVER_VIEWPORT_PADDING, viewport.width - HOVER_VIEWPORT_PADDING - roundedWidth);
  const maxTop = Math.max(HOVER_VIEWPORT_PADDING, viewport.height - HOVER_VIEWPORT_PADDING - roundedHeight);
  const left = clamp(
    flip ? anchor.x - HOVER_CURSOR_GAP - roundedWidth : anchor.x + HOVER_CURSOR_GAP,
    HOVER_VIEWPORT_PADDING,
    maxLeft,
  );
  const top = clamp(anchor.y - roundedHeight / 2, HOVER_VIEWPORT_PADDING, maxTop);

  return {
    left: Math.round(left),
    top: Math.round(top),
    width: roundedWidth,
    height: roundedHeight,
    maxHeight: Math.round(maxHeight),
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
