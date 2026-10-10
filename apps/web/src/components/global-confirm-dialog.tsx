import { AlertTriangle, X } from "lucide-react";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import {
  getConfirmationSnapshot,
  resolveConfirmation,
  subscribeToConfirmation,
} from "../lib/confirmation";

export function GlobalConfirmDialog() {
  const confirmation = useSyncExternalStore(
    subscribeToConfirmation,
    getConfirmationSnapshot,
    getConfirmationSnapshot,
  );
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!confirmation) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus({ preventScroll: true }));
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        resolveConfirmation(confirmation.id, false);
        return;
      }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!buttons.length) return;
      const first = buttons[0]!;
      const last = buttons.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused?.isConnected) previouslyFocused.focus({ preventScroll: true });
    };
  }, [confirmation]);

  if (!confirmation) return null;
  const { options } = confirmation;
  const tone = options.tone ?? "warning";

  return createPortal(
    <div
      className="kc-confirm-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kc-confirm-title"
      aria-describedby="kc-confirm-description"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) resolveConfirmation(confirmation.id, false);
      }}
    >
      <section ref={dialogRef} className={`kc-confirm-dialog is-${tone}`}>
        <header>
          <span className="kc-confirm-mark" aria-hidden="true"><AlertTriangle /></span>
          <span>
            <strong id="kc-confirm-title">{options.title}</strong>
            <small>请确认这项操作</small>
          </span>
          <button type="button" aria-label="关闭确认窗口" onClick={() => resolveConfirmation(confirmation.id, false)}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="kc-confirm-content">
          <p id="kc-confirm-description">{options.description}</p>
          {options.detail ? <small>{options.detail}</small> : null}
        </div>
        <footer>
          <button ref={cancelRef} type="button" onClick={() => resolveConfirmation(confirmation.id, false)}>
            {options.cancelLabel ?? "取消"}
          </button>
          <button type="button" className="is-confirm" onClick={() => resolveConfirmation(confirmation.id, true)}>
            {options.confirmLabel ?? "确认"}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
