/**
 * 连线手势的全局状态。
 *
 * 画布上的连线可能从节点手柄发起，也可能从多选工具条的端口发起；两处都会在
 * `.wc-workspace` 上打 `is-connection-dragging`。节点编辑浮层是 portal 到 body 的，
 * 拿不到 workspace 的类名，所以在 body 上再镜像一个类，让浮层在连线时自动收起。
 */
const WORKSPACE_CLASS = "is-connection-dragging";
const BODY_CLASS = "is-canvas-connection-dragging";

export function setCanvasConnectionDragging(active: boolean) {
  if (typeof document === "undefined") return;
  document.querySelector(".wc-workspace")?.classList.toggle(WORKSPACE_CLASS, active);
  document.body.classList.toggle(BODY_CLASS, active);
}
