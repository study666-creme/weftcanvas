import {
  normalizeDirectorStagePacket,
  type AgentAction,
  type DirectorStagePacket,
} from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  createDirectorStagePacketFromText,
  type DirectorStageSourceMode,
} from "../lib/director-stage-source";

type DirectorStageLaunchState = {
  open: boolean;
  launchId: number;
  sourceNodeId: string | null;
  initialPacket: DirectorStagePacket | null;
  pendingAgentActions: DirectorAgentAction[];
  openStandalone: () => void;
  openFromNode: (nodeId: string, body: string) => DirectorStageSourceMode;
  runAgentActions: (actions: AgentAction[]) => number;
  completeAgentAction: () => void;
  close: () => void;
};

type DirectorAgentAction = Extract<
  AgentAction,
  {
    type: "canvas_director_select_shot" | "canvas_director_update_entity";
  }
>;

export const useDirectorStageLaunchStore = create<DirectorStageLaunchState>((set, get) => ({
  open: false,
  launchId: 0,
  sourceNodeId: null,
  initialPacket: null,
  pendingAgentActions: [],
  openStandalone: () =>
    set({
      open: true,
      launchId: get().launchId + 1,
      sourceNodeId: null,
      initialPacket: null,
      pendingAgentActions: [],
    }),
  openFromNode: (sourceNodeId, body) => {
    const source = createDirectorStagePacketFromText(body);
    set({
      open: true,
      launchId: get().launchId + 1,
      sourceNodeId,
      initialPacket: source.packet,
      pendingAgentActions: [],
    });
    return source.mode;
  },
  runAgentActions: (actions) => {
    const directorActions = actions.filter((action) => action.type.startsWith("canvas_director_"));
    if (!directorActions.length) return 0;
    const state = get();
    let packet: DirectorStagePacket | null = null;
    const pending: DirectorAgentAction[] = [];
    for (const action of directorActions) {
      if (action.type === "canvas_director_load_packet")
        packet = normalizeDirectorStagePacket(action.packet);
      else if (
        action.type === "canvas_director_select_shot" ||
        action.type === "canvas_director_update_entity"
      )
        pending.push(action);
    }
    const shouldRemount = Boolean(packet) || !state.open;
    set({
      open: true,
      launchId: shouldRemount ? state.launchId + 1 : state.launchId,
      sourceNodeId: null,
      ...(packet ? { initialPacket: packet } : shouldRemount ? { initialPacket: null } : {}),
      pendingAgentActions: [...state.pendingAgentActions, ...pending],
    });
    return directorActions.length;
  },
  completeAgentAction: () =>
    set((state) => ({ pendingAgentActions: state.pendingAgentActions.slice(1) })),
  close: () => set({ open: false }),
}));
