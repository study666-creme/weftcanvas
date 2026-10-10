import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  autoThemeNow,
  initialTheme,
  msUntilNextThemeFlip,
  persistTheme,
  persistThemeMode,
  readThemeMode,
  themeForHour,
  THEME_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
} from "./theme-schedule";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe("theme schedule", () => {
  beforeEach(() => {
    vi.stubGlobal("localStorage", memoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps hours onto the day/night schedule", () => {
    expect(themeForHour(7)).toBe("dark");
    expect(themeForHour(8)).toBe("light");
    expect(themeForHour(12)).toBe("light");
    expect(themeForHour(18)).toBe("light");
    expect(themeForHour(19)).toBe("dark");
    expect(themeForHour(23)).toBe("dark");
    expect(themeForHour(0)).toBe("dark");
  });

  it("auto mode resolves from the wall clock", () => {
    expect(autoThemeNow(new Date("2026-09-05T09:30:00"))).toBe("light");
    expect(autoThemeNow(new Date("2026-09-05T20:30:00"))).toBe("dark");
  });

  it("manual mode resolves the persisted preference", () => {
    persistThemeMode("manual");
    persistTheme("light");
    expect(readThemeMode()).toBe("manual");
    expect(initialTheme()).toBe("light");
    // 手动模式与时程不一致时仍尊重用户选择。
    persistTheme("dark");
    expect(initialTheme()).toBe("dark");
  });

  it("defaults to auto when nothing is persisted", () => {
    expect(readThemeMode()).toBe("auto");
    // 无手动偏好时按当前时刻取值。
    expect(initialTheme()).toBe(autoThemeNow());
  });

  it("schedules the next flip at the hour boundaries", () => {
    // 09:00 -> 19:00 当日；20:00 -> 次日 08:00；07:00 -> 当日 08:00。
    expect(msUntilNextThemeFlip(new Date("2026-09-05T09:00:00"))).toBe(10 * 60 * 60 * 1000);
    expect(msUntilNextThemeFlip(new Date("2026-09-05T20:00:00"))).toBe(12 * 60 * 60 * 1000);
    expect(msUntilNextThemeFlip(new Date("2026-09-05T07:00:00"))).toBe(60 * 60 * 1000);
    // 边界后一秒仍指向下一个边界，绝不返回 0 或负数。
    expect(msUntilNextThemeFlip(new Date("2026-09-05T19:00:01"))).toBeGreaterThan(0);
  });

  it("uses the shared storage keys", () => {
    expect(THEME_STORAGE_KEY).toBe("kachang-canvas:theme");
    expect(THEME_MODE_STORAGE_KEY).toBe("kachang-canvas:theme-mode");
  });
});
