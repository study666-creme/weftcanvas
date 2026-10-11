import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { useAgentStore } from "../state/agent-store";
import { useCanvasStore } from "../state/canvas-store";
import { useUiPreferencesStore, type CompanionDock, type CompanionStyle } from "../state/ui-preferences-store";
import {
  DOCK_Z_STEP,
  clampPlacement,
  findDockTargetAt,
  resolveCompanionPlacement,
  shouldResetToDefault,
  type Placement,
} from "./companion-placement";
import {
  resolveWhaleMode,
  WhaleGirlCompanion,
  whaleDockedLine,
  whaleDraggedLine,
  whalePeekLine,
  whaleGreetingLine,
  whaleStyleSwitchLine,
  type WhaleLine,
  type WhalePose,
} from "./whale-girl-companion";

// three.js 约 526KB（gzip 后 ~130KB），只有选择机器人伙伴样式才会渲染 3D 头像；
// 懒加载后默认形象（鲸鱼娘 / 小熊）用户不再为画布首屏付出这笔下载与解析成本。
const AgentCompanion3D = lazy(async () => ({ default: (await import("./agent-companion-3d")).AgentCompanion3D }));

type CompanionReaction = "idle" | "curious" | "celebrate" | "concerned" | "thinking" | "listening";

/** 双击 / 面板按钮按这个顺序轮换伙伴形象：鲸鱼娘（默认）→ 小熊 → 3D 机器人。 */
const COMPANION_CYCLE: CompanionStyle[] = ["whale", "bear", "robot"];
export const nextCompanionStyle = (style: CompanionStyle): CompanionStyle =>
  COMPANION_CYCLE[(COMPANION_CYCLE.indexOf(style) + 1) % COMPANION_CYCLE.length] ?? "whale";

export const companionStyleLabel = (style: CompanionStyle) => {
  if (style === "whale") return "鲸鱼娘";
  return style === "bear" ? "小熊" : "3D 机器人";
};

/** 拖多远算「拖拽」而不是「点击」。 */
const DRAG_THRESHOLD = 5;
/** 全身档 sprite 的显示高度，和 whale-girl-companion.css 的 --whale-w * 1.3333 是一对。 */
const WHALE_BODY_PX = 68 * 1.3333;

export const AgentCompanion = memo(function AgentCompanion({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const nodeCount = useCanvasStore((state) => state.nodes.length);
  // 选择器在每次 store 更新时都会执行（拖拽期间每帧一次）。计数而不 filter，
  // 避免每帧为整份 nodes 再分配一个临时数组。
  const selectedCount = useCanvasStore((state) => {
    let count = 0;
    for (const node of state.nodes) if (node.selected) count += 1;
    return count;
  });
  const agentStatus = useAgentStore((state) => state.status);
  const latestRun = useAgentStore((state) => state.detail?.latestRun ?? null);
  const [momentaryReaction, setMomentaryReaction] = useState<CompanionReaction>("idle");
  const previousNodeCount = useRef(nodeCount);

  // 用户专心创作的信号：30 秒内改过画布（加/删节点）就让她闭嘴，
  // 事件反馈（庆祝/炸毛）照常，只有自言自语被掐掉。
  const [recentlyTouched, setRecentlyTouched] = useState(false);
  useEffect(() => {
    const previous = previousNodeCount.current;
    previousNodeCount.current = nodeCount;
    if (nodeCount === previous) return;

    setRecentlyTouched(true);
    setMomentaryReaction(nodeCount > previous ? "celebrate" : "concerned");
    const reactionTimeout = window.setTimeout(() => setMomentaryReaction("idle"), 1_250);
    const quietTimeout = window.setTimeout(() => setRecentlyTouched(false), 30_000);
    return () => {
      window.clearTimeout(reactionTimeout);
      window.clearTimeout(quietTimeout);
    };
  }, [nodeCount]);

  const running = latestRun?.status === "queued" || latestRun?.status === "running";
  const failed = agentStatus === "error" || latestRun?.status === "failed";
  const reaction: CompanionReaction = momentaryReaction !== "idle"
    ? momentaryReaction
    : running || agentStatus === "sending"
      ? "thinking"
      : failed
        ? "concerned"
        : open
          ? "listening"
          : selectedCount > 0
            ? "curious"
            : "idle";
  const activity = running || agentStatus === "sending"
    ? "working"
    : failed
      ? "error"
      : open
        ? "open"
        : "idle";

  const storedStyle = useUiPreferencesStore((state) => state.companionStyle);
  const setCompanionStyle = useUiPreferencesStore((state) => state.setCompanionStyle);
  const companionStyle = (() => {
    try {
      const forced = new URLSearchParams(window.location.search).get("companion");
      if (forced === "whale" || forced === "robot" || forced === "bear") return forced;
    } catch { /* ignore */ }
    return storedStyle;
  })();

  const anchor = useUiPreferencesStore((state) => state.companionAnchor);
  const setCompanionAnchor = useUiPreferencesStore((state) => state.setCompanionAnchor);

  const companionRef = useRef<HTMLButtonElement | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const [dragPlacement, setDragPlacement] = useState<Placement | null>(null);
  // 被拎起来的惊慌表情在松手后保留一小会儿，不然表情收得比台词还快。
  const [startled, setStartled] = useState(false);

  /** 她的定位父级（.kc-app）的范围，拖拽与夹取都以此为界。 */
  const measure = useCallback(() => {
    const element = companionRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const parent = element.offsetParent;
    const bounds = parent && typeof parent.getBoundingClientRect === "function"
      ? parent.getBoundingClientRect()
      : new DOMRect(0, 0, window.innerWidth, window.innerHeight);
    return { bounds, width: rect.width, height: rect.height };
  }, []);

  // 趴在面板上时，面板会被别的交互挪动/改变大小：1Hz 跟一次，窗口尺寸变化立即跟。
  // 这里只表示「锚点写着趴面板」；面板本身可能已经没了（抽屉收起），
  // 真正的判定见下面由 placement 解出来的 docked。
  const dockedAnchor = anchor?.kind === "dock";
  const [dockTick, setDockTick] = useState(0);
  useEffect(() => {
    if (!dockedAnchor) return;
    const onResize = () => setDockTick((value) => value + 1);
    window.addEventListener("resize", onResize);
    const timer = window.setInterval(onResize, 1_000);
    return () => {
      window.removeEventListener("resize", onResize);
      window.clearInterval(timer);
    };
  }, [dockedAnchor]);

  // 形态切换（脑袋 ↔ 全身）会改按钮尺寸，贴合计算必须**马上**重算——
  // 不然探头时她先按脑袋档的位置贴上去，等 1Hz 的定时器醒来才跳到全身档的位置。
  useEffect(() => {
    const element = companionRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setDockTick((value) => value + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  /**
   * 现在应该渲染在哪。放在 effect 里而不是渲染期直接算：
   * 挂载后必须有一次重算，否则刷新后存的锚点不会生效（首帧 ref 还没挂上）。
   * 拖拽中直接采用实时位置。
   */
  const [placement, setPlacement] = useState<Placement | null>(null);
  useEffect(() => {
    const measured = measure();
    if (!measured) return;
    setPlacement(
      dragging && dragPlacement
        ? dragPlacement
        : resolveCompanionPlacement(anchor, { width: measured.width, height: measured.height }, measured.bounds),
    );
  }, [anchor, dockTick, dragging, dragPlacement, measure]);

  /**
   * 「真的趴在面板上」要看**解出来的位置**，不能只看原始锚点：
   * 抽屉关掉后面板元素不在了，resolveCompanionPlacement 找不到目标会返回 null
   * （她回落到 CSS 默认位）。这时若还按锚点挂着 is-docked / is-peeking，
   * 她就会顶着前倾 4°、气泡翻到左侧，站在默认位（顶部居中）——像卡住了。
   */
  const docked = Boolean(placement?.dock);
  /** 趴在面板上 vs 从 Agent 抽屉边缘探出头——两种贴法的观感完全不同。 */
  const peeking = placement?.dock === "agent-drawer";

  // 台词只对鲸鱼娘有意义（气泡由 WhaleGirlCompanion 渲染）；其余形象拖拽时
  // 不必白算台词。
  const sayWhaleLine = (line: WhaleLine) => {
    if (companionStyle === "whale") setForcedLine(line);
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    // 三种形象都能拖：拖拽/吸附/复位机构本来就是形象无关的，此前只放行鲸鱼娘
    // 没有技术原因。
    if (event.button !== 0) return;
    const measured = measure();
    if (!measured) return;
    const rect = event.currentTarget.getBoundingClientRect();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // 拖拽的基准点用「她现在渲染在哪」而不是 store 里的锚——
      // 趴在面板上时两者不一致，从渲染位拖起才不会跳。
      originX: rect.left + rect.width / 2 - measured.bounds.left,
      originY: rect.top - measured.bounds.top,
      moved: false,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    const measured = measure();
    if (!measured) return;
    if (!drag.moved) {
      drag.moved = true;
      setDragging(true);
      setStartled(true);
      sayWhaleLine({ text: whaleDraggedLine(), id: Date.now(), tone: "worry" });
    }
    setDragPlacement(clampPlacement(
      drag.originX + dx,
      drag.originY + dy,
      { width: measured.width, height: measured.height },
      measured.bounds,
    ));
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) return; // 没动过 = 普通点击，交给 onClick 开关抽屉。

    suppressClickRef.current = true;
    const measured = measure();
    const drop = dragPlacement;
    setDragging(false);
    setDragPlacement(null);
    window.setTimeout(() => setStartled(false), 900);
    if (!measured || !drop) return;

    // 1) 拖回出生点附近 = 复位到顶部居中。
    if (shouldResetToDefault(drop.x, drop.y, { width: measured.width }, measured.bounds)) {
      setCompanionAnchor(null);
      sayWhaleLine({ text: "回、回到原位了？哼，我自己也会走回去的。", id: Date.now(), tone: "worry" });
      return;
    }

    // 2) 落在面板上 = 趴上去 / 从抽屉边缘探出头。
    const centerX = measured.bounds.left + drop.x;
    const centerY = measured.bounds.top + drop.y + measured.height / 2;
    const hit = findDockTargetAt(centerX, centerY, companionRef.current);
    if (hit) {
      const rect = hit.element.getBoundingClientRect();
      // 抽屉是纵向侧栏：把她挂多高记成纵向比例，默认对着输入框那一带。
      // 其余是横向面板：记横向比例，面板变宽变窄她也贴着。
      const fraction = hit.key === "agent-drawer"
        ? (rect.height > 0 ? Math.min(0.94, Math.max(0.06, (centerY - rect.top) / rect.height)) : 0.72)
        : (rect.width > 0 ? Math.min(0.94, Math.max(0.06, (centerX - rect.left) / rect.width)) : 0.5);
      setCompanionAnchor({ kind: "dock", dock: hit.key, x: fraction });
      sayWhaleLine({
        text: hit.key === "agent-drawer" ? whalePeekLine() : whaleDockedLine(),
        id: Date.now(),
        tone: "happy",
      });
      return;
    }

    // 3) 否则自由摆放。
    setCompanionAnchor({ kind: "free", x: drop.x, y: drop.y });
  };

  const [forcedLine, setForcedLine] = useState<WhaleLine | null>(null);
  // 投喂（右键）会让她把全身亮出来嚼两口，之后再缩回脑袋。
  const [feedPulse, setFeedPulse] = useState(0);

  useEffect(() => {
    if (!feedPulse) return;
    const timeout = window.setTimeout(() => setFeedPulse(0), 2_400);
    return () => window.clearTimeout(timeout);
  }, [feedPulse]);

  /**
   * 身上要不要长出来。判定全在 resolveWhaleMode 里——贴面板时**只留脑袋**
   * （用户要的就是从墙后探出小脑袋）。这里把「真的贴着面板」解出来的 docked
   * 传进去：只有它不是 undefined（面板确实在、位置真的算出来了）才算贴合。
   */
  const whaleMode = resolveWhaleMode({ activity, reaction, feedPulse, docked });

  // 趴着没事干的时候她自己东张西望：正面 ↔ 侧面。
  const [idleLook, setIdleLook] = useState(0);
  useEffect(() => {
    if (!(docked && reaction === "idle" && activity === "idle")) {
      setIdleLook(0);
      return;
    }
    const timer = window.setInterval(() => setIdleLook((value) => value + 1), 22_000);
    return () => window.clearInterval(timer);
  }, [docked, reaction, activity]);

  /** 姿态：被拎起来是惊慌脸；**贴在竖直的墙上用侧身**——脸朝画布、背和长发
   *  藏在墙后，这才是「从墙后探出头」的样子（正面贴墙只会像半个人被切掉一半，
   *  脸也会被边缘吃掉）。趴横向面板和其余情况用正面。张望只在正面 / 侧面之间
   *  来回，绝不转背面——歪头是活人感，背对是「这个人不在了」。 */
  const IDLE_LOOKS: readonly WhalePose[] = ["front", "side"];
  const whalePose: WhalePose = (() => {
    if (startled) return "shock";
    if (peeking) return "side";
    if (docked && reaction === "idle" && activity === "idle") {
      return IDLE_LOOKS[idleLook % IDLE_LOOKS.length] ?? "front";
    }
    return "front";
  })();

  const cycleCompanionStyle = () => {
    const next = nextCompanionStyle(companionStyle);
    setCompanionStyle(next);
    if (next === "whale") setForcedLine({ text: whaleStyleSwitchLine(), id: Date.now(), tone: "worry" });
  };

  /**
   * 探头时搭在抽屉左缘上的那只小手。她自己的 z 比面板低（面板盖住她的身体），
   * 但手必须**画在面板之上**才有「扶在墙上」的读感——所以它是按钮的兄弟元素，
   * 单独拿到比面板高一级的 z。位置由 placement.wall（抽屉左缘）给出：
   * 手心在画布侧连着身体，指节搭到墙面上。高度取身高的 0.78（裙摆一段）——
   * 胸口有她自己的白袖口、裙腰有白围裙边，白手贴上去都会糊成一片；
   * 只有这一段是深色裙料，白色小手贴着墙缘才读得出「这是手」。
   */
  const wallHand = companionStyle === "whale" && peeking && placement?.wall && placement.z !== undefined
    ? {
        left: `${placement.wall.x - 4}px`,
        top: `${placement.y + WHALE_BODY_PX * 0.78}px`,
        zIndex: placement.z + DOCK_Z_STEP + 1,
      }
    : null;

  return (
    <>
      <button
      ref={companionRef}
      type="button"
      className={[
        "kc-agent-companion",
        open ? "is-open" : "",
        dragging ? "is-dragging" : "",
        docked && !peeking ? "is-docked" : "",
        peeking ? "is-peeking" : "",
      ].filter(Boolean).join(" ")}
      data-reaction={reaction}
      data-activity={activity}
      data-companion-style={companionStyle}
      data-whale-mode={companionStyle === "whale" ? whaleMode : undefined}
      data-whale-pose={companionStyle === "whale" ? whalePose : undefined}
      data-docked={companionStyle === "whale" && docked ? "true" : undefined}
      style={placement
        ? {
            left: `${placement.x}px`,
            top: `${placement.y}px`,
            ...(placement.z !== undefined ? { zIndex: placement.z } : null),
          }
        : undefined}
      aria-label={open ? "收起画布 Agent" : "打开画布 Agent"}
      aria-pressed={open}
      title={open ? "收起画布助理" : "打开画布助理"}
      onClick={() => {
        if (suppressClickRef.current) {
          suppressClickRef.current = false;
          return;
        }
        if (companionStyle === "whale") setForcedLine({ text: whaleGreetingLine(), id: Date.now() });
        onToggle();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        cycleCompanionStyle();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {companionStyle === "whale" ? (
        <WhaleGirlCompanion
          reaction={reaction}
          activity={activity}
          mode={whaleMode}
          pose={whalePose}
          quiet={recentlyTouched}
          forcedLine={forcedLine}
          onFeed={() => setFeedPulse((value) => value + 1)}
        />
      ) : companionStyle === "robot" ? (
        <Suspense fallback={null}>
          <AgentCompanion3D reaction={reaction} activity={activity} />
        </Suspense>
      ) : (
        <>
          <span className="kc-agent-companion-signal" aria-hidden="true"><i /><i /><i /></span>
          <span className="kc-agent-companion-horn kc-agent-companion-horn--left" aria-hidden="true" />
          <span className="kc-agent-companion-horn kc-agent-companion-horn--right" aria-hidden="true" />
          <span className="kc-agent-companion-head" aria-hidden="true">
            <span className="kc-agent-companion-brow kc-agent-companion-brow--left" />
            <span className="kc-agent-companion-brow kc-agent-companion-brow--right" />
            <span className="kc-agent-companion-eyes">
              <i />
              <i />
            </span>
            <span className="kc-agent-companion-snout" />
          </span>
        </>
      )}
      <span className="kc-agent-companion-state" aria-hidden="true" />
    </button>
      {wallHand ? <span className="kc-whale-wall-hand" aria-hidden="true" style={wallHand} /> : null}
    </>
  );
});
