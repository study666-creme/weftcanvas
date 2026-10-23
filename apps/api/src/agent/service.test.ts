import { describe, expect, it, vi } from "vitest";

import type { AgentModelCatalog } from "@weftcanvas/contracts";

import {
  AgentService,
  AgentServiceError,
  AGENT_TURN_CREDITS,
  AGENT_TURN_REASON,
  AGENT_TURN_REFUND_REASON,
  type AgentBilling,
  type AgentBillingCharge,
  type AgentBillingResult,
} from "./service.js";
import { MemoryAgentStore } from "./memory-store.js";
import type { AgentExecutor } from "./types.js";

const runtimeCatalog = {
  defaultModelId: "gpt-5-mini",
  models: [
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-5.4", label: "GPT-5.4" },
  ],
};

function createService(options: {
  textModels?: () => Promise<
    ReadonlyArray<{
      id: string;
      label: string;
      description?: string;
      group?: string;
      thinking?: { levels: string[]; default: string };
    }>
  >;
  models?: typeof runtimeCatalog;
}) {
  const executor: AgentExecutor = {
    getModels: async () => options.models ?? runtimeCatalog,
    execute: async () => {
      throw new Error("not used");
    },
  };
  return new AgentService(new MemoryAgentStore(), {
    executor,
    ...(options.textModels ? { textModels: options.textModels } : {}),
  });
}

describe("AgentService model catalog", () => {
  it("merges platform text models with the runtime catalog and keeps the default first", async () => {
    const service = createService({
      textModels: async () => [
        {
          id: "glm-5.1",
          label: "GLM-5.1",
          group: "GLM",
          description: "GLM-5.1 文本模型",
          meta: "2 积分/次",
          billing: "request",
        },
        {
          id: "gpt-5.4",
          label: "GPT-5.4 平台名",
          group: "OpenAI",
          meta: "25/150 积分 · 每M",
          billing: "token",
          thinking: { levels: ["low", "medium", "high"], default: "medium" },
        },
        {
          id: "kimi-k3",
          label: "Kimi K3",
          group: "Kimi",
          meta: "420/2100 积分 · 每M",
          billing: "token",
        },
      ],
    });

    const catalog = await service.getModels();

    expect(catalog.defaultModelId).toBe("gpt-5-mini");
    expect(catalog.models[0]).toEqual({ id: "gpt-5-mini", label: "GPT-5 Mini" });
    const ids = catalog.models.map((model) => model.id);
    expect(ids).toEqual(["gpt-5-mini", "gpt-5.4", "glm-5.1", "kimi-k3"]);
    // 运行时目录里的同名模型保留自己的标签，不被平台目录覆盖，但会补上思考强度。
    expect(catalog.models.find((model) => model.id === "gpt-5.4")).toMatchObject({
      label: "GPT-5.4",
      thinking: { levels: ["low", "medium", "high"], default: "medium" },
    });
    expect(catalog.models.find((model) => model.id === "glm-5.1")).toMatchObject({
      group: "GLM",
      detail: "GLM-5.1 文本模型",
      meta: "2 积分/次",
      billing: "request",
    });
    expect(catalog.models.find((model) => model.id === "kimi-k3")).toMatchObject({
      meta: "420/2100 积分 · 每M",
      billing: "token",
    });
  });

  it("drops malformed thinking metadata instead of failing the catalog", async () => {
    const service = createService({
      textModels: async () => [
        { id: "glm-5.1", label: "GLM-5.1", thinking: { levels: [], default: "nope" } },
        {
          id: "kimi-k3",
          label: "Kimi K3",
          thinking: { levels: ["medium", "medium", "  "], default: "高" },
        },
      ],
    });

    const catalog = await service.getModels();

    expect(catalog.models.find((model) => model.id === "glm-5.1")?.thinking).toBeUndefined();
    // 去重后只剩一个合法档位，非法默认值回退到该档位。
    expect(catalog.models.find((model) => model.id === "kimi-k3")?.thinking).toEqual({
      levels: ["medium"],
      default: "medium",
    });
  });

  it("falls back to the runtime catalog when the platform catalog is unavailable", async () => {
    const service = createService({
      textModels: async () => {
        throw new Error("catalog offline");
      },
    });

    const catalog = await service.getModels();

    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-5-mini", "gpt-5.4"]);
  });

  it("keeps the runtime catalog when no platform provider is configured", async () => {
    const service = createService({});

    const catalog = await service.getModels();

    expect(catalog.models.map((model) => model.id)).toEqual(["gpt-5-mini", "gpt-5.4"]);
  });
});

const OWNER_ID = "owner-1";
const PROJECT_ID = "project-1";

function canvasContextFixture() {
  return {
    schemaVersion: 1 as const,
    contextRevision: "rev-1",
    projectId: PROJECT_ID,
    projectName: "测试画布",
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
}

function billingMock() {
  const consume = vi.fn(async (_input: AgentBillingCharge): Promise<AgentBillingResult> => ({
    balance: 100,
    replayed: false,
  }));
  const refund = vi.fn(async (_input: AgentBillingCharge): Promise<AgentBillingResult> => ({
    balance: 100,
    replayed: false,
  }));
  return { billing: { consume, refund } as AgentBilling, consume, refund };
}

function createBillingHarness(options: {
  billing: AgentBilling;
  execute?: AgentExecutor["execute"];
  models?: AgentModelCatalog;
}) {
  const store = new MemoryAgentStore();
  const executor: AgentExecutor = {
    getModels: async () => options.models ?? runtimeCatalog,
    execute:
      options.execute ??
      (async () => ({
        content: "完成",
        actions: [],
        executionMode: "none" as const,
        proposal: null,
      })),
  };
  const service = new AgentService(store, { executor, billing: options.billing });
  return { service, store };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function submitFixture(idempotencyKey: string) {
  return { content: "画一个圆", idempotencyKey, canvasContext: canvasContextFixture() };
}

describe("AgentService reference attachments", () => {
  const attachment = {
    id: "reference-1",
    kind: "image" as const,
    name: "参考图.jpg",
    mimeType: "image/jpeg",
    width: 640,
    height: 480,
    durationMs: null,
    nodeId: "node-1",
    dataUrl: "data:image/jpeg;base64,AAAA",
  };

  it("rejects attachments for a text-only model before charging", async () => {
    const { billing, consume } = billingMock();
    const { service } = createBillingHarness({ billing });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });

    await expect(
      service.submitMessage(
        OWNER_ID,
        conversation.id,
        { ...submitFixture("key-media-unsupported"), attachments: [attachment] },
        "session-token",
      ),
    ).rejects.toMatchObject({
      name: "AgentServiceError",
      code: "MODEL_MEDIA_UNSUPPORTED",
      message: "所选模型不支持图片输入",
    });
    expect(consume).not.toHaveBeenCalled();
    expect((await service.getDetail(OWNER_ID, conversation.id)).messages).toHaveLength(0);
  });

  it("passes bounded attachment bytes to the runtime and persists only metadata", async () => {
    const { billing, consume } = billingMock();
    let seen: Parameters<AgentExecutor["execute"]>[0] | null = null;
    const { service } = createBillingHarness({
      billing,
      models: {
        defaultModelId: "gpt-5-mini",
        models: [
          {
            id: "gpt-5-mini",
            label: "GPT-5 Mini",
            mediaInput: { images: true, videos: false },
          },
        ],
      },
      execute: async (request) => {
        seen = request;
        return { content: "收到参考图", actions: [], executionMode: "none", proposal: null };
      },
    });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });
    await service.submitMessage(
      OWNER_ID,
      conversation.id,
      { ...submitFixture("key-media-ok"), attachments: [attachment] },
      "session-token",
    );
    await flush();

    expect(consume).toHaveBeenCalledTimes(1);
    expect(seen?.attachments).toEqual([attachment]);
    const detail = await service.getDetail(OWNER_ID, conversation.id);
    const stored = detail.messages.find((message) => message.role === "user");
    const { dataUrl: _dataUrl, ...metadata } = attachment;
    expect(stored?.attachments).toEqual([metadata]);
  });
});

describe("AgentService credit billing", () => {
  it("charges the flat turn price once before creating the run", async () => {
    const { billing, consume } = billingMock();
    const { service } = createBillingHarness({ billing });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });

    const detail = await service.submitMessage(
      OWNER_ID,
      conversation.id,
      submitFixture("key-charge-1"),
      "session-token",
    );

    expect(consume).toHaveBeenCalledTimes(1);
    const input = consume.mock.calls[0][0];
    expect(input.amount).toBe(AGENT_TURN_CREDITS);
    expect(input.reason).toBe(AGENT_TURN_REASON);
    expect(input.token).toBe("session-token");
    expect(input.refId).toMatch(/^agent-run:/);
    expect(detail.latestRun?.id).toBe(input.refId.replace("agent-run:", ""));
  });

  it("blocks the run and creates nothing when the balance is insufficient", async () => {
    const { billing, consume, refund } = billingMock();
    consume.mockRejectedValue(
      Object.assign(new Error("insufficient_credits"), {
        code: "INSUFFICIENT_CREDITS",
        status: 402,
      }),
    );
    const { service } = createBillingHarness({ billing });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });

    await expect(
      service.submitMessage(
        OWNER_ID,
        conversation.id,
        submitFixture("key-insufficient"),
        "session-token",
      ),
    ).rejects.toMatchObject({
      name: "AgentServiceError",
      code: "INSUFFICIENT_CREDITS",
      message: "积分不足，请充值后重试",
    });

    expect(consume).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
    const detail = await service.getDetail(OWNER_ID, conversation.id);
    expect(detail.messages).toHaveLength(0);
    expect(detail.latestRun).toBeNull();
  });

  it("refunds the turn when the run fails", async () => {
    const { billing, consume, refund } = billingMock();
    const { service } = createBillingHarness({
      billing,
      execute: async () => {
        throw new Error("upstream boom");
      },
    });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });
    const submitted = await service.submitMessage(
      OWNER_ID,
      conversation.id,
      submitFixture("key-fail-1"),
      "session-token",
    );
    await flush();

    expect(consume).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0][0]).toMatchObject({
      refId: consume.mock.calls[0][0].refId,
      amount: AGENT_TURN_CREDITS,
      reason: AGENT_TURN_REFUND_REASON,
    });
    const settled = await service.getDetail(OWNER_ID, conversation.id);
    expect(settled.latestRun?.status).toBe("failed");
    expect(submitted.latestRun?.id).toBe(consume.mock.calls[0][0].refId.replace("agent-run:", ""));
  });

  it("does not refund a completed run and refuses to cancel it", async () => {
    const { billing, consume, refund } = billingMock();
    const { service } = createBillingHarness({ billing });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });
    const submitted = await service.submitMessage(
      OWNER_ID,
      conversation.id,
      submitFixture("key-success-1"),
      "session-token",
    );
    await flush();

    const runId = submitted.latestRun!.id;
    expect((await service.getDetail(OWNER_ID, conversation.id)).latestRun?.status).toBe(
      "completed",
    );
    await expect(service.cancelRun(OWNER_ID, runId, "session-token")).rejects.toBeInstanceOf(
      AgentServiceError,
    );
    expect(consume).toHaveBeenCalledTimes(1);
    expect(refund).not.toHaveBeenCalled();
  });

  it("refunds a run cancelled before completion exactly once", async () => {
    const { billing, consume, refund } = billingMock();
    const { service } = createBillingHarness({
      billing,
      execute: (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });
    await service.submitMessage(
      OWNER_ID,
      conversation.id,
      submitFixture("key-cancel-1"),
      "session-token",
    );
    const runId = consume.mock.calls[0][0].refId.replace("agent-run:", "");

    await service.cancelRun(OWNER_ID, runId, "session-token");
    await flush();

    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund.mock.calls[0][0].refId).toBe(`agent-run:${runId}`);
    // 已取消的任务再取消：RUN_NOT_FOUND，不产生第二次退款。
    await expect(service.cancelRun(OWNER_ID, runId, "session-token")).rejects.toBeInstanceOf(
      AgentServiceError,
    );
    expect(refund).toHaveBeenCalledTimes(1);
  });

  it("releases the charge when an idempotent retry does not create a new run", async () => {
    const { billing, consume, refund } = billingMock();
    const { service } = createBillingHarness({ billing });
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });
    const message = submitFixture("key-replay-1");

    await service.submitMessage(OWNER_ID, conversation.id, message, "session-token");
    await flush();
    const firstCharge = consume.mock.calls[0][0].refId;

    await service.submitMessage(OWNER_ID, conversation.id, message, "session-token");
    await flush();

    expect(consume).toHaveBeenCalledTimes(2);
    expect(refund).toHaveBeenCalledTimes(1);
    const secondCharge = consume.mock.calls[1][0].refId;
    expect(secondCharge).not.toBe(firstCharge);
    expect(refund.mock.calls[0][0].refId).toBe(secondCharge);
  });
});

describe("AgentService execution permission", () => {
  /** 执行器回一条"建一个文本节点"的 direct 结果，用来观察权限档怎么落地。 */
  function permissionHarness() {
    const calls: Array<{ executionPermission: string; skills: unknown[] }> = [];
    const executor: AgentExecutor = {
      getModels: async () => runtimeCatalog,
      execute: async (request) => {
        calls.push({
          executionPermission: request.executionPermission,
          skills: request.skills,
        });
        return {
          content: "已写好这一集的开场。",
          actions: [
            {
              type: "canvas_add_node" as const,
              clientId: "story-1",
              kind: "text" as const,
              body: "第一场：雨夜，医院走廊。",
            },
          ],
          executionMode: "direct" as const,
          proposal: null,
        };
      },
    };
    const service = new AgentService(new MemoryAgentStore(), {
      executor,
      skills: {
        read: async (_ownerId, id) =>
          id !== skillId
            ? null
            : {
                id,
                name: "分镜脚本编写",
                description: "把故事拆成可拍的分镜",
                body: "1. 先确定每场的功能。",
                size: 20,
                hash: "hash",
                createdAt: "2026-10-16T12:00:00.000Z",
                updatedAt: "2026-10-16T12:00:00.000Z",
              },
      },
    });
    return { service, calls };
  }

  const skillId = "33333333-3333-4333-8333-333333333333";

  async function runOnce(service: AgentService, body: Record<string, unknown>, key: string) {
    const conversation = await service.createConversation(OWNER_ID, { projectId: PROJECT_ID });
    await service.submitMessage(
      OWNER_ID,
      conversation.id,
      { ...submitFixture(key), ...body },
      undefined,
    );
    // 运行是异步推进的（读运行记录 / 读技能都有各自的 await），等状态落到终态再断言。
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const detail = await service.getDetail(OWNER_ID, conversation.id);
      const status = detail.latestRun?.status;
      if (status && status !== "queued" && status !== "running") return detail;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    return service.getDetail(OWNER_ID, conversation.id);
  }

  it("默认请求审批：写节点转成待确认提案", async () => {
    const { service } = permissionHarness();
    const detail = await runOnce(service, {}, "key-perm-default");
    expect(detail.latestRun?.executionPermission).toBe("request_approval");
    expect(detail.latestRun?.executionMode).toBe("proposal");
    expect(detail.latestRun?.proposalStatus).toBe("pending");
  });

  it("自动执行：同一批动作直接落地", async () => {
    const { service } = permissionHarness();
    const detail = await runOnce(service, { executionPermission: "auto" }, "key-perm-auto");
    expect(detail.latestRun?.executionMode).toBe("direct");
    expect(detail.latestRun?.proposal).toBeNull();
    expect(detail.latestRun?.actions).toHaveLength(1);
  });

  it("只读：动作一个都不下发", async () => {
    const { service, calls } = permissionHarness();
    const detail = await runOnce(
      service,
      { executionPermission: "read_only" },
      "key-perm-readonly",
    );
    expect(calls[0]?.executionPermission).toBe("read_only");
    expect(detail.latestRun?.executionMode).toBe("none");
    expect(detail.latestRun?.actions).toEqual([]);
    // 正文照常返回：只读是"不改画布"，不是"不回答"。
    // 两条消息可能落在同一毫秒里，所以按角色找而不是按下标。
    expect(
      detail.messages.some(
        (message) => message.role === "assistant" && message.content.includes("开场"),
      ),
    ).toBe(true);
  });

  it("本轮启用的技能随运行冻结，正文读出来交给运行时", async () => {
    const { service, calls } = permissionHarness();
    const detail = await runOnce(service, { skillIds: [skillId] }, "key-skill-1");
    expect(detail.latestRun?.skillIds).toEqual([skillId]);
    expect(calls[0]?.skills).toEqual([
      {
        id: skillId,
        name: "分镜脚本编写",
        description: "把故事拆成可拍的分镜",
        body: "1. 先确定每场的功能。",
      },
    ]);
  });

  it("技能库没配置或技能读不到时，如实当没启用，不编造内容", async () => {
    const withoutStore = permissionHarness().service;
    const detail = await runOnce(withoutStore, { skillIds: [skillId] }, "key-skill-2");
    expect(detail.latestRun?.skillIds).toEqual([skillId]);

    const { service, calls } = permissionHarness();
    const missing = await runOnce(
      service,
      { skillIds: ["44444444-4444-4444-8444-444444444444"] },
      "key-skill-3",
    );
    // 读不到的技能既不下发也不记进本轮清单：界面上不会出现"已启用但其实没生效"。
    expect(missing.latestRun?.skillIds).toEqual([]);
    expect(calls[0]?.skills).toEqual([]);
  });
});
