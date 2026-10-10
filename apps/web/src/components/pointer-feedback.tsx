import { useEffect, useRef } from "react";

/**
 * 指针反馈。
 *
 * 这里刻意不再自绘光标。之前的做法是隐藏系统光标、用一个 DOM 元素逐帧跟随，
 * 无论怎么优化（去掉滤镜、把写入挪进事件回调）都至少慢一帧，而人眼对"光标不
 * 跟手"极其敏感，观感就是发黏、延迟高。
 *
 * 现在保留原生光标（硬件合成，零延迟），只在指针**进入可交互元素**和**按下**
 * 的瞬间，于该点放一个一次性扩散环。它不跟随、不逐帧更新，所以既给出"这个东
 * 西可以点"的设计感反馈，又不可能产生延迟。
 */
const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "[role='button']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='option']",
  ".react-flow__node",
  ".react-flow__edge",
  ".react-flow__handle",
  ".kc-clip",
  ".kc-clip-asset-row",
].join(",");

const RING_DURATION_MS = 320;

export function PointerFeedback() {
  const ringRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const ring = ringRef.current;
    if (!ring) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let lastTarget: Element | null = null;
    let hideFrame: number | null = null;

    // 变体名即 CSS 类名：样式表认的是 .is-enter / .is-press，
    // 之前传 "enter" 导致扩散环从来没被触发过。
    const pulse = (x: number, y: number, variant: "is-enter" | "is-press") => {
      if (hideFrame !== null) window.clearTimeout(hideFrame);
      ring.classList.remove("is-enter", "is-press");
      // 重启动画需要一次强制回流；这里每帧最多一次，且只在悬停切换时发生。
      void ring.offsetWidth;
      ring.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      ring.classList.add(variant);
      hideFrame = window.setTimeout(() => {
        ring.classList.remove("is-enter", "is-press");
        hideFrame = null;
      }, RING_DURATION_MS);
    };

    const over = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest(INTERACTIVE_SELECTOR) : null;
      if (!target || target === lastTarget) return;
      lastTarget = target;
      pulse(event.clientX, event.clientY, "is-enter");
    };

    const down = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target.closest(INTERACTIVE_SELECTOR) : null;
      if (!target) return;
      pulse(event.clientX, event.clientY, "is-press");
    };

    const leave = () => {
      lastTarget = null;
    };

    window.addEventListener("pointerover", over, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    document.addEventListener("mouseleave", leave, { passive: true });
    return () => {
      window.removeEventListener("pointerover", over);
      window.removeEventListener("pointerdown", down);
      document.removeEventListener("mouseleave", leave);
      if (hideFrame !== null) window.clearTimeout(hideFrame);
    };
  }, []);

  return (
    <span ref={ringRef} className="kc-pointer-pulse" data-testid="pointer-pulse" aria-hidden="true">
      <span className="kc-pointer-pulse-ring" />
    </span>
  );
}
