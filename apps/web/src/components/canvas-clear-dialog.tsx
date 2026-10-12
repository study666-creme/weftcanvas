import { Eraser, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export const CanvasClearDialog = memo(function CanvasClearDialog({
  open,
  nodeCount,
  onClose,
  onConfirm,
}: {
  open: boolean;
  nodeCount: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      className="wc-project-delete-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="清空画布"
      onPointerDown={onClose}
    >
      <section
        className="wc-project-delete-dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="wc-clear-dialog-mark" aria-hidden="true">
            <Eraser />
          </span>
          <strong>清空当前画布</strong>
          <button type="button" aria-label="关闭" title="关闭" onClick={onClose}>
            <X aria-hidden="true" />
          </button>
        </header>
        <p>将删除当前画布中的 {nodeCount} 个节点及其连线和组合。操作完成后仍可撤销。</p>
        <footer>
          <button ref={cancelButton} type="button" onClick={onClose}>
            取消
          </button>
          <button type="button" className="is-danger" onClick={onConfirm}>
            清空画布
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
});
