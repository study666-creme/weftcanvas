/**
 * 画布视口手势（平移 / 空格拖拽 / 缩放）期间，画布会挂上 `is-viewport-moving`
 * 或 `is-space-pan`，背景层（星空 / 水面 / 点阵）据此跳过 rAF 重画，避免和手势
 * 抢帧。但手势结束时**不会**再有新的 transform 事件，所以必须由手势结束本身
 * 触发一次补画——否则背景会停在手势开始前的状态，直到下一次视图变化才恢复
 * （表现为缩放后点阵间距、水面偏移对不上）。
 */
const WORKSPACE_SELECTOR = ".kc-workspace";
const MOVING_CLASSES = ["is-viewport-moving", "is-space-pan"] as const;

/** 手势判断的最小契约：只看类名，便于在没有 DOM 的测试里替换。 */
export type ClassListLike = { contains(name: string): boolean };

/** 观察目标的最小契约（MutationObserver 兼容子集）。 */
export type ClassObserverLike = {
  observe(target: object, options: { attributes: true; attributeFilter: string[] }): void;
};

export function classListIsMoving(classList: ClassListLike | null | undefined): boolean {
  if (!classList) return false;
  return MOVING_CLASSES.some((name) => classList.contains(name));
}

export function workspaceIsMoving(): boolean {
  const workspace = typeof document === "undefined"
    ? null
    : document.querySelector(WORKSPACE_SELECTOR);
  return classListIsMoving(workspace?.classList);
}

/**
 * 监听画布手势类名的移除；手势一结束就回调一次，让背景层按最新视口补画。
 * 返回取消监听的函数。`MutationObserver` / 画布元素不可用时退化为空实现
 * （只损失这一次补画，不影响手势期间的正确性）。
 */
export function observeWorkspaceGestureEnd(onSettle: () => void): () => void {
  if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  const workspace = document.querySelector(WORKSPACE_SELECTOR);
  if (!workspace) return () => undefined;
  const observer = new MutationObserver(() => {
    if (classListIsMoving(workspace.classList)) return;
    onSettle();
  });
  observer.observe(workspace, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}
