import { create } from "zustand";

/**
 * 画布节点 → Agent 的引用连线。
 *
 * 不写进画布文档：Agent 不是画布节点，链接也不该被撤销栈、项目导出或
 * Agent 画布摘要当成真实节点关系。这里按项目持久化在浏览器本地，发送消息
 * 时由抽屉把被引用节点的素材读出来作为本轮附件。
 */
const STORAGE_KEY = "weftcanvas:agent-links:v1";
export const MAX_AGENT_LINKED_NODES = 8;

type LinkMap = Record<string, string[]>;

type AgentLinkState = {
  linksByProject: LinkMap;
  toggle: (projectId: string, nodeId: string) => void;
  remove: (projectId: string, nodeId: string) => void;
  prune: (projectId: string, validNodeIds: ReadonlySet<string>) => void;
  clear: (projectId: string) => void;
};

function readStoredLinks(): LinkMap {
  if (typeof localStorage === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: LinkMap = {};
    for (const [projectId, value] of Object.entries(parsed)) {
      if (!Array.isArray(value)) continue;
      const ids = [
        ...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0)),
      ].slice(0, MAX_AGENT_LINKED_NODES);
      if (ids.length) result[projectId] = ids;
    }
    return result;
  } catch {
    return {};
  }
}

function writeStoredLinks(value: LinkMap) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // 本地存储不可用时不阻断对话；这次连线只在当前会话有效。
  }
}

function update(
  state: AgentLinkState,
  projectId: string,
  next: string[],
): Pick<AgentLinkState, "linksByProject"> {
  const linksByProject = { ...state.linksByProject };
  if (next.length) linksByProject[projectId] = next;
  else delete linksByProject[projectId];
  writeStoredLinks(linksByProject);
  return { linksByProject };
}

export const useAgentLinkStore = create<AgentLinkState>((set) => ({
  linksByProject: readStoredLinks(),
  toggle: (projectId, nodeId) =>
    set((state) => {
      const current = state.linksByProject[projectId] ?? [];
      if (current.includes(nodeId)) {
        return update(
          state,
          projectId,
          current.filter((id) => id !== nodeId),
        );
      }
      if (current.length >= MAX_AGENT_LINKED_NODES) return state;
      return update(state, projectId, [...current, nodeId]);
    }),
  remove: (projectId, nodeId) =>
    set((state) =>
      update(
        state,
        projectId,
        (state.linksByProject[projectId] ?? []).filter((id) => id !== nodeId),
      ),
    ),
  prune: (projectId, validNodeIds) =>
    set((state) => {
      const current = state.linksByProject[projectId];
      if (!current?.length) return state;
      const next = current.filter((id) => validNodeIds.has(id));
      if (next.length === current.length) return state;
      return update(state, projectId, next);
    }),
  clear: (projectId) => set((state) => update(state, projectId, [])),
}));

const EMPTY_LINKS: string[] = [];

export function useAgentLinkedNodeIds(projectId: string) {
  return useAgentLinkStore((state) => state.linksByProject[projectId] ?? EMPTY_LINKS);
}
