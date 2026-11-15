/**
 * 动效是否应当「立即完成」。
 *
 * index.html 的引导脚本在首帧前就把设备能力落成 data-wc-motion（低核数 /
 * 低内存 / 省流设备给 lite），系统级 prefers-reduced-motion 同样算静默。
 *
 * 只有一类动效必须走 JS 判定：**先播退场再卸载**的浮层。CSS 里 lite 档可以
 * 把 animation 归零，但组件的卸载定时器仍然会等满退场时长——用户看到的是
 * 「点了关闭，界面愣 150ms 才消失」。凡是自己拿捏卸载时序的地方都先问这里。
 */
export const EXIT_FADE_MS = 150;

export function prefersInstantMotion(): boolean {
  if (typeof document === "undefined") return true;
  if (document.documentElement.dataset.wcMotion === "lite") return true;
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
