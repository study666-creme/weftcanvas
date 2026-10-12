import { describe, expect, it } from "vitest";

import { parseAgentModelOutput } from "./agent-output.js";

describe("parseAgentModelOutput", () => {
  it("accepts a fenced validated action envelope", () => {
    const output = parseAgentModelOutput(`\`\`\`json
{"content":"已选中节点","actions":[{"type":"canvas_select_nodes","nodeIds":["node-1"]}]}
\`\`\``);
    expect(output).toEqual({
      content: "已选中节点",
      actions: [{ type: "canvas_select_nodes", nodeIds: ["node-1"] }],
      toolCalls: [],
      executionMode: "proposal",
      proposal: {
        title: "应用建议的画布调整",
        reason: "这些操作会修改当前项目，执行前需要由你确认。",
        successCriteria: ["所列操作成功应用，无法应用的项目会显示原因"],
      },
    });
  });

  it("falls back to text when a provider ignores the JSON protocol", () => {
    expect(parseAgentModelOutput("先压缩对白。")).toEqual({
      content: "先压缩对白。",
      actions: [],
      toolCalls: [],
      executionMode: "none",
      proposal: null,
    });
  });

  it("allows explicit low-risk direct actions and downgrades content changes to proposals", () => {
    expect(
      parseAgentModelOutput(
        JSON.stringify({
          content: "将选中这一节点。",
          executionMode: "direct",
          proposal: null,
          actions: [{ type: "canvas_select_nodes", nodeIds: ["node-1"] }],
        }),
      ),
    ).toMatchObject({ executionMode: "direct", proposal: null });

    expect(
      parseAgentModelOutput(
        JSON.stringify({
          content: "建议更新节点正文。",
          executionMode: "direct",
          proposal: null,
          actions: [{ type: "canvas_update_node", nodeId: "node-1", body: "新版" }],
        }),
      ),
    ).toMatchObject({ executionMode: "proposal", proposal: { title: "应用建议的画布调整" } });
  });

  it("normalizes provider aliases for add and connect actions", () => {
    const output = parseAgentModelOutput(
      JSON.stringify({
        content: "Create and connect the beat nodes.",
        executionMode: "proposal",
        proposal: null,
        actions: [
          {
            type: "canvas_add_node",
            clientId: "beat",
            nodeType: "text",
            text: "Inciting incident",
          },
          {
            type: "canvas_connect_nodes",
            source: "seed-node",
            target: "beat",
          },
        ],
      }),
    );

    expect(output).toMatchObject({
      executionMode: "proposal",
      actions: [
        { type: "canvas_add_node", clientId: "beat", kind: "text", body: "Inciting incident" },
        { type: "canvas_connect_nodes", sourceNodeId: "seed-node", targetNodeId: "beat" },
      ],
    });
    expect(output.actions[0]).not.toHaveProperty("nodeType");
    expect(output.actions[0]).not.toHaveProperty("text");
    expect(output.actions[1]).not.toHaveProperty("source");
    expect(output.actions[1]).not.toHaveProperty("target");
  });

  it("keeps conflicting aliases inside the strict validation boundary", () => {
    const raw = JSON.stringify({
      content: "Do not apply ambiguous actions.",
      actions: [
        {
          type: "canvas_connect_nodes",
          sourceNodeId: "canonical-source",
          source: "alias-source",
          target: "target",
        },
      ],
    });

    // 有歧义的动作必须被拒绝；同时不能把原始 JSON 当正文丢给用户看。
    const output = parseAgentModelOutput(raw);
    expect(output.actions).toEqual([]);
    expect(output.executionMode).toBe("none");
    expect(output.proposal).toBeNull();
    expect(output.content).not.toMatch(/canvas_connect_nodes|sourceNodeId|"actions"/);
  });

  it("carries local tool calls without turning them into canvas actions", () => {
    const output = parseAgentModelOutput(
      JSON.stringify({
        content: "先把人物导入 Blender。",
        executionMode: "none",
        proposal: null,
        actions: [],
        toolCalls: [{ name: "blender_run_python", arguments: { code: "print('hi')" } }],
      }),
    );
    expect(output).toEqual({
      content: "先把人物导入 Blender。",
      actions: [],
      toolCalls: [{ name: "blender_run_python", arguments: { code: "print('hi')" } }],
      executionMode: "none",
      proposal: null,
    });
  });

  it("drops tool calls when the model also asks for canvas actions", () => {
    const output = parseAgentModelOutput(
      JSON.stringify({
        content: "同时做两件事。",
        executionMode: "proposal",
        proposal: null,
        actions: [{ type: "canvas_select_nodes", nodeIds: ["node-1"] }],
        toolCalls: [{ name: "blender_run_python", arguments: { code: "print('hi')" } }],
      }),
    );
    expect(output.toolCalls).toEqual([]);
    expect(output.actions).toHaveLength(1);
  });

  it("accepts from/to aliases used by some providers", () => {
    const output = parseAgentModelOutput(
      JSON.stringify({
        content: "Connect the motion beat.",
        actions: [{ type: "canvas_connect_nodes", from: "storyboard_a", to: "motion_a" }],
      }),
    );
    expect(output.actions).toEqual([
      {
        type: "canvas_connect_nodes",
        sourceNodeId: "storyboard_a",
        targetNodeId: "motion_a",
      },
    ]);
    expect(output.executionMode).toBe("proposal");
  });

  it("unwraps a nested JSON envelope returned inside content", () => {
    const inner = {
      content: "proposal content",
      executionMode: "proposal",
      proposal: {
        title: "Add storyboard node",
        reason: "Complete the current storyboard",
        successCriteria: ["The new node is present"],
      },
      actions: [
        {
          type: "canvas_add_node",
          clientId: "storyboard_a",
          kind: "image",
          body: "STORYBOARD_A 16:9",
        },
      ],
    };
    const outer = {
      content: JSON.stringify(inner),
      executionMode: "none",
      proposal: null,
      actions: [],
    };
    expect(parseAgentModelOutput(JSON.stringify(outer))).toMatchObject({
      executionMode: "proposal",
      actions: [{ type: "canvas_add_node", clientId: "storyboard_a", kind: "image" }],
      proposal: { title: "Add storyboard node" },
    });
  });
});

describe("parseAgentModelOutput action recovery", () => {
  it("recovers a bare actions array the model forgot to wrap in an envelope", () => {
    const output = parseAgentModelOutput(
      JSON.stringify([
        { type: "canvas_add_node", clientId: "shot-1", kind: "text", text: "镜头 1" },
        { type: "canvas_add_node", clientId: "shot-2", kind: "text", text: "镜头 2" },
      ]),
    );
    expect(output.actions).toHaveLength(2);
    expect(output.actions[0]).toMatchObject({
      type: "canvas_add_node",
      clientId: "shot-1",
      body: "镜头 1",
    });
    expect(output.executionMode).toBe("proposal");
    expect(output.content).not.toContain("canvas_add_node");
  });

  it("keeps the prose and salvages complete actions from a truncated array", () => {
    const output = parseAgentModelOutput(
      '先铺三个镜头。\n```json\n[{"type":"canvas_add_node","clientId":"s1","kind":"text","text":"镜头 1"},' +
        '{"type":"canvas_add_node","clientId":"s2","kind":"text","text":"镜头 2 被截断',
    );
    expect(output.actions).toHaveLength(1);
    expect(output.content).toContain("先铺三个镜头");
    expect(output.content).not.toContain("clientId");
  });

  it("never shows raw JSON keys when nothing can be parsed", () => {
    const output = parseAgentModelOutput(
      '{"content": "坏掉的 JSON", "actions": [{"type": "canvas_add_node"',
    );
    expect(output.actions).toEqual([]);
    expect(output.content).not.toMatch(/actions|canvas_add_node/);
    expect(output.content.length).toBeGreaterThan(0);
  });
});

describe("parseAgentModelOutput nested action payloads", () => {
  it("flattens payload-wrapped action fields", () => {
    const raw = JSON.stringify({
      content: "先给出三个镜头。",
      executionMode: "proposal",
      proposal: {
        title: "创建三个镜头节点",
        reason: "新增节点需要确认",
        successCriteria: ["出现 3 个文本节点"],
      },
      actions: [
        { type: "canvas_add_node", clientId: "shot-1", payload: { kind: "text", body: "镜头 1" } },
        { type: "canvas_add_node", clientId: "shot-2", payload: { kind: "text", body: "镜头 2" } },
      ],
    });

    const output = parseAgentModelOutput(raw);

    expect(output.actions).toHaveLength(2);
    expect(output.actions[0]).toMatchObject({
      type: "canvas_add_node",
      clientId: "shot-1",
      kind: "text",
      body: "镜头 1",
    });
    expect(output.executionMode).toBe("proposal");
    expect(output.content).toBe("先给出三个镜头。");
  });

  it("accepts tool-call shaped actions with name plus arguments", () => {
    const raw = JSON.stringify({
      content: "好。",
      executionMode: "proposal",
      proposal: null,
      actions: [
        { name: "canvas_add_node", arguments: { clientId: "n1", kind: "text", text: "旁白" } },
      ],
    });

    const output = parseAgentModelOutput(raw);

    expect(output.actions).toHaveLength(1);
    expect(output.actions[0]).toMatchObject({
      type: "canvas_add_node",
      clientId: "n1",
      body: "旁白",
    });
  });
});
