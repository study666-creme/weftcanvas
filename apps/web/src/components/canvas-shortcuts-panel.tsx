import { Keyboard, Sparkles, X } from "lucide-react";
import { memo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

const shortcutGroups = [
  {
    title: "画布导航",
    items: [
      { keys: ["Space"], label: "按住平移画布" },
      { keys: ["滚轮"], label: "上下移动画布" },
      { keys: ["Ctrl", "滚轮"], label: "缩放画布" },
      { keys: ["双击空白"], label: "创建节点" },
      { keys: ["Tab"], label: "专注模式：收起 / 恢复界面" },
      { keys: ["?", "F1"], label: "打开快捷键说明" },
    ],
  },
  {
    title: "选择与编辑",
    items: [
      { keys: ["Ctrl / ⌘", "A"], label: "全选节点" },
      { keys: ["Ctrl / ⌘", "C"], label: "复制选中内容" },
      { keys: ["Ctrl / ⌘", "V"], label: "粘贴内容" },
      { keys: ["Ctrl / ⌘", "D"], label: "快速复制" },
      { keys: ["Ctrl / ⌘", "G"], label: "组合选中节点" },
      { keys: ["Ctrl / ⌘", "Shift", "G"], label: "解散选中组合" },
      { keys: ["Delete / Backspace"], label: "删除选中内容" },
      { keys: ["Esc"], label: "取消选择或关闭面板" },
    ],
  },
  {
    title: "历史",
    items: [
      { keys: ["Ctrl / ⌘", "Z"], label: "撤销" },
      { keys: ["Ctrl / ⌘", "Shift", "Z"], label: "重做" },
      { keys: ["Ctrl / ⌘", "Y"], label: "重做" },
    ],
  },
] as const;

function isEditable(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export const CanvasShortcutsPanel = memo(function CanvasShortcutsPanel({
  open,
  onOpenChange,
  onStartTutorial,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 重看新手教程：教程走完过的人由这里再叫出来。 */
  onStartTutorial?: () => void;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const opensHelp =
        event.key === "?" || event.key === "F1" || (event.code === "Slash" && event.shiftKey);
      if (opensHelp && !isEditable(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(!open);
        return;
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onOpenChange(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => previousFocus.current?.focus();
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="wc-shortcuts-backdrop"
      role="presentation"
      onPointerDown={() => onOpenChange(false)}
    >
      <section
        className="wc-shortcuts-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="wc-shortcuts-title"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="wc-shortcuts-header">
          <span className="wc-shortcuts-mark" aria-hidden="true">
            <Keyboard />
          </span>
          <div>
            <h2 id="wc-shortcuts-title">画布快捷键</h2>
            <p>常用操作集中在这里，输入文字时不会触发画布快捷键。</p>
          </div>
          <button
            ref={closeButton}
            type="button"
            className="wc-icon-button"
            aria-label="关闭快捷键说明"
            title="关闭"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="wc-shortcuts-grid">
          {shortcutGroups.map((group) => (
            <section key={group.title} className="wc-shortcuts-group">
              <h3>{group.title}</h3>
              <dl>
                {group.items.map((item) => (
                  <div key={`${group.title}:${item.keys.join("+")}:${item.label}`}>
                    <dt>
                      {item.keys.map((key) => (
                        <kbd key={key}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{item.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
        {onStartTutorial ? (
          <footer className="wc-shortcuts-foot">
            <p>第一次用画布？跟着走一遍：从首屏进画布，再创建节点、平移和缩放。</p>
            <button
              type="button"
              className="wc-shortcuts-tutorial"
              onClick={() => {
                onOpenChange(false);
                onStartTutorial();
              }}
            >
              <Sparkles aria-hidden="true" />
              重看新手教程
            </button>
          </footer>
        ) : null}
      </section>
    </div>,
    document.body,
  );
});
