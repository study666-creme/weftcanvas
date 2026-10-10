import type { AgentModel } from "@kachang/contracts";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

/** 按次模型的平台默认价（2 分钱 = 2 积分，和 API 侧保持一致）。 */
const DEFAULT_REQUEST_PRICE_LABEL = "2 积分/次";

function modelBilling(model: AgentModel) {
  return model.billing === "token" ? "token" : "request";
}

function modelMetaLabel(model: AgentModel) {
  if (model.meta) return model.meta;
  return modelBilling(model) === "token" ? "按 Token 计费" : DEFAULT_REQUEST_PRICE_LABEL;
}

export type VendorGroup = { id: string; label: string; models: AgentModel[] };

/**
 * 分类口径与模型广场一致：按厂商聚合（GLM 一个 tab、DeepSeek 一个 tab…），
 * 而不是按「按次 / 按量」把同一家模型拆开。厂商来自 API 的 group 字段；
 * 缺组信息的模型并入「其他」，永远排在最后。
 */
function groupByVendor(models: AgentModel[]): VendorGroup[] {
  const all = new Map<string, VendorGroup>();
  for (const model of models) {
    const label = model.group?.trim() || "其他";
    const existing = all.get(label);
    if (existing) existing.models.push(model);
    else all.set(label, { id: label, label, models: [model] });
  }
  const groups = [...all.values()];
  // 模型多的厂商排前面；数量相同保持目录顺序（Array.sort 稳定），「其他」永远贴底。
  return groups.sort((left, right) => {
    if (left.label === "其他") return all.size > 1 ? 1 : 0;
    if (right.label === "其他") return -1;
    return right.models.length - left.models.length;
  });
}

/** 每个 tab 的模型：按次在前、按量贴底，同计费内保持目录顺序。 */
function orderModels(models: AgentModel[]) {
  return [
    ...models.filter((model) => modelBilling(model) === "request"),
    ...models.filter((model) => modelBilling(model) === "token"),
  ];
}

/** 选择器展示用的分组结果：厂商 tab + 每个 tab 内已排序的模型。 */
export function agentModelVendorGroups(models: AgentModel[]): VendorGroup[] {
  return groupByVendor(models).map((group) => ({ ...group, models: orderModels(group.models) }));
}

/**
 * Agent 模型选择器：分类复用模型广场的厂商口径，但面板不再挤在抽屉里竖排——
 * 它挂到 body 上用 portal 横向铺开（左侧厂商 tab + 右侧模型列表），并按可用
 * 视口自动向上/向下、左右夹取，避免被抽屉裁切。
 */
export function AgentModelSelect({
  value,
  models,
  disabled = false,
  onChange,
  ariaLabel,
  placeholder = "选择模型",
}: {
  value: string;
  models: AgentModel[];
  disabled?: boolean;
  onChange: (modelId: string) => void;
  ariaLabel: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeGroup, setActiveGroup] = useState<string>("");
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = models.find((model) => model.id === value) ?? null;
  const groups = useMemo(() => agentModelVendorGroups(models), [models]);
  const selectedGroup = selected ? selected.group?.trim() || "其他" : "";

  useEffect(() => {
    if (!open) return;
    setActiveGroup(groups.some((group) => group.id === selectedGroup) ? selectedGroup : groups[0]?.id ?? "");
  }, [open, selectedGroup, groups]);

  // 面板锚在触发按钮上并向两侧铺开；上方放不下才翻到下方。
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const MENU_WIDTH = 720;
    const MENU_HEIGHT = 380;
    const place = () => {
      const rect = triggerRef.current!.getBoundingClientRect();
      const inset = 12;
      const gap = 8;
      const width = Math.min(MENU_WIDTH, window.innerWidth - inset * 2);
      const spaceAbove = rect.top - gap - inset;
      const openAbove = spaceAbove >= MENU_HEIGHT || spaceAbove >= window.innerHeight - rect.bottom - gap - inset;
      const maxHeight = Math.max(220, Math.min(MENU_HEIGHT, openAbove ? spaceAbove : window.innerHeight - rect.bottom - gap - inset));
      const left = Math.max(inset, Math.min(rect.left, window.innerWidth - width - inset));
      setMenuStyle({
        left,
        width,
        maxHeight,
        ...(openAbove ? { bottom: window.innerHeight - rect.top + gap } : { top: rect.bottom + gap }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 只收起模型面板，不要冒泡触发抽屉自身的快捷键。
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

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const active = groups.find((group) => group.id === activeGroup) ?? groups[0] ?? null;
  const visible = active?.models ?? [];

  const renderOption = (model: AgentModel) => {
    const isActive = model.id === value;
    return (
      <button
        key={model.id}
        type="button"
        role="option"
        aria-selected={isActive}
        className={isActive ? "is-selected" : undefined}
        title={model.detail ?? model.label}
        onClick={() => {
          onChange(model.id);
          setOpen(false);
        }}
      >
        <span className="kc-cat-select-option-copy">
          <strong>{model.label}</strong>
          <span className="kc-cat-select-option-price">{modelMetaLabel(model)}</span>
        </span>
        {isActive ? <Check aria-hidden="true" className="kc-cat-select-check" /> : null}
      </button>
    );
  };

  return (
    <div className="kc-cat-select kc-agent-model-select" ref={rootRef} data-value={value}>
      <button
        ref={triggerRef}
        type="button"
        className="kc-cat-select-trigger"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled || !models.length}
        onClick={() => setOpen((current) => !current)}
      >
        <Sparkles aria-hidden="true" className="kc-cat-select-icon" />
        <span className="kc-cat-select-value">{selected?.label ?? placeholder}</span>
        {selected ? <span className="kc-cat-select-meta">{modelMetaLabel(selected)}</span> : null}
        <ChevronDown aria-hidden="true" className="kc-cat-select-caret" />
      </button>
      {open ? createPortal(
        <div
          ref={menuRef}
          className="kc-cat-select-menu kc-agent-model-menu"
          role="listbox"
          aria-label={ariaLabel}
          style={menuStyle}
          data-kc-preserve-drawers
        >
          {groups.length > 1 ? (
            <div className="kc-cat-select-tabs kc-agent-model-tabs" role="tablist" aria-label="模型厂商">
              {groups.map((group) => (
                <button
                  key={group.id}
                  type="button"
                  role="tab"
                  aria-selected={group.id === active?.id}
                  className={group.id === active?.id ? "is-active" : undefined}
                  title={`${group.label}（${group.models.length}）`}
                  onClick={() => setActiveGroup(group.id)}
                >
                  <span>{group.label}</span>
                  <i aria-hidden="true">{group.models.length}</i>
                </button>
              ))}
            </div>
          ) : null}
          <div className="kc-cat-select-options">
            {visible.map(renderOption)}
          </div>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
