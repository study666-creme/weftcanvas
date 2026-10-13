import { create } from "zustand";

/**
 * 主题切换的**命令桥**。
 *
 * 主题的落地（写 data-theme、持久化、View Transition 交叉淡化）耦合在 App 的
 * React 生命周期里，不能整体搬进 store。这里只承载「要切到哪个主题」的意图：
 * Agent 的 ui_set_theme 动作在 React 之外调用 requestTheme，App 订阅 command
 * 变化后用它自己的 applyTheme 落地。nonce 保证同一动作连发也能触发 effect。
 */
export type ThemeAction = "light" | "dark" | "auto" | "toggle";

type ThemeCommandState = {
  command: { action: ThemeAction; nonce: number } | null;
  requestTheme: (action: ThemeAction) => void;
};

export const useThemeCommandStore = create<ThemeCommandState>((set) => ({
  command: null,
  requestTheme: (action) =>
    set((state) => ({ command: { action, nonce: (state.command?.nonce ?? 0) + 1 } })),
}));
