import { useEffect, useRef, type RefObject } from "react";

export function useDismissOnOutsideClick<T extends HTMLElement>(open: boolean, onDismiss: () => void): RefObject<T | null> {
  const surfaceRef = useRef<T>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;

    const dismissOutside = (event: MouseEvent) => {
      const target = event.target;
      const surface = surfaceRef.current;
      const path = event.composedPath();
      if (!surface || path.includes(surface)) return;
      if (path.some((item) => item instanceof HTMLElement && item.hasAttribute("data-kc-preserve-drawers"))) return;
      if (!(target instanceof Node) || surface.contains(target)) return;
      onDismissRef.current();
    };

    const timer = window.setTimeout(() => document.addEventListener("click", dismissOutside), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("click", dismissOutside);
    };
  }, [open]);

  return surfaceRef;
}
