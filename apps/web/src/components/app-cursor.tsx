import { Hand, HandGrab } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// 组件自带样式：AppCursor 挂在 App 顶层、全路由共享，不能依赖工作区懒加载的
// workbench-styles 才存在（那样首屏/登录页只有光标逻辑没有光标样式）。
import "../app-cursor.css";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import { useCursorInteractionStore } from "../state/cursor-interaction-store";
import {
  isFramedDocument,
  localPointerFromScreen,
  screenToClientOffset,
  type CursorPoint,
} from "../lib/cursor-pointer-mapping";

type CursorMode = "default" | "link" | "drag" | "pan" | "text" | "native";

const DRAG_TARGETS = [
  "[data-wc-cursor='drag']",
  ".wc-node-drag-strip",
  ".wc-node-text-preview",
  ".wc-media-empty--passive",
  ".wc-node-media-frame",
  ".wc-audio-wave",
  ".wc-group-frame",
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

    // 位置写入合并到每帧一次（pointermove 回退路径）。一帧内可能收到几十条指针
    // 事件（高刷鼠标 + coalesced 采样能到上千 Hz），每条都写 transform 就是让
    // 主线程在这个高频回调里排队。写入合并后，一帧只有一次合成器属性更新。
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
    // pointermove 更早、更密。这里直写 transform 而不是排进 rAF：rawupdate
    // 在浏览器把它交给当前帧的样式阶段前触发，直写能让位置赶上一个 rAF 节拍，
    // 也就是自绘光标最容易背锅的那「慢一帧」。非 Chromium 内核没有这个事件，
    // 继续走上面的 rAF 合并路径。
    const supportsRawUpdate = "onpointerrawupdate" in window;
    // 内嵌在 /canvas（跨源 iframe）时，raw 事件的 clientX/clientY 是**顶层页面**
    // 坐标而不是本帧坐标，直接用会把光标整体推偏一个「侧栏宽 + 顶栏高」——用户
    // 反馈的「鼠标和实际位置对不上、指针直接出画布」就是这个。所以内嵌时改用
    // screen 坐标折算（见 lib/cursor-pointer-mapping）。顶层文档保持原路径不变，
    // 避免为各浏览器 screenX 单位差异引入回归。
    const framed = isFramedDocument(window);
    let screenOffset: CursorPoint | null = null;
    const learnScreenOffset = (event: PointerEvent) => {
      if (!framed) return;
      const next = screenToClientOffset(event);
      if (next) screenOffset = next;
    };
    const rawPoint = (event: PointerEvent): CursorPoint | null =>
      framed ? localPointerFromScreen(event, screenOffset) : { x: event.clientX, y: event.clientY };
    const rawMove = (event: Event) => {
      const raw = event as PointerEvent;
      if (!isFinePointerEvent(raw)) return;
      const samples = raw.getCoalescedEvents?.() ?? [];
      const latest = samples.at(-1) ?? raw;
      const point = rawPoint(latest);
      if (!point) return;
      pointer.style.transform = `translate3d(${point.x - 4}px, ${point.y - 3}px, 0)`;
    };

    const move = (event: PointerEvent) => {
      if (!isFinePointerEvent(event)) return;
      learnScreenOffset(event);
      // 有 rawupdate 时位置只由它写：pointermove 是按帧对齐的旧样本，再排一次
      // rAF 写入会在同一帧里把更新的 raw 位置盖回去，光标就会往回跳一下。
      // 内嵌且还没学到平移量时例外：那时 raw 坐标不可用，先用本地化的
      // pointermove 兜住，避免第一下移动光标不动。
      if (!supportsRawUpdate || (framed && !screenOffset)) queuePosition(event);
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
      learnScreenOffset(event);
      // 没移动过就直接点（页面刚加载）时也要把光标画到按下的位置，否则会停在
      // 左上角一帧。
      pointer.style.transform = `translate3d(${event.clientX - 4}px, ${event.clientY - 3}px, 0)`;
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
