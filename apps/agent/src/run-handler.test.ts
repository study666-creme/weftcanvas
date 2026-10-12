import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { AgentRunHandler } from "./run-handler.js";
import type { AgentTool } from "./tools.js";

function request(overrides: Record<string, unknown> = {}) {
  const conversationId = randomUUID();
  const createdAt = new Date().toISOString();
  return {
    modelId: "gpt-test",
    conversation: {
      schemaVersion: 1,
      id: conversationId,
      projectId: "p1",
      title: "对话",
      createdAt,
      updatedAt: createdAt,
    },
    messages: [
      {
        schemaVersion: 1,
        id: randomUUID(),
        conversationId,
        role: "user",
        content: "帮我把人物导进 Blender",
        createdAt,
      },
    ],
    canvasContext: {
      schemaVersion: 1,
      contextRevision: "rev-1",
      projectId: "p1",
      projectName: "项目",
      nodeCount: 0,
      edgeCount: 0,
      groupCount: 0,
      omittedNodeCount: 0,
      omittedEdgeCount: 0,
      nodes: [],
      edges: [],
      groups: [],
      directorStage: null,
    },
    ...overrides,
  };
}

function tool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "blender_run_python",
    description: "在 Blender 中执行 Python",
    parameters: [{ name: "code", description: "代码", required: true }],
    run: vi.fn(async () => ({ ok: true, content: "cube added" })),
    ...overrides,
  };
}

function handler(complete: ReturnType<typeof vi.fn>, tools: AgentTool[] = []) {
  return new AgentRunHandler({ complete }, { allows: () => true }, undefined, {
    buildTools: async () => tools,
  });
}

const toolCallEnvelope = JSON.stringify({
  content: "先让 Blender 建一个立方体。",
  executionMode: "none",
  proposal: null,
  actions: [],
  toolCalls: [
    { name: "blender_run_python", arguments: { code: "bpy.ops.mesh.primitive_cube_add()" } },
  ],
});

const finalEnvelope = JSON.stringify({
  content: "已经让 Blender 建好立方体。",
  executionMode: "none",
  proposal: null,
  actions: [],
});

describe("AgentRunHandler tool loop", () => {
  it("runs a single completion when no local tool is available", async () => {
    const complete = vi.fn(async () => finalEnvelope);
    const result = await handler(complete).handle(request());
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 200 });
    if (result.status !== 200) return;
    expect(result.body.data.toolCalls).toEqual([]);
    expect(result.body.data.content).toBe("已经让 Blender 建好立方体。");
  });

  it("executes a tool call and feeds the result back for the final answer", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(toolCallEnvelope)
      .mockResolvedValueOnce(finalEnvelope);
    const blender = tool();
    const result = await handler(complete, [blender]).handle(request());

    expect(complete).toHaveBeenCalledTimes(2);
    expect(blender.run).toHaveBeenCalledWith({ code: "bpy.ops.mesh.primitive_cube_add()" }, {});
    const secondCallMessages = complete.mock.calls[1]![0] as Array<{
      role: string;
      content: string;
    }>;
    expect(secondCallMessages.some((message) => message.content.includes("本机工具执行结果"))).toBe(
      true,
    );
    expect(secondCallMessages.some((message) => message.content.includes("cube added"))).toBe(true);
    expect(result).toMatchObject({ status: 200 });
    if (result.status !== 200) return;
    expect(result.body.data.content).toBe("已经让 Blender 建好立方体。");
  });

  it("advertises the tool contract to the model", async () => {
    const complete = vi.fn(async () => finalEnvelope);
    await handler(complete, [tool()]).handle(request());
    const firstMessages = complete.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    expect(firstMessages.some((message) => message.content.includes("blender_run_python"))).toBe(
      true,
    );
    expect(firstMessages.some((message) => message.content.includes("toolCalls"))).toBe(true);
  });

  it("reports an unknown tool back to the model instead of failing the run", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          content: "试试别的工具。",
          executionMode: "none",
          proposal: null,
          actions: [],
          toolCalls: [{ name: "maya_run_python", arguments: {} }],
        }),
      )
      .mockResolvedValueOnce(finalEnvelope);
    const result = await handler(complete, [tool()]).handle(request());
    expect(result).toMatchObject({ status: 200 });
    const secondCallMessages = complete.mock.calls[1]![0] as Array<{ content: string }>;
    expect(
      secondCallMessages.some((message) => message.content.includes("未知工具 maya_run_python")),
    ).toBe(true);
  });

  it("keeps the run alive when tool discovery fails", async () => {
    const complete = vi.fn(async () => finalEnvelope);
    const runHandler = new AgentRunHandler({ complete }, { allows: () => true }, undefined, {
      buildTools: async () => {
        throw new Error("probe exploded");
      },
    });
    const result = await runHandler.handle(request());
    expect(complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 200 });
  });

  it("blocks tool calls while the professional baseline is unfinished", async () => {
    const complete = vi.fn(async () => toolCallEnvelope);
    const result = await handler(complete, [tool()]).handle(
      request({
        canvasContext: {
          schemaVersion: 1,
          contextRevision: "rev-1",
          projectId: "p1",
          projectName: "项目",
          nodeCount: 0,
          edgeCount: 0,
          groupCount: 0,
          omittedNodeCount: 0,
          omittedEdgeCount: 0,
          nodes: [],
          edges: [],
          groups: [],
          directorStage: null,
          creativeGuidance: {
            mode: "professional",
            baseline: { aspectRatio: null, visualStyle: null, targetDuration: null, locked: false },
          },
        },
      }),
    );
    expect(result).toMatchObject({ status: 200 });
    if (result.status !== 200) return;
    expect(result.body.data.content).toContain("专业辅助会先定好创作基线");
    expect(result.body.data.toolCalls).toEqual([]);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects a model the runtime does not allow", async () => {
    const complete = vi.fn(async () => finalEnvelope);
    const runHandler = new AgentRunHandler({ complete }, { allows: () => false });
    const result = await runHandler.handle(request());
    expect(result).toMatchObject({ status: 400 });
    expect(complete).not.toHaveBeenCalled();
  });
});
