import { describe, expect, it, vi } from "vitest";

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
}) {
  const store = new MemoryAgentStore();
  const executor: AgentExecutor = {
    getModels: async () => runtimeCatalog,
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
