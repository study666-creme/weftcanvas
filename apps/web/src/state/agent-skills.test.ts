import {
  agentSkillLimits,
  type AgentCanvasContext,
  type AgentConversationDetail,
  type AgentModelCatalog,
  type AgentSkillSummary,
} from "@weftcanvas/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listAgentSkills: vi.fn(),
  importAgentSkill: vi.fn(),
  deleteAgentSkill: vi.fn(),
  submitAgentMessage: vi.fn(),
  createRequestKey: vi.fn(() => "agent:test-request"),
}));

vi.mock("../lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api-client")>();
  return {
    ...actual,
    listAgentSkills: api.listAgentSkills,
    importAgentSkill: api.importAgentSkill,
    deleteAgentSkill: api.deleteAgentSkill,
    submitAgentMessage: api.submitAgentMessage,
    createRequestKey: api.createRequestKey,
  };
});

const SKILLS_STORAGE_KEY = "weftcanvas:agent-skills:v1";
const PERMISSION_STORAGE_KEY = "weftcanvas:agent-permission:v1";
const catalog: AgentModelCatalog = {
  defaultModelId: "gpt-default",
  models: [
    { id: "gpt-default", label: "GPT Default" },
    { id: "gpt-pro", label: "GPT Pro" },
  ],
};

describe("agent skills and execution permission state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    installMemoryStorage();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("caps enabled skills at enabledPerRun and toggles freely below the cap", async () => {
    const skills = skillSummaries(6);
    api.listAgentSkills.mockResolvedValue(skills);
    const { useAgentStore } = await import("./agent-store");

    await useAgentStore.getState().loadSkills();
    expect(useAgentStore.getState()).toMatchObject({
      skills,
      skillsStatus: "ready",
      skillsError: null,
    });

    for (const skill of skills) useAgentStore.getState().toggleSkill(skill.id);
    expect(useAgentStore.getState().selectedSkillIds).toHaveLength(agentSkillLimits.enabledPerRun);
    expect(useAgentStore.getState().selectedSkillIds).toEqual(
      skills.slice(0, agentSkillLimits.enabledPerRun).map((skill) => skill.id),
    );

    const last = skills[agentSkillLimits.enabledPerRun]!.id;
    const stillCapped = useAgentStore.getState().selectedSkillIds;
    useAgentStore.getState().toggleSkill(last);
    expect(useAgentStore.getState().selectedSkillIds).toEqual(stillCapped);

    useAgentStore.getState().toggleSkill(skills[0]!.id);
    expect(useAgentStore.getState().selectedSkillIds).toHaveLength(
      agentSkillLimits.enabledPerRun - 1,
    );
    useAgentStore.getState().toggleSkill(last);
    expect(useAgentStore.getState().selectedSkillIds).toHaveLength(agentSkillLimits.enabledPerRun);
  });

  it("persists the selection to localStorage and rehydrates it on the next load", async () => {
    const skills = skillSummaries(3);
    api.listAgentSkills.mockResolvedValue(skills);
    const { useAgentStore } = await import("./agent-store");
    await useAgentStore.getState().loadSkills();
    useAgentStore.getState().toggleSkill(skills[1]!.id);

    expect(JSON.parse(localStorage.getItem(SKILLS_STORAGE_KEY)!)).toEqual([skills[1]!.id]);

    vi.resetModules();
    const reloaded = await import("./agent-store");
    expect(reloaded.useAgentStore.getState().selectedSkillIds).toEqual([skills[1]!.id]);
  });

  it("prunes enabled ids that no longer exist after loadSkills", async () => {
    const skills = skillSummaries(2);
    api.listAgentSkills.mockResolvedValue(skills);
    localStorage.setItem(SKILLS_STORAGE_KEY, JSON.stringify(["stale-id", skills[1]!.id]));
    const { useAgentStore } = await import("./agent-store");

    expect(useAgentStore.getState().selectedSkillIds).toEqual(["stale-id", skills[1]!.id]);

    await useAgentStore.getState().loadSkills();

    expect(useAgentStore.getState().selectedSkillIds).toEqual([skills[1]!.id]);
    expect(JSON.parse(localStorage.getItem(SKILLS_STORAGE_KEY)!)).toEqual([skills[1]!.id]);
  });

  it("keeps the list usable when the deployment has no skill store", async () => {
    const { CanvasApiError } = await import("../lib/api-client");
    api.listAgentSkills.mockRejectedValue(new CanvasApiError(404, "NOT_FOUND", "请求没有完成"));
    const { useAgentStore } = await import("./agent-store");

    await useAgentStore.getState().loadSkills();

    expect(useAgentStore.getState()).toMatchObject({
      skills: [],
      skillsStatus: "ready",
      skillsError: "当前部署没有启用技能库",
    });
  });

  it("defaults the execution permission to request_approval and persists changes", async () => {
    const { useAgentStore } = await import("./agent-store");
    expect(useAgentStore.getState().executionPermission).toBe("request_approval");

    useAgentStore.getState().setExecutionPermission("auto");
    expect(useAgentStore.getState().executionPermission).toBe("auto");
    expect(localStorage.getItem(PERMISSION_STORAGE_KEY)).toBe("auto");

    useAgentStore.getState().setExecutionPermission("admin" as never);
    expect(useAgentStore.getState().executionPermission).toBe("auto");

    vi.resetModules();
    const reloaded = await import("./agent-store");
    expect(reloaded.useAgentStore.getState().executionPermission).toBe("auto");
  });

  it("falls back to request_approval when the stored permission is unusable", async () => {
    localStorage.setItem(PERMISSION_STORAGE_KEY, "not-a-permission");
    const { useAgentStore } = await import("./agent-store");
    expect(useAgentStore.getState().executionPermission).toBe("request_approval");
  });

  it("sends the execution permission and only still-existing enabled skill ids", async () => {
    const skills = skillSummaries(3);
    api.listAgentSkills.mockResolvedValue(skills);
    api.submitAgentMessage.mockResolvedValue(conversationDetail());
    const { useAgentStore } = await import("./agent-store");
    await useAgentStore.getState().loadSkills();
    useAgentStore.getState().toggleSkill(skills[0]!.id);
    useAgentStore.getState().toggleSkill(skills[2]!.id);
    useAgentStore.getState().setExecutionPermission("auto");
    useAgentStore.setState({
      activeConversationId: conversationDetail().conversation.id,
      detail: conversationDetail(),
      conversations: [conversationDetail().conversation],
      status: "ready",
      models: catalog.models,
      modelStatus: "ready",
      selectedModelId: "gpt-pro",
    });

    await expect(
      useAgentStore.getState().send("project-1", "推进这一场", canvasContext),
    ).resolves.toBe(true);
    expect(api.submitAgentMessage).toHaveBeenCalledWith(
      conversationDetail().conversation.id,
      expect.objectContaining({
        executionPermission: "auto",
        skillIds: [skills[0]!.id, skills[2]!.id],
      }),
    );

    // 一条本地清单里的遗留 id（服务端已没有）不该被发出去。
    useAgentStore.setState({ selectedSkillIds: ["gone-id", skills[0]!.id] });
    await useAgentStore.getState().send("project-1", "再来一轮", canvasContext);
    const lastCall = api.submitAgentMessage.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(lastCall.skillIds).toEqual([skills[0]!.id]);
    expect(lastCall.executionPermission).toBe("auto");
  });

  it("omits skillIds from the request body when nothing is enabled", async () => {
    const skills = skillSummaries(1);
    api.listAgentSkills.mockResolvedValue(skills);
    api.submitAgentMessage.mockResolvedValue(conversationDetail());
    const { useAgentStore } = await import("./agent-store");
    await useAgentStore.getState().loadSkills();
    useAgentStore.setState({
      activeConversationId: conversationDetail().conversation.id,
      detail: conversationDetail(),
      conversations: [conversationDetail().conversation],
      status: "ready",
      models: catalog.models,
      modelStatus: "ready",
      selectedModelId: "gpt-pro",
    });

    await useAgentStore.getState().send("project-1", "先说说", canvasContext);
    const payload = api.submitAgentMessage.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("skillIds");
    expect(payload.executionPermission).toBe("request_approval");
  });

  it("imports a skill, refreshes the list and surfaces the API error message", async () => {
    const existing = skillSummaries(1);
    const imported: AgentSkillSummary = {
      ...skillSummaries(1)[0]!,
      id: "cccccccc-3333-4333-8333-333333333333",
      name: "新技能",
      description: "刚导入",
    };
    api.listAgentSkills.mockResolvedValue(existing);
    api.importAgentSkill.mockResolvedValue(imported);
    const { useAgentStore } = await import("./agent-store");
    await useAgentStore.getState().loadSkills();

    const content = "# 新技能\n\n先列节拍再补镜头。";
    const result = await useAgentStore.getState().importSkill(content);
    expect(api.importAgentSkill).toHaveBeenCalledWith({ content });
    expect(result).toEqual(imported);
    expect(useAgentStore.getState().skills?.[0]).toEqual(imported);
    expect(useAgentStore.getState().skillsError).toBeNull();

    const { CanvasApiError } = await import("../lib/api-client");
    api.importAgentSkill.mockRejectedValue(
      new CanvasApiError(422, "INVALID_SKILL", "技能正文为空，请确认导入的是 SKILL.md 内容"),
    );
    await expect(useAgentStore.getState().importSkill(content)).rejects.toThrow(
      "技能正文为空，请确认导入的是 SKILL.md 内容",
    );
    expect(useAgentStore.getState().skillsError).toBe("技能正文为空，请确认导入的是 SKILL.md 内容");
  });

  it("removes a skill from the list and the enabled selection", async () => {
    const skills = skillSummaries(2);
    api.listAgentSkills.mockResolvedValue(skills);
    api.deleteAgentSkill.mockResolvedValue({ id: skills[0]!.id, deleted: true });
    const { useAgentStore } = await import("./agent-store");
    await useAgentStore.getState().loadSkills();
    useAgentStore.getState().toggleSkill(skills[0]!.id);

    await useAgentStore.getState().removeSkill(skills[0]!.id);

    expect(api.deleteAgentSkill).toHaveBeenCalledWith(skills[0]!.id);
    expect(useAgentStore.getState().skills?.map((skill) => skill.id)).toEqual([skills[1]!.id]);
    expect(useAgentStore.getState().selectedSkillIds).toEqual([]);
    expect(JSON.parse(localStorage.getItem(SKILLS_STORAGE_KEY)!)).toEqual([]);
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

function skillSummaries(count: number): AgentSkillSummary[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bbbbbbbb-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `技能 ${index + 1}`,
    description: `第 ${index + 1} 个技能的说明`,
    size: 128,
    hash: `hash-${index}`,
    createdAt: "2026-10-16T12:00:00.000Z",
    updatedAt: "2026-10-16T12:00:00.000Z",
  }));
}

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
