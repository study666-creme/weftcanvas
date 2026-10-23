/**
 * 快捷键面板的键帽文案。
 *
 * 以前每一项拆成两个键帽（`Ctrl / ⌘` + `A`），第一颗既不是按键也不是组合，
 * 看着像个没填完的占位符，用户得自己拼。现在一个组合只出一颗键帽：
 * Windows / Linux 是 `Ctrl+A`，macOS 是 `⌘+A`，读到什么就是按什么。
 */

/** macOS 的修饰键符号；其余平台原样用 Ctrl / Shift / Alt 全文。 */
const MAC_SYMBOLS: Readonly<Record<string, string>> = {
  Ctrl: "⌘",
  Cmd: "⌘",
  Meta: "⌘",
  Shift: "⇧",
  Alt: "⌥",
  Option: "⌥",
  Enter: "↩",
};

/**
 * 把语义键位拼成一颗键帽的文案。
 * 分隔符统一用 `+`：`⌘+A` 与中文键位（`Ctrl+滚轮`）都能读通，也不会因为
 * 平台不同把同一行排版撑成两种宽度。
 */
export function formatShortcutKeys(keys: readonly string[], mac: boolean): string {
  return keys.map((key) => (mac ? (MAC_SYMBOLS[key] ?? key) : key)).join("+");
}

/** 只用来决定显示 `⌘` 还是 `Ctrl`，判断不出来就按非 mac 处理。 */
export function detectMacPlatform(userAgent?: string, platform?: string): boolean {
  const haystack = `${platform ?? ""} ${userAgent ?? ""}`;
  return /mac|iphone|ipad|ipod/i.test(haystack);
}
