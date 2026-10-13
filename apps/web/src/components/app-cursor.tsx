import { Hand, HandGrab } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// 组件自带样式：AppCursor 挂在 App 顶层、全路由共享，不能依赖工作区懒加载的
// workbench-styles 才存在（那样首屏/登录页只有光标逻辑没有光标样式）。
import "../app-cursor.css";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import { useCursorInteractionStore } from "../state/cursor-interaction-store";

type CursorMode = "default" | "link" | "drag" | "pan" | "text" | "native";

const DRAG_TARGETS = [
  "[data-wc-cursor='drag']",
  ".wc-node-drag-strip",
  ".wc-node-type-label",
  ".wc-node-text-preview",
  ".wc-media-empty--passive",
  ".wc-node-media-frame",
  ".wc-audio-wave",
  ".wc-group-frame-header",
  ".wc-director-canvas",
  "input[type='range']",
  "[class*='cursor-grab']",
  "[class*='cursor-grabbing']",
  "[class*='cursor-move']",
  "[class*='cursor-crosshair']",
  "[class*='cursor-ew-resize']",
  "[class*='cursor-ns-resize']",
  "[class*='cursor-col-resize']",
  "[class*='cursor-row-resize']",
  "[class*='cursor-nwse-resize']",
  "[class*='cursor-nesw-resize']",
].join(",");

const LINK_TARGETS = [
  "button:not(:disabled)",
  "a[href]",
  "summary",
  "select:not(:disabled)",
  "[role='button']:not([aria-disabled='true'])",
  ".react-flow__handle",
  "[data-canvas-interactive]",
].join(",");

function cursorModeFromTarget(target: EventTarget | null): CursorMode {
  if (!(target instanceof Element)) return "default";
  if (target.closest("audio, [data-wc-native-cursor]")) return "native";
  if (
    target.closest(
      "input:not([type='range']):not([type='checkbox']):not([type='radio']), textarea, [contenteditable]:not([contenteditable='false']), [role='textbox']",
    )
  )
    return "text";
  const label = target.closest("label");
  if (label?.querySelector("input:not(:disabled), select:not(:disabled), textarea:not(:disabled)"))
    return "link";
  if (target.closest(LINK_TARGETS)) return "link";
  if (target.closest(DRAG_TARGETS)) return "drag";
  return "default";
}

function applyMode(root: HTMLElement, mode: CursorMode) {
  for (const name of ["link", "drag", "pan", "text", "native"]) {
    root.classList.toggle(`is-${name}`, mode === name);
  }
}

function isFinePointerEvent(event: PointerEvent) {
  return !event.pointerType || event.pointerType === "mouse" || event.pointerType === "pen";
}

export const AppCursor = memo(function AppCursor() {
  const cursorStyle = useUiPreferencesStore((state) => state.cursorStyle);
  const panActive = useCursorInteractionStore((state) => state.panActive);
  const rootRef = useRef<HTMLDivElement>(null);
  const pointerRef = useRef<HTMLDivElement>(null);
  const panActiveRef = useRef(panActive);
  const syncModeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    panActiveRef.current = panActive;
    syncModeRef.current?.();
  }, [panActive]);

  useEffect(() => {
    const root = rootRef.current;
    const pointer = pointerRef.current;
    if (!root || !pointer) return;

    let lastTarget: EventTarget | null = null;
    let currentMode: CursorMode = "default";
    let pointerDown = false;
    let pointerInsideCanvas = false;
    let visible = false;

    // 原生光标只在自绘光标真的画出来之后才隐藏。挂载即隐藏会让"还没移动鼠标"
    // 的那段时间屏幕上没有光标——观感就是"光标不见了/发黏"，这是自绘光标最
    // 容易被误判成卡顿的一处。
    const show = () => {
      document.documentElement.classList.add("has-wc-cursor");
      if (visible) return;
      visible = true;
      root.classList.add("is-visible");
    };
    const hide = () => {
      document.documentElement.classList.remove("has-wc-cursor");
      if (!visible) return;
      visible = false;
      root.classList.remove("is-visible");
    };
    const setMode = (mode: CursorMode) => {
      if (mode === currentMode) return;
      currentMode = mode;
      applyMode(root, mode);
    };
    const syncMode = () => {
      const panning = panActiveRef.current && pointerInsideCanvas;
      setMode(panning ? "pan" : cursorModeFromTarget(lastTarget));
      root.classList.toggle("is-pan-grabbing", panning && pointerDown);
    };
    syncModeRef.current = syncMode;

    // 位置写入合并到每帧一次。一帧内可能收到几十条指针事件（高刷鼠标 + coalesced
    // 采样能到上千 Hz），每条都写 transform 就是让主线程在这个高频回调里排队——
    // 这正是「光标追不上手」的来源。写入合并后，一帧只有一次合成器属性更新。
    let pendingX = 0;
    let pendingY = 0;
    let frame = 0;
    const flushPosition = () => {
      frame = 0;
      pointer.style.transform = `translate3d(${pendingX - 4}px, ${pendingY - 3}px, 0)`;
    };
    const queuePosition = (event: PointerEvent) => {
      const samples = event.getCoalescedEvents?.() ?? [];
      const latest = samples.at(-1) ?? event;
      pendingX = latest.clientX;
      pendingY = latest.clientY;
      if (!frame) frame = window.requestAnimationFrame(flushPosition);
    };

    // Chromium 的 pointerrawupdate 拿得到不受显示刷新节流的高频样本，比
    // pointermove 更早、更密，是"跟手"的关键；其它内核继续走 pointermove。
    // （事件名不在标准 DOM 类型里，所以按 Event 收再收窄。）
    const supportsRawUpdate = "onpointerrawupdate" in window;
    const rawMove = (event: Event) => {
      const pointer = event as PointerEvent;
      if (!isFinePointerEvent(pointer)) return;
      queuePosition(pointer);
    };

    const move = (event: PointerEvent) => {
      if (!isFinePointerEvent(event)) return;
      queuePosition(event);
      if (lastTarget !== event.target) {
        const nextInsideCanvas =
          event.target instanceof Element && Boolean(event.target.closest(".react-flow"));
        if (!pointerDown || nextInsideCanvas) pointerInsideCanvas = nextInsideCanvas;
        lastTarget = event.target;
        syncMode();
      }
      show();
    };
    const down = (event: PointerEvent) => {
      if (!isFinePointerEvent(event)) return;
      lastTarget = event.target;
      pointerInsideCanvas =
        event.target instanceof Element && Boolean(event.target.closest(".react-flow"));
      pointerDown = true;
      root.classList.add("is-down");
      syncMode();
      show();
    };
    const release = (event?: PointerEvent) => {
      if (event && !isFinePointerEvent(event)) return;
      if (event) lastTarget = event.target;
      if (event)
        pointerInsideCanvas =
          event.target instanceof Element && Boolean(event.target.closest(".react-flow"));
      pointerDown = false;
      root.classList.remove("is-down", "is-pan-grabbing");
      syncMode();
    };
    const reset = () => {
      release();
      hide();
    };
    const visibilityChanged = () => {
      if (document.visibilityState !== "visible") reset();
    };

    if (supportsRawUpdate) window.addEventListener("pointerrawupdate", rawMove, { passive: true });
    window.addEventListener("pointermove", move, { passive: true });
    window.addEventListener("pointerdown", down, { passive: true });
    window.addEventListener("pointerup", release, { passive: true });
    window.addEventListener("pointercancel", release, { passive: true });
    window.addEventListener("blur", reset);
    document.addEventListener("mouseleave", hide);
    document.addEventListener("mouseenter", show);
    document.addEventListener("visibilitychange", visibilityChanged);

    return () => {
      syncModeRef.current = null;
      if (frame) window.cancelAnimationFrame(frame);
      document.documentElement.classList.remove("has-wc-cursor");
      if (supportsRawUpdate) window.removeEventListener("pointerrawupdate", rawMove);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
      window.removeEventListener("blur", reset);
      document.removeEventListener("mouseleave", hide);
      document.removeEventListener("mouseenter", show);
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, []);

  return createPortal(
    <div
      ref={rootRef}
      className={`wc-app-cursor wc-app-cursor--${cursorStyle}`}
      data-testid="app-cursor"
      aria-hidden="true"
    >
      <div ref={pointerRef} className="wc-app-cursor-pointer">
        <svg className="wc-app-cursor-arrow" viewBox="0 0 28 32" focusable="false">
          <path
            className="wc-app-cursor-arrow-shell"
            d="M4.3 3.1 23.2 18.4l-8.1 1.1-4.4 8.8L4.3 3.1Z"
          />
          <path className="wc-app-cursor-arrow-core" d="M6.9 8.1 18 17.1l-5.1.7-2.8 5.7L6.9 8.1Z" />
        </svg>
        <Hand className="wc-app-cursor-hand wc-app-cursor-hand--classic" strokeWidth={1.9} />
        <HandGrab className="wc-app-cursor-hand wc-app-cursor-hand--precision" strokeWidth={1.8} />
        <span className="wc-app-cursor-textbar" />
        <span className="wc-app-cursor-precision" />
      </div>
    </div>,
    document.body,
  );
});
