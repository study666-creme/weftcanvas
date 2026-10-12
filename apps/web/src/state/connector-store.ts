import type {
  AgentConnector,
  AgentConnectorId,
  AgentConnectorUpdateRequest,
} from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  CanvasApiError,
  connectAgentConnector,
  fetchAgentConnectors,
  updateAgentConnector,
} from "../lib/api-client";
import { useIdentityStore } from "./identity-store";

type ConnectorStatus = "idle" | "loading" | "ready" | "error";

const FRESH_MS = 20_000;

type ConnectorState = {
  items: AgentConnector[];
  status: ConnectorStatus;
  error: string | null;
  /** 正在接入或保存的连接 id。 */
  saving: AgentConnectorId | null;
  loadedAt: number;
  load: (force?: boolean) => Promise<void>;
  connect: (id: AgentConnectorId, options?: { launch?: boolean }) => Promise<AgentConnector | null>;
  update: (id: AgentConnectorId, patch: AgentConnectorUpdateRequest) => Promise<boolean>;
  reset: () => void;
};

let loadVersion = 0;

export const useConnectorStore = create<ConnectorState>((set, get) => ({
  items: [],
  status: "idle",
  error: null,
  saving: null,
  loadedAt: 0,

  load: async (force = false) => {
    // 本机连接属于账号级设置：未登录时不探测，也不显示假状态。
    if (useIdentityStore.getState().status !== "authenticated") {
      set({ items: [], status: "idle", error: null, loadedAt: 0 });
      return;
    }
    const state = get();
    if (!force && state.status === "loading") return;
    if (!force && state.loadedAt && Date.now() - state.loadedAt < FRESH_MS) return;
    const version = ++loadVersion;
    set({ status: "loading", error: state.items.length ? state.error : null });
    try {
      const items = await fetchAgentConnectors(force);
      if (version !== loadVersion) return;
      set({ items, status: "ready", error: null, loadedAt: Date.now() });
    } catch (cause) {
      if (version !== loadVersion) return;
      const message = cause instanceof CanvasApiError ? cause.message : "本机连接状态暂时读不到";
      set({ status: "error", error: message, loadedAt: Date.now() });
    }
  },

  connect: async (id, options = {}) => {
    if (get().saving) return null;
    set({ saving: id, error: null });
    try {
      const connector = await connectAgentConnector(id, options);
      set((state) => ({
        items: state.items.some((item) => item.id === connector.id)
          ? state.items.map((item) => (item.id === connector.id ? connector : item))
          : [...state.items, connector],
        status: "ready",
        loadedAt: Date.now(),
      }));
      return connector;
    } catch (cause) {
      set({
        error: cause instanceof CanvasApiError ? cause.message : "一键接入没有完成",
        loadedAt: Date.now(),
      });
      return null;
    } finally {
      set({ saving: null });
    }
  },

  update: async (id, patch) => {
    if (get().saving) return false;
    set({ saving: id, error: null });
    try {
      const connector = await updateAgentConnector(id, patch);
      set((state) => ({
        items: state.items.map((item) => (item.id === connector.id ? connector : item)),
        status: "ready",
        loadedAt: Date.now(),
      }));
      return true;
    } catch (cause) {
      set({
        error: cause instanceof CanvasApiError ? cause.message : "连接设置没有保存成功",
      });
      return false;
    } finally {
      set({ saving: null });
    }
  },

  reset: () => {
    loadVersion += 1;
    set({ items: [], status: "idle", error: null, saving: null, loadedAt: 0 });
  },
}));
