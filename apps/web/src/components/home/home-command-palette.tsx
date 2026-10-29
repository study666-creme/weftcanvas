import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CornerDownLeft, Search } from "lucide-react";

export type PaletteItem = {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
};

const MAX_PER_GROUP = 6;

/** 极简模糊匹配：所有空格分隔的词都要出现（不区分大小写）。 */
function matches(item: PaletteItem, needle: string) {
  if (!needle) return true;
  const haystack = `${item.label} ${item.hint ?? ""} ${item.keywords ?? ""}`.toLocaleLowerCase(
    "zh-CN",
  );
  return needle
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => haystack.includes(part));
}

/**
 * ⌘K / Ctrl+K 全局搜索：操作、项目、作品、模板一处直达。纯键盘可用——
 * ↑↓ 选择，Enter 执行，Esc 关闭；鼠标悬停同步高亮。
 */
export function HomeCommandPalette({
  items,
  onClose,
}: {
  items: PaletteItem[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const groups = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const result: { group: string; items: PaletteItem[] }[] = [];
    for (const item of items) {
      if (!matches(item, needle)) continue;
      let group = result.find((entry) => entry.group === item.group);
      if (!group) {
        group = { group: item.group, items: [] };
        result.push(group);
      }
      if (group.items.length < MAX_PER_GROUP) group.items.push(item);
    }
    return result;
  }, [items, query]);
  const flat = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  let cursor = -1;

  return (
    <div
      className="wc-home-palette-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="wc-home-palette" role="dialog" aria-modal="true" aria-label="搜索与快捷操作">
        <label className="wc-home-palette-input">
          <Search aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索项目、作品、模板，或输入要做的事…"
            aria-label="搜索"
            role="combobox"
            aria-expanded="true"
            aria-controls="wc-home-palette-list"
            aria-activedescendant={flat[index] ? `wc-palette-${flat[index].id}` : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown") {
                event.preventDefault();
                setIndex((current) => (flat.length ? (current + 1) % flat.length : 0));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setIndex((current) =>
                  flat.length ? (current - 1 + flat.length) % flat.length : 0,
                );
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                run(flat[index]);
              }
            }}
          />
          <kbd>Esc</kbd>
        </label>
        <div
          className="wc-home-palette-list"
          id="wc-home-palette-list"
          role="listbox"
          ref={listRef}
        >
          {groups.length ? (
            groups.map((group) => (
              <div key={group.group} role="group" aria-label={group.group}>
                <span className="wc-home-palette-group">{group.group}</span>
                {group.items.map((item) => {
                  cursor += 1;
                  const position = cursor;
                  return (
                    <button
                      key={item.id}
                      id={`wc-palette-${item.id}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      data-index={position}
                      aria-selected={position === index}
                      className={position === index ? "is-active" : undefined}
                      onMouseMove={() => setIndex(position)}
                      onClick={() => run(item)}
                    >
                      <span className="wc-home-palette-icon" aria-hidden="true">
                        {item.icon}
                      </span>
                      <span className="wc-home-palette-label">{item.label}</span>
                      {item.hint ? <span className="wc-home-palette-hint">{item.hint}</span> : null}
                      {position === index ? (
                        <CornerDownLeft className="wc-home-palette-enter" aria-hidden="true" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          ) : (
            <p className="wc-home-palette-empty">没有找到「{query}」相关的内容</p>
          )}
        </div>
      </div>
    </div>
  );
}
