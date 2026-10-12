export type ThemeMode = "light" | "dark";
export type ThemeScheduleMode = "auto" | "manual";

export const THEME_STORAGE_KEY = "weftcanvas:theme";
export const THEME_MODE_STORAGE_KEY = "weftcanvas:theme-mode";

/** 自动日程：每天 08:00 切白天，19:00 切黑夜。 */
export const THEME_DAY_HOUR = 8;
export const THEME_NIGHT_HOUR = 19;

export function themeForHour(hour: number): ThemeMode {
  return hour >= THEME_DAY_HOUR && hour < THEME_NIGHT_HOUR ? "light" : "dark";
}

export function autoThemeNow(now = new Date()): ThemeMode {
  return themeForHour(now.getHours());
}

export function readThemeMode(): ThemeScheduleMode {
  try {
    const stored = localStorage.getItem(THEME_MODE_STORAGE_KEY);
    if (stored === "manual") return "manual";
  } catch {
    // 受限环境下默认跟随自动日程。
  }
  return "auto";
}

export function persistThemeMode(mode: ThemeScheduleMode) {
  try {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
  } catch {
    // 会话内仍然可用。
  }
}

export function persistTheme(theme: ThemeMode) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 会话内仍然可用。
  }
}

/**
 * 初始主题：手动模式读已存偏好；自动模式按当前时刻计算（首帧即正确，
 * index.html 的引导脚本用同一份逻辑避免加载闪色）。
 */
export function initialTheme(): ThemeMode {
  if (readThemeMode() === "manual") {
    try {
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored === "light" || stored === "dark") return stored;
    } catch {
      // 受限环境下退回自动日程。
    }
  }
  return autoThemeNow();
}

/**
 * 距下一次自动切换（08:00 / 19:00）的毫秒数；用于安排下一次校正。
 * 注意浏览器休眠时定时器会被暂停，回来后应立即重算——调用方在
 * visibilitychange 时同步一次即可，不需要依赖该值的精度。
 */
export function msUntilNextThemeFlip(now = new Date()): number {
  const next = new Date(now);
  next.setSeconds(0, 0);
  const targetHour =
    now.getHours() < THEME_DAY_HOUR
      ? THEME_DAY_HOUR
      : now.getHours() < THEME_NIGHT_HOUR
        ? THEME_NIGHT_HOUR
        : THEME_DAY_HOUR;
  if (now.getHours() >= THEME_NIGHT_HOUR) next.setDate(next.getDate() + 1);
  next.setHours(targetHour, 0, 0, 0);
  return Math.max(1_000, next.getTime() - now.getTime());
}
