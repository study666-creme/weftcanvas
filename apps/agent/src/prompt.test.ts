import { describe, expect, it } from "vitest";

import {
  buildChatMessages,
  formatAttachmentNote,
  formatSkillsContext,
  permissionRule,
} from "./prompt.js";
import { agentCanvasContextSchema, type AgentMessage } from "@weftcanvas/contracts";

const MESSAGE: AgentMessage = {
  schemaVersion: 1,
  id: "11111111-1111-4111-8111-111111111111",
  conversationId: "22222222-2222-4222-8222-222222222222",
  role: "user",
  content: "写一集开场",
  attachments: [],
  createdAt: "2026-10-16T12:00:00.000Z",
};

function context() {
  return agentCanvasContextSchema.parse({
    schemaVersion: 1,
    contextRevision: "rev-1",
    projectId: "project-1",
    projectName: "测试项目",
    nodeCount: 0,
    edgeCount: 0,
    groupCount: 0,
    omittedNodeCount: 0,
    omittedEdgeCount: 0,
    nodes: [],
    edges: [],
    groups: [],
    directorStage: null,
  });
}

function systemMessages(...args: Parameters<typeof buildChatMessages>) {
  return buildChatMessages(...args)
    .filter((message) => message.role === "system")
    .map((message) => message.content);
}

describe("执行权限档写进系统提示", () => {
  it("三档各有一句明确的边界，默认请求审批", () => {
    expect(permissionRule("read_only")).toContain("actions 必须为空数组");
    expect(permissionRule("request_approval")).toContain("proposal 等用户确认");
    expect(permissionRule("auto")).toContain("都可以用 direct 落地");

    const withoutPermission = systemMessages([MESSAGE], context());
    expect(withoutPermission[0]).toContain(permissionRule("request_approval"));
    const auto = systemMessages([MESSAGE], context(), "", "", [], "auto");
    expect(auto[0]).toContain(permissionRule("auto"));
    expect(auto[0]).not.toContain(permissionRule("request_approval"));
  });

  it("任何档位都不放开生成：只读档不放动作，自动档也只放开画布结构写入", () => {
    for (const permission of ["read_only", "request_approval", "auto"] as const) {
      const prompt = systemMessages([MESSAGE], context(), "", "", [], permission)[0]!;
      expect(prompt).toContain("不要触发生成");
    }
  });
});

describe("创作产物落成节点", () => {
  it("提示里明确要求故事/设定/分镜以节点交付，而不是整段贴在对话里", () => {
    const prompt = systemMessages([MESSAGE], context())[0]!;
    expect(prompt).toContain("默认以画布节点交付");
    expect(prompt).toContain("不要把整段设定只在 content 里贴一遍");
  });
});

describe("多模态参考素材", () => {
  const attachment = {
    id: "attachment-1",
    kind: "image" as const,
    name: "参考图.png",
    mimeType: "image/jpeg",
    width: 640,
    height: 480,
    durationMs: null,
    nodeId: "node-1",
    dataUrl: "data:image/jpeg;base64,AAAA",
  };

  it("把本轮附件作为 image_url 内容附在最后一条用户消息上", () => {
    const messages = buildChatMessages([MESSAGE], context(), "", "", [], "request_approval", [
      attachment,
    ]);
    const last = messages.at(-1)!;
    expect(Array.isArray(last.content)).toBe(true);
    const parts = last.content as Array<{ type: string }>;
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(parts.filter((part) => part.type === "image_url")).toHaveLength(1);
    expect(parts[0]).toMatchObject({
      text: expect.stringContaining("图片参考：参考图.png"),
    });
  });

  it("附件说明区分图片与视频首帧，并写明来源节点", () => {
    const note = formatAttachmentNote([
      attachment,
      { ...attachment, id: "attachment-2", kind: "video", name: "镜头.mp4" },
    ]);
    expect(note).toContain("图片参考：参考图.png（来自节点 node-1）");
    expect(note).toContain("视频参考：镜头.mp4 的首帧");
  });

  it("没有附件时保持纯文本内容，不改变既有请求形状", () => {
    const messages = buildChatMessages([MESSAGE], context());
    expect(messages.at(-1)?.content).toBe("写一集开场");
  });
});

describe("技能注入", () => {
  const skill = {
    id: "33333333-3333-4333-8333-333333333333",
    name: "分镜脚本编写",
    description: "把故事拆成可拍的分镜",
    body: "1. 先确定每场的功能。\n2. 再写镜头。",
  };

  it("技能正文作为系统消息注入，并声明不扩大权限", () => {
    const messages = buildChatMessages([MESSAGE], context(), "", "", [skill], "auto");
    const skillsMessage = messages.find((message) => message.content.includes("分镜脚本编写"));
    expect(skillsMessage?.role).toBe("system");
    expect(skillsMessage?.content).toContain("不扩大你的动作或工具范围");
    expect(skillsMessage?.content).toContain("2. 再写镜头。");
    // 技能消息排在对话消息之前，用户消息永远是最后一条。
    expect(messages.at(-1)?.content).toBe("写一集开场");
    expect(messages.at(-1)?.role).toBe("user");
  });

  it("没有启用技能时不注入这一段", () => {
    const messages = buildChatMessages([MESSAGE], context(), "", "", [], "request_approval");
    expect(messages.some((message) => message.content.includes("本轮启用的技能"))).toBe(false);
  });

  it("合计长度超过上限时按预算截断，不会挤掉画布摘要", () => {
    const many = Array.from({ length: 4 }, (_, index) => ({
      ...skill,
      id: `${index}3333333-3333-4333-8333-333333333333`,
      name: `技能${index}`,
      body: "长".repeat(30_000),
    }));
    const formatted = formatSkillsContext(many);
    // 预算 16000 字符 + 头部，最多 6000/条的正文上限，误差留给标题行。
    expect(formatted.length).toBeLessThan(16_000 + 400);
    expect(formatted).toContain("## 技能：技能0");
  });
});
