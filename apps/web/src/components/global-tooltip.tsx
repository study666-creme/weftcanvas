import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const TOOLTIP_ID = "wc-global-tooltip";
const VIEWPORT_INSET = 8;
const TOOLTIP_GAP = 8;

export function GlobalTooltip() {
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const tooltip = tooltipRef.current;
    const label = tooltip?.querySelector<HTMLElement>("span");
    if (!tooltip || !label) return;

    let active: HTMLElement | null = null;
    let previousDescription: string | null = null;
    let showTimer: number | null = null;
    let positionFrame: number | null = null;

    const clearTimers = () => {
      if (showTimer !== null) window.clearTimeout(showTimer);
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      showTimer = null;
      positionFrame = null;
    };

    const restoreDescription = () => {
      if (!active) return;
      if (previousDescription === null) active.removeAttribute("aria-describedby");
      else active.setAttribute("aria-describedby", previousDescription);
      previousDescription = null;
    };

    const hide = () => {
      clearTimers();
      restoreDescription();
      active = null;
      tooltip.classList.remove("is-visible");
      tooltip.setAttribute("aria-hidden", "true");
    };

    const place = () => {
      positionFrame = null;
      if (!active?.isConnected) {
        hide();
        return;
      }
      const anchor = active.getBoundingClientRect();
      const bounds = tooltip.getBoundingClientRect();
      let placement: "top" | "bottom" = "top";
      let top = anchor.top - bounds.height - TOOLTIP_GAP;
      if (top < VIEWPORT_INSET) {
        placement = "bottom";
        top = anchor.bottom + TOOLTIP_GAP;
      }
      top = Math.min(
        window.innerHeight - bounds.height - VIEWPORT_INSET,
        Math.max(VIEWPORT_INSET, top),
      );
      const centered = anchor.left + anchor.width / 2 - bounds.width / 2;
      const left = Math.min(
        window.innerWidth - bounds.width - VIEWPORT_INSET,
        Math.max(VIEWPORT_INSET, centered),
      );
      tooltip.style.left = `${Math.round(left)}px`;
      tooltip.style.top = `${Math.round(top)}px`;
      tooltip.dataset.placement = placement;
    };

    const reveal = (target: HTMLElement, copy: string, delay: number) => {
      hide();
      active = target;
      label.textContent = copy;
      showTimer = window.setTimeout(() => {
        showTimer = null;
        if (!active?.isConnected) return;
        previousDescription = active.getAttribute("aria-describedby");
        const descriptions = [previousDescription, TOOLTIP_ID].filter(Boolean).join(" ");
        active.setAttribute("aria-describedby", descriptions);
        tooltip.setAttribute("aria-hidden", "false");
        tooltip.classList.add("is-visible");
        positionFrame = window.requestAnimationFrame(place);
      }, delay);
    };

    const resolveTarget = (eventTarget: EventTarget | null) => {
      if (!(eventTarget instanceof Element)) return null;
      const target = eventTarget.closest<HTMLElement>("[data-wc-tooltip], [title]");
      if (!target || target.closest('[aria-hidden="true"]')) return null;
      const nativeTitle = target.getAttribute("title")?.trim();
      if (nativeTitle) {
        target.dataset.kcTooltip = nativeTitle;
        target.removeAttribute("title");
      }
      const copy = target.dataset.kcTooltip?.trim();
      return copy ? { target, copy } : null;
    };

    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      const resolved = resolveTarget(event.target);
      if (!resolved || resolved.target === active) return;
      reveal(resolved.target, resolved.copy, 360);
    };
    const onPointerOut = (event: PointerEvent) => {
      if (!active) return;
      if (event.relatedTarget instanceof Node && active.contains(event.relatedTarget)) return;
      hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const resolved = resolveTarget(event.target);
      if (!resolved) return;
      reveal(resolved.target, resolved.copy, 90);
    };
    const onFocusOut = (event: FocusEvent) => {
      if (!active) return;
      if (event.relatedTarget instanceof Node && active.contains(event.relatedTarget)) return;
      hide();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      clearTimers();
      restoreDescription();
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("focusout", onFocusOut, true);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, []);

  return createPortal(
    <div
      ref={tooltipRef}
      id={TOOLTIP_ID}
      className="wc-global-tooltip"
      role="tooltip"
      aria-hidden="true"
    >
      <span />
    </div>,
    document.body,
  );
}
