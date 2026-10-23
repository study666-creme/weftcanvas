import { create } from "zustand";

/**
 * 画布外壳状态：面板开关（设置中心 / 资源抽屉 / 活动面板 / 快捷键）+ 浮动覆层的落位。
 *
 * 这些面板原本各自持有本地 useState，Agent 动作在 React 之外执行、无法驱动它们。
 * 提升到这个 store 后，画布顶栏/dock 的按钮与 Agent 的 ui_* 动作共用同一份状态，
 * 谁都能开、谁都能关，且不会各写各的导致重复打开。
 *
 * 浮动覆层同理：输入框是 portal 出来的，节点功能栏在 ReactFlow 里，
 * 两者只能靠一份共同状态对上话（见 promptAboveNodeId）。
 *
 * 资产库（project-asset-store）与项目库（project-library-store）本就有独立 store，
 * Agent 直接调用它们，这里不重复登记。
 */
export type SettingsSection = "ui" | "apis" | "models" | "local" | "collaboration" | "plugins";
export type ResourceTab = "cards" | "assets";

type UiShellState = {
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  /**
   * 界面设置（视觉 / 交互）是独立面板，不再挂在设置中心里：设置中心只留
   * API 配置 / 模型 / 本地保存 / 协作 / 插件。两个开关互不影响，各自有入口。
   */
  appearanceOpen: boolean;
  resourceOpen: boolean;
  resourceTab: ResourceTab;
  activityOpen: boolean;
  shortcutsOpen: boolean;
  /**
   * 生成输入框贴在哪个节点的**上方**（`data-placement="above"`）；null = 没有输入框，
   * 或它贴在节点下方。输入框在上方时正好压住节点自己的功能栏，节点据此把功能栏翻到
   * 下面去（用户：「输入框在上面的时候，节点上方的功能栏会被挡住，此时应该功能栏到
   * 下面去」）。写这份状态的是输入框自己——它是唯一知道真实摆放方位的人，别人去量
   * DOM 只会晚一拍。
   */
  promptAboveNodeId: string | null;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  toggleSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;
  openAppearance: () => void;
  closeAppearance: () => void;
  toggleAppearance: () => void;
  openResource: (tab?: ResourceTab) => void;
  closeResource: () => void;
  setResourceTab: (tab: ResourceTab) => void;
  setActivityOpen: (open: boolean) => void;
  toggleActivity: () => void;
  setShortcutsOpen: (open: boolean) => void;
  setPromptAboveNodeId: (nodeId: string | null) => void;
};

export const useUiShellStore = create<UiShellState>((set, get) => ({
  settingsOpen: false,
  settingsSection: "apis",
  appearanceOpen: false,
  resourceOpen: false,
  resourceTab: "assets",
  activityOpen: false,
  shortcutsOpen: false,
  promptAboveNodeId: null,
  // 「界面」已从设置中心拆出去：Agent 或旧入口传 ui 时直接开界面设置面板。
  openSettings: (section) =>
    section === "ui"
      ? set({ appearanceOpen: true, settingsOpen: false })
      : set({
          settingsOpen: true,
          appearanceOpen: false,
          ...(section ? { settingsSection: section } : {}),
        }),
  closeSettings: () => set({ settingsOpen: false }),
  toggleSettings: () => set({ settingsOpen: !get().settingsOpen }),
  setSettingsSection: (settingsSection) => set({ settingsSection }),
  // 两个面板同时只开一个：都是贴右侧的浮层，叠着开会互相遮。
  openAppearance: () => set({ appearanceOpen: true, settingsOpen: false }),
  closeAppearance: () => set({ appearanceOpen: false }),
  toggleAppearance: () => set({ appearanceOpen: !get().appearanceOpen, settingsOpen: false }),
  openResource: (tab) =>
    set(tab ? { resourceOpen: true, resourceTab: tab } : { resourceOpen: true }),
  closeResource: () => set({ resourceOpen: false }),
  setResourceTab: (resourceTab) => set({ resourceTab }),
  setActivityOpen: (activityOpen) => set({ activityOpen }),
  toggleActivity: () => set({ activityOpen: !get().activityOpen }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setPromptAboveNodeId: (nodeId) => {
    // 输入框每帧都会上报方位，值没变就一声不响，别把订阅者摇醒。
    if (get().promptAboveNodeId === nodeId) return;
    set({ promptAboveNodeId: nodeId });
  },
}));
