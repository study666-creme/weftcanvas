/**
 * 自绘光标的位置换算。
 *
 * 背景：Chromium 把 `pointerrawupdate` 派发进**跨源 iframe**（OOPIF）时不做
 * 坐标本地化 —— 事件里的 `clientX/clientY` 带的是*顶层页面*的坐标，而不是本帧
 * 视口坐标；`pointermove` 则是本地化的。实测（iframe 原点 260,56、页面点
 * 700,300）：pointermove 收到 440,244，pointerrawupdate 收到 700,300。
 *
 * 画布内嵌在 `/canvas` 时，自绘光标只认 raw 事件，于是整体被推偏一个「侧栏宽
 * + 顶栏高」，用户看到的就是「鼠标显示和实际位置对不上，指针出画布」。
 *
 * `screenX/screenY` 不受这个缺陷影响（两种事件里都是同一个屏幕坐标系），所以
 * 内嵌时用「screenX − clientX」这个平移量把 raw 坐标折回本帧坐标系。平移量
 * 从同一指针流里已被本地化的 pointermove/pointerdown 上学，窗口移动或缩放后
 * 下一次移动会自然重新学到。
 */

export type CursorPoint = { x: number; y: number };

type ScreenAndClient = {
  screenX: number;
  screenY: number;
  clientX: number;
  clientY: number;
};

/** 当前文档是否被嵌在 iframe 里（跨源时访问 top 的成员会抛，但比较引用是允许的）。 */
export function isFramedDocument(win: Pick<Window, "self" | "top">): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/** 从已被本地化的事件上学到「screen 坐标 → 本帧 client 坐标」的平移量。 */
export function screenToClientOffset(event: ScreenAndClient): CursorPoint | null {
  const x = event.screenX - event.clientX;
  const y = event.screenY - event.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

/** 把 raw 事件的 screen 坐标折回本帧 client 坐标；平移量未知时返回 null（交给 pointermove）。 */
export function localPointerFromScreen(
  event: Pick<ScreenAndClient, "screenX" | "screenY">,
  offset: CursorPoint | null,
): CursorPoint | null {
  if (!offset) return null;
  if (!Number.isFinite(event.screenX) || !Number.isFinite(event.screenY)) return null;
  return { x: event.screenX - offset.x, y: event.screenY - offset.y };
}
