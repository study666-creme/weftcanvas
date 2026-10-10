import { memo, useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

import "./whale-girl-companion.css";

export type WhaleReaction = "idle" | "curious" | "celebrate" | "concerned" | "thinking" | "listening";
export type WhaleActivity = "idle" | "working" | "error" | "open";
export type WhaleTone = "chatter" | "happy" | "worry" | "snack";
/** 外部（点击 / 切换样式）递给她的台词。 */
export type WhaleLine = { text: string; id: number; tone?: WhaleTone };
/**
 * head = 画布上只露一个脑袋（默认，和小熊 / 机器人同量级）；
 * full = 打开 Agent 抽屉、趴在面板上、或她正在做动作时，全身跳出来。
 */
export type WhaleMode = "head" | "full";
/** 姿态：三视图的三个方向 + 惊慌（拖拽时用，闭眼张嘴喊）。 */
export type WhalePose = "front" | "side" | "back" | "shock";

/** 三视图素材：head 是正面头，body 是正面全身，side / back 是侧背的全身与头部切片。 */
const SPRITE_DIR = "/agent/whale-girl";
const POSES: readonly WhalePose[] = ["front", "side", "back", "shock"];
const HEAD_BY_POSE: Record<WhalePose, string> = {
  front: `${SPRITE_DIR}/head.png`,
  side: `${SPRITE_DIR}/head_side.png`,
  back: `${SPRITE_DIR}/head_back.png`,
  shock: `${SPRITE_DIR}/head_shock.png`,
};
const BODY_BY_POSE: Record<WhalePose, string> = {
  front: `${SPRITE_DIR}/body.png`,
  side: `${SPRITE_DIR}/side.png`,
  back: `${SPRITE_DIR}/back.png`,
  shock: `${SPRITE_DIR}/body_shock.png`,
};

/**
 * 台词库。DeepSeek 娘（大肥鱼 / 鲸鱼娘）在网络二创里最稳定的三个性格标签是
 * 「贪吃」「犯傻呆萌」「傲娇」，外加「经常炸缸」和「其实很喜欢你」，
 * 这里的每一句都挂在其中一个标签上。
 *
 * 刻意**没有**悬停 / 选中节点 / 思考中 / 抽屉打开这四类台词：那都是用户没叫她
 * 的时候，一开口就是打扰（反馈里被明确否掉）。所以每一句都要有一个真实的
 * 触发事件——点击、拖拽、投喂、增删节点、出错、或极低频的引导语。
 */
const LINES = {
  greet: [
    "来啦来啦～",
    "需要我帮你打捞点什么？",
    "我在呢，说吧说吧。",
  ],
  celebrate: [
    "哇！画布多了一个新朋友！",
    "哼，做得还不错嘛。",
    "又长大了一点～",
  ],
  concerned: [
    "呜…炸缸了，等我缓一缓…",
    "别、别戳了，我炸毛了！",
    "服务器有点挤，让我深呼吸一下。",
  ],
  snack: [
    "好吃！白吃 token 成功！",
    "唔…这条小鱼干是我的，不给你。",
    "哼，才不是因为你喂我才帮你的。",
    "没吃饱喵",
  ],
  switched: [
    "哼，换人啦？",
    "又切换…好吧，随你。",
  ],
  dragged: [
    "哇啊——放我下来！",
    "轻、轻一点，鱼鳍会断的啦！",
    "要去哪里呀？带好我了吗？",
  ],
  docked: [
    "趴在这里刚好能看到你干活～",
    "这块板子挺暖和的，我趴会儿。",
    "哼，就允许你把我放这儿。",
  ],
  peek: [
    "探头中…正好看你打字呀，别写我坏话哦。",
    "我在这儿看着呢，写快点写快点。",
    "从后面冒个头，不打扰你吧？",
  ],
  nap: [
    "Zzz…（梦到小鱼干）",
    "唔…让我眯五分钟…",
    "Zzz…（尾巴还在晃）",
  ],
} as const;

/**
 * 空闲时偶尔冒的一句「引导语」——目的是把用户往 Agent 创作上带，
 * 不是无意义的弹幕。频率极低（2.5~5 分钟一次，见下面 effect），
 * 用户刚动过画布时完全不响。
 */
const GUIDE_CHATTER: string[] = [
  "想要什么直接跟 Agent 说就行，它看得见你画布上的节点～",
  "不知道该接什么？点开 Agent，让它帮你梳理当前画布。",
  "提示词写不顺的话，可以让 Agent 帮你优化一版。",
  "卡住的时候喊我一声，我可以让 Agent 帮你补一个分镜。",
];

const pick = (pool: readonly string[], avoid?: string): string => {
  const fallback = pool[0] ?? "";
  if (pool.length <= 1) return fallback;
  let index = Math.floor(Math.random() * pool.length);
  if (avoid !== undefined && pool[index] === avoid) index = (index + 1) % pool.length;
  return pool[index] ?? fallback;
};

const prefersReducedMotion = () => {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/**
 * 身上要不要长出来。
 *
 * 默认只有脑袋。**贴在面板上时是全身**——用户原话：探头不是只有一个头，
 * 正常人从墙后探头还能看到小手扶墙、一点衣物裙摆。所以「只露脑袋」的那版
 * 是改过头了：竖直的墙改用侧身贴（脸朝画布、背藏在墙后，见
 * companion-placement 的 PEEK_WALL_VISIBLE），遮挡交给面板本身。
 *
 * 打开 Agent 抽屉时全身跳出来（用户明确要的）。其余：正在做事、或刚被逗了
 * 一下（庆祝 / 炸毛 / 投喂）一律全身——那是事件，值得整只跳出来。
 *
 * 注意 thinking 不用单独列：它只在 agentStatus 为 sending 或 run 在跑时出现，
 * 而那两种情况下 activity 已经是 working 了。
 * curious（画布上选了节点）也不列——那是日常状态，不该让她频繁长身体；
 * 她的「注意到」由眼睛和头部转向节点表达（看下面的节点注视）。
 */
export const resolveWhaleMode = ({
  activity,
  reaction,
  feedPulse,
  docked = false,
}: {
  activity: WhaleActivity;
  reaction: WhaleReaction;
  feedPulse: number;
  docked?: boolean;
}): WhaleMode => {
  const acting = activity === "working"
    || activity === "error"
    || reaction === "celebrate"
    || reaction === "concerned"
    || feedPulse > 0;
  if (acting) return "full";
  return docked || activity === "open" ? "full" : "head";
};

export const WhaleGirlCompanion = memo(function WhaleGirlCompanion({
  reaction,
  activity,
  mode,
  pose,
  quiet,
  forcedLine,
  onFeed,
}: {
  reaction: WhaleReaction;
  activity: WhaleActivity;
  mode: WhaleMode;
  pose: WhalePose;
  /** 用户正在专心创作（刚改过画布）时为 true——她把碎碎念咽回去，不打扰。 */
  quiet: boolean;
  forcedLine: WhaleLine | null;
  onFeed?: () => void;
}) {
  const [line, setLine] = useState<{ text: string; tone: WhaleTone; id: number } | null>(null);
  const [fed, setFed] = useState(0);
  const lastLineRef = useRef<string | undefined>(undefined);
  const hideTimerRef = useRef(0);
  const reducedMotionRef = useRef(false);
  /** 空闲太久会打盹（活人感）：任何互动都会把她叫醒。 */
  const [napping, setNapping] = useState(false);
  const napTimerRef = useRef(0);

  const wake = useCallback(() => {
    setNapping(false);
    window.clearTimeout(napTimerRef.current);
    napTimerRef.current = window.setTimeout(() => setNapping(true), 45_000);
  }, []);

  const say = useCallback((text: string, tone: WhaleTone = "chatter", hold = 2600) => {
    lastLineRef.current = text;
    setLine({ text, tone, id: Date.now() + Math.random() });
    window.clearTimeout(hideTimerRef.current);
    hideTimerRef.current = window.setTimeout(() => setLine(null), hold);
  }, []);

  useEffect(() => {
    reducedMotionRef.current = prefersReducedMotion();
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => { reducedMotionRef.current = query.matches; };
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  /**
   * 反应驱动的台词。**只在真实事件时开口**：新增 / 删除节点（庆祝 / 炸毛）
   * 和 agent 出错。选节点（curious）、agent 在跑（thinking）、抽屉打开
   * （listening）都刻意不发声——用户点一下画布她就说话是最重的一种打扰。
   */
  useEffect(() => {
    wake();
    if (reaction === "celebrate") say(pick(LINES.celebrate, lastLineRef.current), "happy", 2_800);
    else if (reaction === "concerned") say(pick(LINES.concerned, lastLineRef.current), "worry", 3_200);
  }, [reaction, say, wake]);

  // 外部（点击 / 拖拽 / 趴面板）递进来的台词。
  useEffect(() => {
    if (!forcedLine) return;
    wake();
    say(forcedLine.text, forcedLine.tone ?? "chatter", 2_200);
  }, [forcedLine?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * 空闲碎碎念：改成**低频引导语**，引导用户去用 Agent 创作，而不是无意义的弹幕。
   * 间隔 2.5~5 分钟；用户刚改过画布（quiet）时完全不响。
   */
  useEffect(() => {
    if (quiet || reaction !== "idle" || activity !== "idle" || reducedMotionRef.current) return;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(() => {
        say(pick(GUIDE_CHATTER, lastLineRef.current), "chatter", 3_400);
        schedule();
      }, 150_000 + Math.random() * 150_000);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [quiet, reaction, activity, say]);

  useEffect(() => {
    wake();
    return () => window.clearTimeout(napTimerRef.current);
  }, [wake]);

  useEffect(() => () => window.clearTimeout(hideTimerRef.current), []);

  const handleFeed = useCallback((event: ReactMouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    wake();
    setFed((value) => value + 1);
    onFeed?.();
    say(pick(LINES.snack, lastLineRef.current), "snack", 2_600);
  }, [onFeed, say, wake]);

  /**
   * 鼠标凑近只把她叫醒（打盹时说一句），不说话。
   * 之前每次悬停都蹦台词 + 一大串 title 提示，把画布挡住了——用户明确否掉。
   */
  const handleHover = useCallback(() => {
    wake();
    if (napping) say("唔…我醒了！", "chatter", 1_800);
  }, [napping, say, wake]);

  // 拖拽 / 趴面板的台词由父组件通过 forcedLine 递进来，这里只负责打盹的嘟囔。
  useEffect(() => {
    if (!napping || reducedMotionRef.current) return;
    say(pick(LINES.nap, lastLineRef.current), "chatter", 3_400);
  }, [napping, say]);

  /**
   * 视线跟随：鼠标在附近时她会朝你极小幅度地偏一下（±0.9deg）。
   * 幅度刻意压得很小——之前 ±2.4deg 跟着鼠标甩，被反馈说「脑袋僵硬地晃」。
   * 选中节点时让位给节点注视（下面的 effect），两个输入源不能抢同一个头。
   * 性能上：不走 React state（指针每秒几十次，重渲染不可接受），只写 CSS 变量；
   * 矩形缓存 600ms；数值变化小于 0.05deg 不写 DOM。
   */
  const rootRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let frame = 0;
    let cached: { left: number; top: number; width: number; height: number } | null = null;
    let cachedAt = 0;
    let last = 0;
    const onMove = (event: PointerEvent) => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const now = performance.now();
        if (!cached || now - cachedAt > 600) {
          const rect = root.getBoundingClientRect();
          cached = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
          cachedAt = now;
        }
        const dx = event.clientX - (cached.left + cached.width / 2);
        const dy = event.clientY - cached.top;
        const near = Math.abs(dx) < 340 && dy > -280 && dy < cached.height + 280;
        // 好奇（选中了节点）时视线归节点管：鼠标跟随让位，不然两个输入源打架。
        if (root.dataset.whaleReaction === "curious") return;
        const next = near ? Math.max(-0.9, Math.min(0.9, (dx / 300) * 0.9)) : 0;
        if (Math.abs(next - last) < 0.05) return;
        last = next;
        root.style.setProperty("--whale-look", `${next.toFixed(2)}deg`);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  /**
   * 节点注视：选中节点（curious）时，她的**头转向节点方向并保持**，节点被拖走
   * 时每 0.9s 跟一次。这是「注意到你在看什么」——之前只有一个不认方向的 -3.4°
   * 固定歪头，用户直接说「完全没有正确看向节点」。
   *
   * 幅度：头最多 ±4°（再大从正面看就是「头歪过去了」，用户原话「脸都裂开了」
   * 有一半是这个），加一整只 1.5px 的**刚性**平移（连同原画一起挪，无任何
   * 错位）。刻意不做眼球平移：眼窗是原画上开的口子，在窗口里平移原画会让
   * 边界上的睫毛/发丝错位 2 显示像素，脸就裂了——那版已经删掉。
   * 都不走 React state，只写 CSS 变量；量测频率 1Hz 以内。
   */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (reaction !== "curious" || reducedMotionRef.current) {
      root.style.removeProperty("--whale-gaze");
      root.style.removeProperty("--whale-look");
      return;
    }
    let frame = 0;
    const look = () => {
      frame = 0;
      const node = document.querySelector(".react-flow__node.selected, .react-flow__node-kachang.selected");
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const mine = root.getBoundingClientRect();
      const dx = rect.left + rect.width / 2 - (mine.left + mine.width / 2);
      const turn = dx === 0 ? 0 : Math.sign(dx) * Math.max(1.5, Math.min(4, Math.abs(dx) / 60));
      root.style.setProperty("--whale-look", `${turn.toFixed(2)}deg`);
      root.style.setProperty("--whale-gaze", `${Math.max(-1.5, Math.min(1.5, dx / 400)).toFixed(2)}px`);
    };
    look();
    const timer = window.setInterval(() => {
      if (!frame) frame = window.requestAnimationFrame(look);
    }, 900);
    return () => {
      window.clearInterval(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [reaction]);

  return (
    <span
      ref={rootRef}
      className="kc-agent-whale"
      data-whale-mode={mode}
      data-whale-pose={pose}
      data-whale-reaction={reaction}
      data-whale-activity={activity}
      data-whale-fed={fed % 2 === 0 ? "even" : "odd"}
      data-whale-napping={napping ? "true" : undefined}
      onContextMenu={handleFeed}
      onPointerEnter={handleHover}
      aria-hidden="true"
    >
      <span className="kc-whale-aura" />
      {/*
        一比一素材：三视图的正面 / 侧面 / 背面，各有全身与头部两种裁切。
        脑袋档位按姿态在 head / head_side / head_back 之间切——
        选中节点时她侧头看，agent 思考时她转身背对，都是原画切片不是手绘。
        三张都常驻 DOM，切姿态不闪。
        .kc-agent-companion-eyes 挂在眼神闪光上，沿用 styles.css 的
        prefers-reduced-motion 兜底与 e2e 的动画断言。
      */}
      <span className="kc-whale-figure">
        {POSES.map((candidate) => (
          <img
            key={`head-${candidate}`}
            className="kc-whale-sprite"
            data-whale-part="head"
            data-whale-body-pose={candidate}
            src={HEAD_BY_POSE[candidate]}
            alt=""
            draggable={false}
          />
        ))}
        {/*
          眨眼：**左右眼各一个小窗口**，窗口里盖一张预渲染的闭眼贴片
          （eye-closed-left/right.png：肤色沿脸部轮廓补进去、睫毛按原画线色画成
          下弯的弧）。贴片与窗口内的原画逐像素对齐，所以不会裂。
          ⚠️ 眼睛的「左右看」曾经靠在窗口里平移整张原画实现，已删——平移会让
          窗口边界上所有跨线的笔画（睫毛/腮红/发丝）错位 2 个显示像素（≈原画
          7px），脸沿着眼窗的矩形裂开；选中节点时错位被长期定格，用户直接看到
          「脸裂开了」。眼球要再动，只能走眨眼同款技术：预渲染虹膜位移的整帧贴片。
          必须左右分开：合成一个横跨两眼的大窗口时，覆盖会落在鼻梁上（评审实测）。
        */}
        {(["left", "right"] as const).map((side) => (
          <span key={side} className="kc-whale-eyes" data-whale-eyes-side={side} aria-hidden="true" />
        ))}
        {POSES.map((candidate) => (
          <img
            key={`body-${candidate}`}
            className="kc-whale-sprite"
            data-whale-part="body"
            data-whale-body-pose={candidate}
            src={BODY_BY_POSE[candidate]}
            alt=""
            draggable={false}
          />
        ))}
      </span>
      <span className="kc-agent-companion-eyes kc-whale-glint" />
      <span className="kc-whale-fx">
        <i className="kc-whale-heart" />
        <i className="kc-whale-heart kc-whale-heart--b" />
        <i className="kc-whale-spark" />
        <i className="kc-whale-spark kc-whale-spark--b" />
        <i className="kc-whale-sweat" />
        <i className="kc-whale-poof" />
        <i className="kc-whale-zzz"><span>Z</span><span>z</span><span>z</span></i>
      </span>
      <span className="kc-whale-fish" key={fed}>🐟</span>
      <span className="kc-whale-bubble" data-tone={line?.tone ?? "chatter"}>
        {line ? <b key={line.id}>{line.text}</b> : null}
      </span>
    </span>
  );
});

export const whaleGreetingLine = () => pick(LINES.greet);
export const whaleStyleSwitchLine = () => pick(LINES.switched);
export const whaleDraggedLine = () => pick(LINES.dragged);
export const whaleDockedLine = () => pick(LINES.docked);
export const whalePeekLine = () => pick(LINES.peek);
