export function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement
    && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}

export function shouldIgnoreCanvasCommand(target: EventTarget | null) {
  if (isEditableTarget(target)) return true;
  const element = target instanceof Element ? target : document.activeElement;
  if (element?.closest("button, a, [role='button'], [role='menuitem'], [role='option'], [data-kc-block-canvas-shortcuts]")) {
    return true;
  }
  return Boolean(document.querySelector("[aria-modal='true']"));
}
