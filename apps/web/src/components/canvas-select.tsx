import { Check, ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

export type CanvasSelectOption = {
  value: string;
  label: string;
  title?: string;
  meta?: string;
  group?: string;
  detail?: string;
  accent?: boolean;
};

export function CanvasSelect({
  value,
  options,
  onChange,
  ariaLabel,
  disabled = false,
  placeholder = "请选择",
  variant = "standard",
  className = "",
  menuClassName = "",
  menuMinWidth = 220,
  selectedMeta,
}: {
  value: string;
  options: CanvasSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
  variant?: "standard" | "compact";
  className?: string;
  menuClassName?: string;
  menuMinWidth?: number;
  selectedMeta?: string;
}) {
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = options.find((option) => option.value === value);
  const triggerMeta = selectedMeta ?? selected?.meta;

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const place = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const viewportInset = 12;
      const menuGap = 7;
      const spaceBelow = Math.max(0, window.innerHeight - rect.bottom - menuGap - viewportInset);
      const spaceAbove = Math.max(0, rect.top - menuGap - viewportInset);
      const desiredHeight = Math.min(320, menuRef.current?.scrollHeight ?? 320);
      const openAbove = spaceBelow < desiredHeight && spaceAbove > spaceBelow;
      const availableHeight = openAbove ? spaceAbove : spaceBelow;
      setMenuStyle({
        left: Math.max(
          viewportInset,
          Math.min(
            rect.left,
            window.innerWidth - Math.max(rect.width, menuMinWidth) - viewportInset,
          ),
        ),
        width: Math.min(Math.max(rect.width, menuMinWidth), window.innerWidth - viewportInset * 2),
        maxHeight: Math.min(320, availableHeight),
        ...(openAbove
          ? { bottom: window.innerHeight - rect.top + menuGap }
          : { top: rect.bottom + menuGap }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [menuMinWidth, open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  return (
    <div
      className={`wc-canvas-select wc-canvas-select--${variant} ${className}`.trim()}
      data-canvas-select
      data-value={value}
    >
      <button
        ref={triggerRef}
        type="button"
        className="wc-canvas-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        disabled={disabled || !options.length}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          setOpen((current) => !current);
        }}
      >
        <span
          className="wc-canvas-select-label"
          title={selected?.title || selected?.label || placeholder}
        >
          {selected?.label || placeholder}
        </span>
        {triggerMeta ? <small className="wc-canvas-select-meta">{triggerMeta}</small> : null}
        <ChevronDown aria-hidden="true" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listboxId}
              className={`wc-canvas-select-menu ${menuClassName}`}
              role="listbox"
              aria-label={ariaLabel}
              style={menuStyle}
              data-wc-preserve-drawers
            >
              {options.map((option, index) => {
                const active = option.value === value;
                return (
                  <div key={option.value} className="wc-canvas-select-option-wrap">
                    {option.group && option.group !== options[index - 1]?.group ? (
                      <div className="wc-canvas-select-group">{option.group}</div>
                    ) : null}
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      className={active ? "is-selected" : undefined}
                      title={option.title || option.label}
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onChange(option.value);
                        setOpen(false);
                      }}
                    >
                      {option.accent ? (
                        <Sparkles className="wc-canvas-select-option-icon" aria-hidden="true" />
                      ) : null}
                      <span className="wc-canvas-select-option-copy">
                        <span className="wc-canvas-select-label">{option.label}</span>
                        {option.detail ? <small>{option.detail}</small> : null}
                      </span>
                      {option.meta ? (
                        <small className="wc-canvas-select-meta">{option.meta}</small>
                      ) : null}
                      {active ? <Check aria-hidden="true" /> : null}
                    </button>
                  </div>
                );
              })}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
