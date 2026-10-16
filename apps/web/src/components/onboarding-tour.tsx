import { ArrowRight, ChevronLeft, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  computeCoachGeometry,
  stepRunsOnRoute,
  ONBOARDING_STEPS,
  type CoachGeometry,
  type OnboardingRoute,
  type Rect,
} from "../lib/onboarding";
import { useCanvasStore } from "../state/canvas-store";
import { useOnboardingStore } from "../state/onboarding-store";
import "./onboarding-tour.css";

/** 卡片量出真实高度前的兜底尺寸（宽度与 CSS 一致，只有高度是估的）。 */
const FALLBACK_CARD_SIZE = { width: 316, height: 196 };
/** 锚点迟迟找不到时的兜底：先把它摆到屏幕中间，用户至少能跳过。 */
const TARGET_MISS_GRACE_MS = 1_600;
/** 高亮环相对锚点外扩的像素：贴着控件边缘，不盖住它。 */
const SPOTLIGHT_PADDING = 6;

type TourRoute = OnboardingRoute;

/**
 * 新手教程的浮层：一处高亮环 + 一张贴着它的说明卡。
 *
 * 教程跨「首屏 → 简易工作台 → 画布」三个路由，所以浮层挂在 App 顶层、portal
 * 到 body，并持续测量锚点的真实矩形——首屏英雄区与画布入场都在动版式，缓存
 * 一次坐标必然错位。浮层本身不吃指针事件（只有卡片吃），用户随时能直接操作被
 * 高亮的控件；对着被教的控件做出动作会推进步骤，而不是被打断。
 */
export function OnboardingTour({
  route,
  canvasBusy = false,
  onEnterCanvas,
  onOpenWorkbench,
}: {
  route: TourRoute;
  canvasBusy?: boolean;
  onEnterCanvas?: () => void;
  onOpenWorkbench?: () => void;
}) {
  const status = useOnboardingStore((state) => state.status);
  const stepIndex = useOnboardingStore((state) => state.stepIndex);
  const next = useOnboardingStore((state) => state.next);
  const back = useOnboardingStore((state) => state.back);
  const finish = useOnboardingStore((state) => state.finish);
  const alignToRoute = useOnboardingStore((state) => state.alignToRoute);
  const step = ONBOARDING_STEPS[stepIndex];
  /** 这一步是否在当前界面里成立（每一步各自属于一个界面）。 */
  const stepOnRoute = step ? stepRunsOnRoute(step, route) : false;
  const advanceOn = step?.advanceOn ?? null;
  const targetSelector = step?.target ?? null;
  const surfaceSelector = step?.surface ?? null;
  const placement = step?.placement ?? "below";

  // 画布入场加载层还没退场时不弹画布步骤：卡片压在建场动画上只会互相打架。
  const active =
    status === "running" && Boolean(step) && stepOnRoute && !(route === "canvas" && canvasBusy);

  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [surfaceReady, setSurfaceReady] = useState(false);
  const [targetMissed, setTargetMissed] = useState(false);
  const [cardSize, setCardSize] = useState(FALLBACK_CARD_SIZE);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const cardRef = useRef<HTMLElement>(null);
  const nodeCount = useCanvasStore((state) => state.nodes.length);
  const nodeBaselineRef = useRef<number | null>(null);

  // 路由切换（首屏 → 工作台 → 画布）后把进度对齐到新路由的第一步。
  useEffect(() => {
    if (status !== "running") return;
    if (route !== "home" && route !== "canvas" && route !== "workbench") return;
    alignToRoute(route);
  }, [alignToRoute, route, status]);

  // 持续跟住锚点：元素会动（英雄区入场、画布建场、窗口缩放、页面滚动），
  // 卡片必须跟着走。这里刻意用定时器而不是 requestAnimationFrame：窗口被遮挡
  // 或后台时浏览器会暂停帧循环（实测 rAF 一秒 0 次，定时器照常跑），只靠 rAF
  // 会让教程在"切走过一会儿再回来"时卡在错误位置。锚点矩形没变就不写状态，
  // 所以每秒 5 次的读取不会带来重渲染。
  useEffect(() => {
    if (!active || !targetSelector || !surfaceSelector) {
      setTargetRect(null);
      setSurfaceReady(false);
      return;
    }
    let element: Element | null = null;
    let lastKey = "";
    const read = () => {
      if (!element || !element.isConnected) {
        element = document.querySelector(targetSelector);
        lastKey = "";
      }
      if (element) {
        setSurfaceReady(true);
        const box = element.getBoundingClientRect();
        const key = [box.left, box.top, box.width, box.height]
          .map((value) => Math.round(value))
          .join(",");
        if (key !== lastKey) {
          lastKey = key;
          setTargetRect({ left: box.left, top: box.top, width: box.width, height: box.height });
        }
      } else {
        // 锚点还没出现：只有在"界面本身已经在场"时才允许走兜底卡片。
        setSurfaceReady(document.querySelector(surfaceSelector) !== null);
      }
      setViewport((current) =>
        current.width === window.innerWidth && current.height === window.innerHeight
          ? current
          : { width: window.innerWidth, height: window.innerHeight },
      );
    };
    read();
    const timer = window.setInterval(read, 200);
    window.addEventListener("resize", read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("resize", read);
    };
  }, [active, surfaceSelector, targetSelector]);

  useEffect(() => {
    if (!active || targetRect || !surfaceReady) {
      setTargetMissed(false);
      return;
    }
    const timer = window.setTimeout(() => setTargetMissed(true), TARGET_MISS_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [active, stepIndex, surfaceReady, targetRect]);

  // 卡片高度随步骤内容变化，量准了再摆。
  //
  // 每次都量（不设依赖）：卡片是"先有几何、后有元素"的——第一步渲染出来时
  // ref 还是 null，只在换步时量就会量到空气，卡片会一直按兜底高度摆。量到
  // 的值没变就不写状态，所以不会来回震荡。样式/字体晚一拍才到位的情况由下面
  // 的补测兜住。
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!card) return;
    const box = card.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    setCardSize((current) =>
      Math.abs(current.width - box.width) < 1 && Math.abs(current.height - box.height) < 1
        ? current
        : { width: box.width, height: box.height },
    );
  });

  // 样式/字体/视口可能晚一拍才到位：补几次定时重测，尺寸一变卡片就自己归位。
  useEffect(() => {
    if (!active) return;
    const measure = () => {
      const card = cardRef.current;
      if (!card) return;
      const box = card.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      setCardSize((current) =>
        Math.abs(current.width - box.width) < 1 && Math.abs(current.height - box.height) < 1
          ? current
          : { width: box.width, height: box.height },
      );
    };
    const settleTimers = [140, 560, 1_300].map((delay) => window.setTimeout(measure, delay));
    return () => settleTimers.forEach((timer) => window.clearTimeout(timer));
  }, [active, stepIndex]);

  // 做出被教的动作即前进：新建了节点。
  useEffect(() => {
    if (!active || advanceOn !== "node-created") {
      nodeBaselineRef.current = null;
      return;
    }
    if (nodeBaselineRef.current === null) {
      nodeBaselineRef.current = nodeCount;
      return;
    }
    if (nodeCount > nodeBaselineRef.current) next();
  }, [active, advanceOn, next, nodeCount]);

  // 做出被教的动作即前进：按住空格拖动了画面。
  useEffect(() => {
    if (!active || advanceOn !== "space-drag") return;
    let held = false;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space") held = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") held = false;
    };
    const onPointerMove = (event: PointerEvent) => {
      if (held && (event.buttons & 1) === 1) next();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointermove", onPointerMove);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointermove", onPointerMove);
    };
  }, [active, advanceOn, next]);

  // 做出被教的动作即前进：按住 Ctrl / ⌘ 滚了滚轮。
  useEffect(() => {
    if (!active || advanceOn !== "wheel-zoom") return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) next();
    };
    window.addEventListener("wheel", onWheel, { passive: true, capture: true });
    return () => window.removeEventListener("wheel", onWheel, true);
  }, [active, advanceOn, next]);

  if (!active || !step) return null;
  // 锚点还没出现就先不画：宁可晚半拍出现，也不要先摆中间再跳过去。
  if (!targetRect && placement !== "center" && !(surfaceReady && targetMissed)) return null;

  const geometry: CoachGeometry = computeCoachGeometry({
    target: targetRect,
    card: cardSize,
    viewport,
    preferred: placement,
  });
  const isLast = stepIndex === ONBOARDING_STEPS.length - 1;
  // 只有上一步和当前步在同一个界面上时才给「上一步」：跨路由回退会被路由对齐
  // 立刻拽回来（首屏 → 画布是回不去的），按钮点了没反应比没有按钮更糟。
  const previousStep = ONBOARDING_STEPS[stepIndex - 1];
  const canGoBack = Boolean(
    previousStep && step && stepRunsOnRoute(previousStep, route) && stepOnRoute,
  );
  const primaryLabel = step.primaryLabel ?? (isLast ? "完成" : "下一步");
  const runPrimary = () => {
    if (step.action === "enter-canvas") {
      onEnterCanvas?.();
      return;
    }
    if (step.action === "goto-workbench") {
      onOpenWorkbench?.();
      return;
    }
    next();
  };

  return createPortal(
    <>
      {geometry.spotlight ? (
        <span
          aria-hidden="true"
          className="wc-tour-spotlight"
          data-dim={route === "canvas" ? "soft" : "strong"}
          style={{
            left: geometry.spotlight.left - SPOTLIGHT_PADDING,
            top: geometry.spotlight.top - SPOTLIGHT_PADDING,
            width: geometry.spotlight.width + SPOTLIGHT_PADDING * 2,
            height: geometry.spotlight.height + SPOTLIGHT_PADDING * 2,
          }}
        />
      ) : null}
      <aside
        ref={cardRef}
        className="wc-tour-card"
        role="note"
        aria-live="polite"
        aria-label="新手教程"
        data-placement={geometry.placement}
        data-step={step.id}
        style={{ left: geometry.left, top: geometry.top }}
      >
        {geometry.arrow ? (
          <span
            aria-hidden="true"
            className="wc-tour-arrow"
            data-edge={geometry.arrow.edge}
            style={
              geometry.arrow.edge === "below" || geometry.arrow.edge === "above"
                ? { left: geometry.arrow.x }
                : { top: geometry.arrow.y }
            }
          />
        ) : null}
        <header className="wc-tour-head">
          <span className="wc-tour-kicker">
            新手教程 · {stepIndex + 1}/{ONBOARDING_STEPS.length}
          </span>
          <button
            type="button"
            className="wc-tour-close"
            aria-label="跳过新手教程"
            title="跳过"
            onClick={finish}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <strong className="wc-tour-title">{step.title}</strong>
        <p className="wc-tour-body">{step.body}</p>
        {step.keys?.length ? (
          <span className="wc-tour-keys">
            {step.keys.map((key) => (
              <kbd key={key}>{key}</kbd>
            ))}
          </span>
        ) : null}
        <footer className="wc-tour-foot">
          <span className="wc-tour-progress" aria-hidden="true">
            {ONBOARDING_STEPS.map((item, index) => (
              <i key={item.id} className={index === stepIndex ? "is-active" : undefined} />
            ))}
          </span>
          {canGoBack ? (
            <button type="button" className="wc-tour-back" onClick={back}>
              <ChevronLeft aria-hidden="true" />
              上一步
            </button>
          ) : (
            <button type="button" className="wc-tour-skip" onClick={finish}>
              跳过
            </button>
          )}
          <button type="button" className="wc-tour-next" onClick={runPrimary}>
            {primaryLabel}
            <ArrowRight aria-hidden="true" />
          </button>
        </footer>
      </aside>
    </>,
    document.body,
  );
}
