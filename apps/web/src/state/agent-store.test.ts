import type {
  AgentCanvasContext,
  AgentConversationDetail,
  AgentModelCatalog,
} from "@weftcanvas/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  fetchAgentModels: vi.fn(),
  submitAgentMessage: vi.fn(),
  createRequestKey: vi.fn(() => "agent:test-request"),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api-client")>();
  return {
    ...actual,
    fetchAgentModels: api.fetchAgentModels,
    submitAgentMessage: api.submitAgentMessage,
    createRequestKey: api.createRequestKey,
  };
});

const STORAGE_KEY = "weftcanvas:agent-model:v1";
const catalog: AgentModelCatalog = {
  defaultModelId: "gpt-default",
  models: [
    { id: "gpt-default", label: "GPT Default" },
    { id: "gpt-pro", label: "GPT Pro" },
  ],
};

describe("agent model state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    installMemoryStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("falls back from a removed saved model and persists validated selections", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ modelId: "removed-model" }));
    api.fetchAgentModels.mockResolvedValue(catalog);
    const { useAgentStore } = await import("./agent-store");

    expect(useAgentStore.getState().selectedModelId).toBe("removed-model");
    await Promise.all([
      useAgentStore.getState().loadModels(),
      useAgentStore.getState().loadModels(),
    ]);

    expect(api.fetchAgentModels).toHaveBeenCalledTimes(1);
    expect(useAgentStore.getState()).toMatchObject({
      models: catalog.models,
      modelStatus: "ready",
      modelError: null,
      selectedModelId: "gpt-default",
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      modelId: "gpt-default",
      catalog,
    });

    useAgentStore.getState().setSelectedModelId("gpt-pro");
    expect(useAgentStore.getState().selectedModelId).toBe("gpt-pro");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toMatchObject({
      modelId: "gpt-pro",
      catalog,
    });
    useAgentStore.getState().setSelectedModelId("not-in-catalog");
    expect(useAgentStore.getState().selectedModelId).toBe("gpt-pro");
  });

  it("submits the selected model id with the message", async () => {
    const detail = conversationDetail();
    api.submitAgentMessage.mockResolvedValue(detail);
    const { useAgentStore } = await import("./agent-store");
    useAgentStore.setState({
      activeConversationId: detail.conversation.id,
      detail,
      conversations: [detail.conversation],
      status: "ready",
      models: catalog.models,
      modelStatus: "ready",
      selectedModelId: "gpt-pro",
    });

    await expect(
      useAgentStore.getState().send("project-1", "  Continue  ", canvasContext),
    ).resolves.toBe(true);
    expect(api.submitAgentMessage).toHaveBeenCalledWith(
      detail.conversation.id,
      expect.objectContaining({
        content: "Continue",
        modelId: "gpt-pro",
      }),
    );
  });

  it("keeps conversation history visible when the model catalog fails", async () => {
    const detail = conversationDetail();
    api.fetchAgentModels.mockRejectedValue(new Error("offline"));
    const { useAgentStore } = await import("./agent-store");
    useAgentStore.setState({ detail, status: "ready", error: null });

    await useAgentStore.getState().loadModels();

    expect(useAgentStore.getState()).toMatchObject({
      detail,
      status: "ready",
      error: null,
      modelStatus: "error",
      modelError: "Agent 模型列表没有加载完成",
    });
  });

  it("hydrates a saved catalog immediately and keeps it usable when background refresh fails", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        modelId: "gpt-pro",
        catalog,
        loadedAt: Date.now() - 2 * 60_000,
      }),
    );
    api.fetchAgentModels.mockRejectedValue(new Error("offline"));
    const { useAgentStore } = await import("./agent-store");

    expect(useAgentStore.getState()).toMatchObject({
      models: catalog.models,
      selectedModelId: "gpt-pro",
      modelStatus: "ready",
    });

    await useAgentStore.getState().loadModels();

    expect(useAgentStore.getState()).toMatchObject({
      models: catalog.models,
      selectedModelId: "gpt-pro",
      modelStatus: "ready",
      modelRefreshing: false,
      modelError: null,
    });
  });
});

const canvasContext: AgentCanvasContext = {
  schemaVersion: 1,
  contextRevision: "ctx-v1-test",
  projectId: "project-1",
  projectName: "Test project",
  nodeCount: 0,
  edgeCount: 0,
  groupCount: 0,
  omittedNodeCount: 0,
  omittedEdgeCount: 0,
  nodes: [],
  edges: [],
  groups: [],
  directorStage: null,
};

function conversationDetail(): AgentConversationDetail {
  return {
    conversation: {
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "project-1",
      title: "Test",
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    },
    messages: [
      {
        schemaVersion: 1,
        id: "22222222-2222-4222-8222-222222222222",
        conversationId: "11111111-1111-4111-8111-111111111111",
        role: "user",
        content: "Existing history",
        createdAt: "2026-07-22T00:00:00.000Z",
      },
    ],
    latestRun: null,
  };
}

function installMemoryStorage() {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => {
      entries.delete(key);
    },
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}
