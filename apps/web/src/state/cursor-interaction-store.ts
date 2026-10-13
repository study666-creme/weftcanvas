import { create } from "zustand";

/**
 * 自绘光标的手势态通道：画布工作区把空格平移手势推上来，全局挂载的 AppCursor
 * 订阅它。放独立 store 而不是 props，是为了让 App 顶层不为空格按下/抬起重渲染
 * 整棵路由树——只有光标组件自己更新。
 */
type CursorInteractionState = {
  panActive: boolean;
  setPanActive: (active: boolean) => void;
};

export const useCursorInteractionStore = create<CursorInteractionState>((set) => ({
  panActive: false,
  setPanActive: (panActive) => set({ panActive }),
}));
