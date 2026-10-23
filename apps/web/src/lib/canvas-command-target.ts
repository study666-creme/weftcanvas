export function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export function shouldIgnoreCanvasCommand(target: EventTarget | null) {
  if (isEditableTarget(target)) return true;
  const element = target instanceof Element ? target : document.activeElement;
  if (
    element?.closest(
      "button, a, [role='button'], [role='menuitem'], [role='option'], [data-wc-block-canvas-shortcuts]",
    )
  ) {
    return true;
  }
  return Boolean(document.querySelector("[aria-modal='true']"));
}

/**
 * 粘贴的判定比快捷键宽：点过工具按钮后焦点可能还留在按钮上，但用户已经把
 * 指针移回画布空白处。只要当前焦点不是输入框，也不在任何面板/抽屉里，就按
 * 画布粘贴处理；否则「点空白 → Ctrl+V 贴图」会因为焦点停在旧按钮上而失效。
 */
export function shouldIgnoreCanvasPaste(target: EventTarget | null) {
  if (isEditableTarget(target)) return true;
  const element = (target instanceof Element ? target : document.activeElement) ?? null;
  if (isEditableTarget(element)) return true;
  if (
    element?.closest(
      "[role='dialog'], [aria-modal='true'], [data-wc-block-canvas-shortcuts], .wc-agent-drawer",
    )
  ) {
    return true;
  }
  return Boolean(document.querySelector("[aria-modal='true']"));
}
