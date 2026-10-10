import { createId } from "@kachang/canvas-core";
import { create } from "zustand";

export type ToastTone = "info" | "success" | "error";

export type ToastItem = {
  id: string;
  message: string;
  tone: ToastTone;
};

type ToastState = {
  items: ToastItem[];
  show: (message: string, tone?: ToastTone) => void;
  dismiss: (id: string) => void;
};

export const useToastStore = create<ToastState>((set, get) => ({
  items: [],
  show: (message, tone = "info") => {
    const id = createId("toast");
    set((state) => ({ items: [...state.items, { id, message, tone }].slice(-3) }));
    window.setTimeout(() => get().dismiss(id), 3200);
  },
  dismiss: (id) => set((state) => ({ items: state.items.filter((item) => item.id !== id) })),
}));
