import { describe, expect, it } from "vitest";

import { detectMacPlatform, formatShortcutKeys } from "./shortcut-labels";

describe("快捷键键帽文案", () => {
  it("Windows / Linux 直接写 Ctrl+A，不再拆成两颗键帽", () => {
    expect(formatShortcutKeys(["Ctrl", "A"], false)).toBe("Ctrl+A");
    expect(formatShortcutKeys(["Ctrl", "Shift", "G"], false)).toBe("Ctrl+Shift+G");
    expect(formatShortcutKeys(["Delete"], false)).toBe("Delete");
  });

  it("macOS 用修饰键符号，仍是同一个组合一个字符串", () => {
    expect(formatShortcutKeys(["Ctrl", "A"], true)).toBe("⌘+A");
    expect(formatShortcutKeys(["Ctrl", "Shift", "G"], true)).toBe("⌘+⇧+G");
  });

  it("中文键位与单个按键原样透出", () => {
    expect(formatShortcutKeys(["Ctrl", "滚轮"], false)).toBe("Ctrl+滚轮");
    expect(formatShortcutKeys(["空格"], true)).toBe("空格");
    expect(formatShortcutKeys(["?", "F1"], false)).toBe("?+F1");
  });

  it("平台判断认 mac / iPad，判不出来按非 mac 处理", () => {
    expect(detectMacPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)", "MacIntel")).toBe(
      true,
    );
    expect(detectMacPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)", "iPad")).toBe(true);
    expect(detectMacPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", "Win32")).toBe(false);
    expect(detectMacPlatform(undefined, undefined)).toBe(false);
  });
});
