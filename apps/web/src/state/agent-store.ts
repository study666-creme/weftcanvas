import {
  agentExecutionPermissionSchema,
  agentModelCatalogSchema,
  agentModelIdSchema,
  agentSkillLimits,
  type AgentCanvasContext,
  type AgentConversation,
  type AgentConversationDetail,
  type AgentExecutionPermission,
  type AgentExecutionReceiptCreateRequest,
  type AgentModelCatalog,
  type AgentSkillSummary,
} from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  CanvasApiError,
  cancelAgentRun,
  confirmAgentProposal,
  createAgentConversation,
  createRequestKey,
  deleteAgentSkill,
  dismissAgentProposal,
  fetchAgentConversation,
  fetchAgentModels,
  importAgentSkill,
  listAgentConversations,
  listAgentSkills,
  recordAgentExecutionReceipt,
  submitAgentMessage,
} from "../lib/api-client";
import { useIdentityStore } from "./identity-store";

type AgentUiStatus = "idle" | "loading" | "sending" | "ready" | "error";
type AgentModelStatus = "idle" | "loading" | "ready" | "error";
type AgentSkillsStatus = "idle" | "loading" | "ready" | "error";

const MODEL_STORAGE_KEY = "weftcanvas:agent-model:v1";
const SKILLS_STORAGE_KEY = "weftcanvas:agent-skills:v1";
const PERMISSION_STORAGE_KEY = "weftcanvas:agent-permission:v1";
const DEFAULT_EXECUTION_PERMISSION: AgentExecutionPermission = "request_approval";
const MODEL_REFRESH_INTERVAL_MS = 60_000;
const MODEL_MAX_STALE_MS = 7 * 24 * 60 * 60_000;

type AgentState = {
  open: boolean;
  projectId: string | null;
  conversations: AgentConversation[];
  activeConversationId: string | null;
  detail: AgentConversationDetail | null;
  status: AgentUiStatus;
  error: string | null;
  models: AgentModelCatalog["models"];
  modelStatus: AgentModelStatus;
  modelRefreshing: boolean;
  modelLoadedAt: number;
  modelError: string | null;
  selectedModelId: string | null;
  /** 思考强度档位；null 表示当前模型不支持调节。 */
  reasoningEffort: string | null;
  /** 本账号导入的技能清单；null 表示还没有拉取过（打开技能面板时才加载）。 */
  skills: AgentSkillSummary[] | null;
  skillsStatus: AgentSkillsStatus;
  skillsError: string | null;
  /** 下一轮启用的技能 id，按启用顺序保存，上限 enabledPerRun。 */
  selectedSkillIds: string[];
  /** 执行权限档：决定 Agent 能不能直接改画布。 */
  executionPermission: AgentExecutionPermission;
  toggle: () => void;
  close: () => void;
  reset: () => void;
  load: (projectId: string, force?: boolean) => Promise<void>;
  loadModels: (force?: boolean) => Promise<void>;
  setSelectedModelId: (modelId: string) => void;
  setReasoningEffort: (effort: string | null) => void;
  loadSkills: () => Promise<void>;
  importSkill: (content: string) => Promise<AgentSkillSummary>;
  removeSkill: (skillId: string) => Promise<void>;
  toggleSkill: (skillId: string) => void;
  setExecutionPermission: (permission: AgentExecutionPermission) => void;
  createConversation: (projectId: string) => Promise<string | null>;
  selectConversation: (conversationId: string) => Promise<void>;
  send: (projectId: string, content: string, context: AgentCanvasContext) => Promise<boolean>;
  cancel: () => Promise<void>;
  confirmProposal: (contextRevision: string) => Promise<boolean>;
  dismissProposal: () => Promise<boolean>;
  recordReceipt: (
    conversationId: string,
    runId: string,
    receipt: AgentExecutionReceiptCreateRequest,
  ) => Promise<boolean>;
};

let loadVersion = 0;
let modelLoadVersion = 0;
let modelRequest: Promise<void> | null = null;
let skillsRequest: Promise<void> | null = null;
let pollTimer: number | null = null;
const storedModelState = readStoredModelState();
const storedSkillIds = readStoredSkillIds();
const storedExecutionPermission = readStoredExecutionPermission();

export const useAgentStore = create<AgentState>((set, get) => ({
  open: false,
  projectId: null,
  conversations: [],
  activeConversationId: null,
  detail: null,
  status: "idle",
  error: null,
  models: storedModelState.models,
  modelStatus: storedModelState.models.length ? "ready" : "idle",
  modelRefreshing: false,
  modelLoadedAt: storedModelState.loadedAt,
  modelError: null,
  selectedModelId: storedModelState.modelId,
  reasoningEffort: defaultThinkingFor(storedModelState.models, storedModelState.modelId),
  skills: null,
  skillsStatus: "idle",
  skillsError: null,
  selectedSkillIds: storedSkillIds,
  executionPermission: storedExecutionPermission,

  toggle: () => set((state) => ({ open: !state.open })),
  close: () => set({ open: false }),
  reset: () => {
    stopPolling();
    loadVersion += 1;
    modelLoadVersion += 1;
    modelRequest = null;
    skillsRequest = null;
    const stored = readStoredModelState();
    set({
      projectId: null,
      conversations: [],
      activeConversationId: null,
      detail: null,
      status: "idle",
      error: null,
      models: stored.models,
      modelStatus: stored.models.length ? "ready" : "idle",
      modelRefreshing: false,
      modelLoadedAt: stored.loadedAt,
      modelError: null,
      selectedModelId: stored.modelId,
      reasoningEffort: defaultThinkingFor(stored.models, stored.modelId),
      // 技能属于账号：换账号后重新拉取；本地启用清单保留，等列表回来后按 id 剪枝。
      skills: null,
      skillsStatus: "idle",
      skillsError: null,
      selectedSkillIds: readStoredSkillIds(),
      executionPermission: readStoredExecutionPermission(),
    });
  },

  load: async (projectId, force = false) => {
    const state = get();
    if (
      !force &&
      state.projectId === projectId &&
      ["loading", "ready", "sending"].includes(state.status)
    )
      return;
    const version = ++loadVersion;
    stopPolling();
    set({
      projectId,
      status: "loading",
      error: null,
      ...(state.projectId === projectId
        ? {}
        : { conversations: [], activeConversationId: null, detail: null }),
    });
    try {
      const conversations = await listAgentConversations(projectId);
      if (version !== loadVersion) return;
      const preferredId = get().activeConversationId;
      const activeConversationId = conversations.some((item) => item.id === preferredId)
        ? preferredId
        : (conversations[0]?.id ?? null);
      const detail = activeConversationId
        ? await fetchAgentConversation(activeConversationId)
        : null;
      if (version !== loadVersion) return;
      set({ conversations, activeConversationId, detail, status: "ready", error: null });
      scheduleIfRunning();
    } catch (cause) {
      if (version !== loadVersion) return;
      handleError(cause, set);
    }
  },

  loadModels: async (force = false) => {
    const state = get();
    if (
      !force &&
      state.models.length &&
      Date.now() - state.modelLoadedAt < MODEL_REFRESH_INTERVAL_MS
    )
      return;
    if (modelRequest) return modelRequest;
    const version = ++modelLoadVersion;
    const hasModels = state.models.length > 0;
    set({ modelStatus: hasModels ? "ready" : "loading", modelRefreshing: true, modelError: null });
    const request = (async () => {
      try {
        const catalog = await fetchAgentModels(force);
        if (version !== modelLoadVersion) return;
        const currentModelId = get().selectedModelId;
        const selectedModelId =
          catalog.models.find((model) => model.id === currentModelId)?.id ?? catalog.defaultModelId;
        set({
          models: catalog.models,
          selectedModelId,
          reasoningEffort: defaultThinkingFor(catalog.models, selectedModelId),
          modelStatus: "ready",
          modelRefreshing: false,
          modelLoadedAt: Date.now(),
          modelError: null,
        });
        writeStoredModelState(selectedModelId, catalog, get().modelLoadedAt);
      } catch (cause) {
        if (version !== modelLoadVersion) return;
        if (cause instanceof CanvasApiError && cause.status === 401)
          useIdentityStore.getState().expire();
        set((current) =>
          current.models.length
            ? { modelStatus: "ready", modelRefreshing: false, modelError: null }
            : { modelStatus: "error", modelRefreshing: false, modelError: publicModelError(cause) },
        );
      }
    })();
    modelRequest = request;
    try {
      await request;
    } finally {
      if (modelRequest === request) modelRequest = null;
    }
  },

  setSelectedModelId: (modelIdValue) => {
    const parsed = agentModelIdSchema.safeParse(modelIdValue);
    if (!parsed.success || !get().models.some((model) => model.id === parsed.data)) return;
    writeStoredModelState(
      parsed.data,
      {
        defaultModelId: get().models[0]?.id ?? parsed.data,
        models: get().models,
      },
      get().modelLoadedAt,
    );
    set({
      selectedModelId: parsed.data,
      reasoningEffort: defaultThinkingFor(get().models, parsed.data),
      modelError: null,
    });
  },

  setReasoningEffort: (effort) => {
    if (effort === null) {
      set({ reasoningEffort: null });
      return;
    }
    const selected = get().models.find((model) => model.id === get().selectedModelId);
    if (!selected?.thinking?.levels.includes(effort)) return;
    set({ reasoningEffort: effort });
  },

  // 技能清单是懒加载：只在第一次打开技能面板时拉一次，之后靠 loadSkills 的
  // 幂等短路复用；导入/删除后由调用方显式重取。
  loadSkills: async () => {
    const state = get();
    if (state.skills !== null && state.skillsStatus !== "error") return;
    if (skillsRequest) return skillsRequest;
    set({ skillsStatus: "loading", skillsError: null });
    const request = (async () => {
      try {
        const skills = await listAgentSkills();
        const known = new Set(skills.map((skill) => skill.id));
        // 服务端已经不存在的技能不能继续启用：导入前遗留的 id 在这里被剪掉。
        const selectedSkillIds = get().selectedSkillIds.filter((id) => known.has(id));
        writeStoredSkillIds(selectedSkillIds);
        set({ skills, skillsStatus: "ready", skillsError: null, selectedSkillIds });
      } catch (cause) {
        if (cause instanceof CanvasApiError && cause.status === 401)
          useIdentityStore.getState().expire();
        // 部署没有技能库（404）不算错误：技能面整体不存在，面板按"未启用"如实说明。
        const unavailable = cause instanceof CanvasApiError && cause.status === 404;
        set({
          skills: unavailable ? [] : get().skills,
          skillsStatus: unavailable ? "ready" : "error",
          skillsError: unavailable ? "当前部署没有启用技能库" : publicSkillsError(cause),
        });
      }
    })();
    skillsRequest = request;
    try {
      await request;
    } finally {
      if (skillsRequest === request) skillsRequest = null;
    }
  },

  importSkill: async (content) => {
    set({ skillsError: null });
    try {
      const skill = await importAgentSkill({ content });
      set((state) => ({
        skills: [skill, ...(state.skills ?? []).filter((item) => item.id !== skill.id)],
        skillsStatus: "ready",
        skillsError: null,
      }));
      return skill;
    } catch (cause) {
      if (cause instanceof CanvasApiError && cause.status === 401)
        useIdentityStore.getState().expire();
      set({ skillsError: publicSkillsError(cause) });
      throw cause;
    }
  },

  removeSkill: async (skillId) => {
    const removed = await deleteAgentSkill(skillId);
    const known = new Set(get().selectedSkillIds.filter((id) => id !== removed.id));
    writeStoredSkillIds([...known]);
    set((state) => ({
      skills: (state.skills ?? []).filter((skill) => skill.id !== removed.id),
      selectedSkillIds: [...known],
      skillsError: null,
    }));
  },

  toggleSkill: (skillId) => {
    const state = get();
    if (state.selectedSkillIds.includes(skillId)) {
      const next = state.selectedSkillIds.filter((id) => id !== skillId);
      writeStoredSkillIds(next);
      set({ selectedSkillIds: next });
      return;
    }
    if (state.selectedSkillIds.length >= agentSkillLimits.enabledPerRun) return;
    const next = [...state.selectedSkillIds, skillId].slice(0, agentSkillLimits.enabledPerRun);
    writeStoredSkillIds(next);
    set({ selectedSkillIds: next });
  },

  setExecutionPermission: (permission) => {
    const parsed = agentExecutionPermissionSchema.safeParse(permission);
    if (!parsed.success) return;
    writeStoredExecutionPermission(parsed.data);
    set({ executionPermission: parsed.data });
  },

  createConversation: async (projectId) => {
    set({ status: "loading", error: null });
    try {
      const conversation = await createAgentConversation({ projectId });
      set((state) => ({
        projectId,
        conversations: [
          conversation,
          ...state.conversations.filter((item) => item.id !== conversation.id),
        ],
        activeConversationId: conversation.id,
        detail: { conversation, messages: [], latestRun: null },
        status: "ready",
        error: null,
      }));
      return conversation.id;
    } catch (cause) {
      handleError(cause, set);
      return null;
    }
  },

  selectConversation: async (conversationId) => {
    const version = ++loadVersion;
    stopPolling();
    set({ activeConversationId: conversationId, detail: null, status: "loading", error: null });
    try {
      const detail = await fetchAgentConversation(conversationId);
      if (version !== loadVersion) return;
      set({ detail, status: "ready", error: null });
      scheduleIfRunning();
    } catch (cause) {
      if (version !== loadVersion) return;
      handleError(cause, set);
    }
  },

  send: async (projectId, content, context) => {
    const trimmed = content.trim();
    if (!trimmed) return false;
    const modelState = get();
    const selectedModelId = modelState.selectedModelId;
    if (
      modelState.modelStatus !== "ready" ||
      !selectedModelId ||
      !modelState.models.some((model) => model.id === selectedModelId)
    ) {
      set({ modelStatus: "error", modelError: "请先选择可用的 Agent 模型" });
      return false;
    }
    stopPolling();
    let conversationId = get().activeConversationId;
    if (!conversationId) conversationId = await get().createConversation(projectId);
    if (!conversationId) return false;
    set({ status: "sending", error: null });
    try {
      // 只带上仍然存在的技能 id：删除后的遗留 id 不该发给服务端。
      const enabledSkillIds = modelState.selectedSkillIds
        .filter((id) => !modelState.skills || modelState.skills.some((skill) => skill.id === id))
        .slice(0, agentSkillLimits.enabledPerRun);
      const detail = await submitAgentMessage(conversationId, {
        content: trimmed,
        idempotencyKey: createRequestKey("agent"),
        modelId: selectedModelId,
        ...(modelState.reasoningEffort ? { reasoningEffort: modelState.reasoningEffort } : {}),
        executionPermission: modelState.executionPermission,
        ...(enabledSkillIds.length ? { skillIds: enabledSkillIds } : {}),
        canvasContext: context,
      });
      set((state) => ({
        detail,
        conversations: [
          detail.conversation,
          ...state.conversations.filter((item) => item.id !== detail.conversation.id),
        ],
        status: "ready",
        error: null,
      }));
      scheduleIfRunning();
      return true;
    } catch (cause) {
      if (cause instanceof CanvasApiError && cause.code === "MODEL_NOT_AVAILABLE") {
        set((state) => ({
          status: "ready",
          error: null,
          modelStatus: state.models.length ? "ready" : "error",
          modelError: state.models.length ? null : cause.message,
        }));
        await get().loadModels(true);
        return false;
      }
      handleError(cause, set);
      return false;
    }
  },

  cancel: async () => {
    const { detail } = get();
    if (!detail?.latestRun || !isActiveRun(detail.latestRun.status)) return;
    stopPolling();
    try {
      const next = await cancelAgentRun(detail.conversation.id, detail.latestRun.id);
      set({ detail: next, status: "ready", error: null });
    } catch (cause) {
      handleError(cause, set);
    }
  },

  confirmProposal: async (contextRevision) => {
    const { detail } = get();
    const run = detail?.latestRun;
    if (!detail || !run || run.executionMode !== "proposal" || run.proposalStatus !== "pending")
      return false;
    set({ status: "sending", error: null });
    try {
      const next = await confirmAgentProposal(detail.conversation.id, run.id, { contextRevision });
      set({ detail: next, status: "ready", error: null });
      return true;
    } catch (cause) {
      handleError(cause, set);
      return false;
    }
  },

  dismissProposal: async () => {
    const { detail } = get();
    const run = detail?.latestRun;
    if (!detail || !run || run.executionMode !== "proposal" || run.proposalStatus !== "pending")
      return false;
    set({ status: "sending", error: null });
    try {
      const next = await dismissAgentProposal(detail.conversation.id, run.id);
      set({ detail: next, status: "ready", error: null });
      return true;
    } catch (cause) {
      handleError(cause, set);
      return false;
    }
  },

  recordReceipt: async (conversationId, runId, receipt) => {
    try {
      const next = await recordAgentExecutionReceipt(conversationId, runId, receipt);
      if (get().activeConversationId === conversationId)
        set({ detail: next, status: "ready", error: null });
      return true;
    } catch (cause) {
      handleError(cause, set);
      return false;
    }
  },
}));

function scheduleIfRunning() {
  const detail = useAgentStore.getState().detail;
  if (!detail?.latestRun || !isActiveRun(detail.latestRun.status)) return;
  stopPolling();
  pollTimer = window.setTimeout(() => void refreshActiveConversation(), 1_400);
}

async function refreshActiveConversation() {
  const state = useAgentStore.getState();
  if (!state.activeConversationId) return;
  try {
    const detail = await fetchAgentConversation(state.activeConversationId);
    if (useAgentStore.getState().activeConversationId !== detail.conversation.id) return;
    useAgentStore.setState({ detail, status: "ready", error: null });
    scheduleIfRunning();
  } catch (cause) {
    handleError(cause, useAgentStore.setState);
  }
}

function stopPolling() {
  if (pollTimer !== null && typeof window !== "undefined") window.clearTimeout(pollTimer);
  pollTimer = null;
}

function isActiveRun(status: string) {
  return status === "queued" || status === "running";
}

function handleError(cause: unknown, set: typeof useAgentStore.setState) {
  if (cause instanceof CanvasApiError && cause.status === 401) useIdentityStore.getState().expire();
  set({
    status: "error",
    error: cause instanceof CanvasApiError ? cause.message : "Agent 请求没有完成",
  });
}

function publicModelError(cause: unknown) {
  return cause instanceof CanvasApiError ? cause.message : "Agent 模型列表没有加载完成";
}

function publicSkillsError(cause: unknown) {
  return cause instanceof CanvasApiError ? cause.message : "技能没有加载完成";
}

/** 本地启用清单：只留去重后的合法字符串，并在这里就按上限截断。 */
function readStoredSkillIds(): string[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = JSON.parse(localStorage.getItem(SKILLS_STORAGE_KEY) || "[]") as unknown;
    if (!Array.isArray(raw)) return [];
    const ids = raw.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    return [...new Set(ids)].slice(0, agentSkillLimits.enabledPerRun);
  } catch {
    return [];
  }
}

function writeStoredSkillIds(ids: string[]) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(ids));
    }
  } catch {
    // 存储不可用时当前会话的启用清单仍然有效。
  }
}

function readStoredExecutionPermission(): AgentExecutionPermission {
  try {
    if (typeof localStorage === "undefined") return DEFAULT_EXECUTION_PERMISSION;
    const parsed = agentExecutionPermissionSchema.safeParse(
      localStorage.getItem(PERMISSION_STORAGE_KEY),
    );
    return parsed.success ? parsed.data : DEFAULT_EXECUTION_PERMISSION;
  } catch {
    return DEFAULT_EXECUTION_PERMISSION;
  }
}

function writeStoredExecutionPermission(permission: AgentExecutionPermission) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PERMISSION_STORAGE_KEY, permission);
    }
  } catch {
    // 存储不可用时当前会话的权限档仍然有效。
  }
}

function readStoredModelState(): {
  modelId: string | null;
  models: AgentModelCatalog["models"];
  loadedAt: number;
} {
  try {
    if (typeof localStorage === "undefined") return { modelId: null, models: [], loadedAt: 0 };
    const stored = JSON.parse(localStorage.getItem(MODEL_STORAGE_KEY) || "null") as {
      modelId?: unknown;
      catalog?: unknown;
      loadedAt?: unknown;
    } | null;
    const savedModelId = agentModelIdSchema.safeParse(stored?.modelId);
    const catalog = agentModelCatalogSchema.safeParse(stored?.catalog);
    if (
      !catalog.success ||
      typeof stored?.loadedAt !== "number" ||
      Date.now() - stored.loadedAt > MODEL_MAX_STALE_MS
    ) {
      return { modelId: savedModelId.success ? savedModelId.data : null, models: [], loadedAt: 0 };
    }
    const requestedModelId = savedModelId.success ? savedModelId.data : null;
    const modelId = catalog.data.models.some((model) => model.id === requestedModelId)
      ? requestedModelId
      : catalog.data.defaultModelId;
    return { modelId, models: catalog.data.models, loadedAt: stored.loadedAt };
  } catch {
    return { modelId: null, models: [], loadedAt: 0 };
  }
}

function writeStoredModelState(modelId: string, catalog: AgentModelCatalog, loadedAt: number) {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify({ modelId, catalog, loadedAt }));
    }
  } catch {
    // The current selection remains active for this session when storage is unavailable.
  }
}

function defaultThinkingFor(models: AgentModelCatalog["models"], modelId: string | null) {
  if (!modelId) return null;
  return models.find((model) => model.id === modelId)?.thinking?.default ?? null;
}
