import { create } from "zustand";

/**
 * 画布外壳面板的开关状态（设置中心 / 资源抽屉 / 活动面板 / 快捷键）。
 *
 * 这些面板原本各自持有本地 useState，Agent 动作在 React 之外执行、无法驱动它们。
 * 提升到这个 store 后，画布顶栏/dock 的按钮与 Agent 的 ui_* 动作共用同一份状态，
 * 谁都能开、谁都能关，且不会各写各的导致重复打开。
 *
 * 资产库（project-asset-store）与项目库（project-library-store）本就有独立 store，
 * Agent 直接调用它们，这里不重复登记。
 */
export type SettingsSection = "ui" | "apis" | "models" | "local" | "collaboration" | "plugins";
export type ResourceTab = "cards" | "assets";

type UiShellState = {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  resourceOpen: boolean;
  resourceTab: ResourceTab;
  activityOpen: boolean;
  shortcutsOpen: boolean;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  openResource: (tab?: ResourceTab) => void;
  closeResource: () => void;
  setResourceTab: (tab: ResourceTab) => void;
  setActivityOpen: (open: boolean) => void;
  toggleActivity: () => void;
  setShortcutsOpen: (open: boolean) => void;
};

export const useUiShellStore = create<UiShellState>((set, get) => ({
  settingsOpen: false,
  settingsSection: "ui",
  resourceOpen: false,
  resourceTab: "assets",
  activityOpen: false,
  shortcutsOpen: false,
  openSettings: (section) =>
    set(section ? { settingsOpen: true, settingsSection: section } : { settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  openResource: (tab) =>
    set(tab ? { resourceOpen: true, resourceTab: tab } : { resourceOpen: true }),
  closeResource: () => set({ resourceOpen: false }),
  setResourceTab: (resourceTab) => set({ resourceTab }),
  setActivityOpen: (activityOpen) => set({ activityOpen }),
  toggleActivity: () => set({ activityOpen: !get().activityOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
}));
