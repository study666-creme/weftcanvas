import type { AgentConversationDetail } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import {
  AGENT_CONVERSATION_EXPORT_FORMAT,
  AGENT_CONVERSATION_EXPORT_VERSION,
  agentConversationExportFilename,
  buildAgentConversationExport,
  redactSensitiveString,
} from "./agent-conversation-export";

const EXPORTED_AT = "2026-10-16T12:30:01.123Z";

describe("agent conversation export", () => {
  it("strips bearer tokens, sk- keys, data URLs and query strings from every string value", () => {
    const detail = conversationDetail({
      assistant: [
        "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
        "上游 key：sk-abcdef1234567890",
        "内联图：data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==",
        "入口：https://creator:pa55word@api.example.com/v1/models?api_key=SECRET123&page=1",
        "回调：https://example.com/cb?token=TOP_SECRET",
      ].join("\n"),
    });

    const payload = buildAgentConversationExport(detail, EXPORTED_AT);
    const serialized = JSON.stringify(payload);

    expect(serialized).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(serialized).not.toContain("sk-abcdef1234567890");
    expect(serialized).not.toContain("iVBORw0KGgoAAAANSUhEUg==");
    expect(serialized).not.toContain("pa55word");
    expect(serialized).not.toContain("SECRET123");
    expect(serialized).not.toContain("TOP_SECRET");
    expect(payload.messages[1]!.content).toContain("Bearer [redacted]");
    expect(payload.messages[1]!.content).toContain("data:[redacted]");
  });

  it("recurses through arrays and objects inside the run record", () => {
    const detail = conversationDetail({});
    detail.latestRun = {
      ...run(),
      actions: [
        {
          type: "canvas_add_node",
          clientId: "beat",
          kind: "text",
          body: "Bearer aa.bb.cc 与 sk-livekey1234567890 与 https://x.test/a?token=HIDDEN",
        },
      ],
      error: { code: "UPSTREAM", message: "key=sk-nested1234567890", retryable: true },
    } as unknown as AgentConversationDetail["latestRun"];

    const serialized = JSON.stringify(buildAgentConversationExport(detail, EXPORTED_AT));

    expect(serialized).not.toContain("aa.bb.cc");
    expect(serialized).not.toContain("sk-livekey1234567890");
    expect(serialized).not.toContain("HIDDEN");
    expect(serialized).not.toContain("sk-nested1234567890");
  });

  it("keeps the exported shape stable", () => {
    const detail = conversationDetail({});
    const payload = buildAgentConversationExport(detail, EXPORTED_AT);

    expect(Object.keys(payload)).toEqual([
      "format",
      "version",
      "exportedAt",
      "conversation",
      "messages",
      "run",
    ]);
    expect(payload.format).toBe(AGENT_CONVERSATION_EXPORT_FORMAT);
    expect(payload.version).toBe(AGENT_CONVERSATION_EXPORT_VERSION);
    expect(payload.exportedAt).toBe(EXPORTED_AT);
    expect(payload.conversation).toEqual(detail.conversation);
    expect(payload.messages).toHaveLength(detail.messages.length);
    expect(payload.run).toEqual(detail.latestRun);
  });

  it("builds a filename-safe download name", () => {
    const filename = agentConversationExportFilename(
      "11111111-1111-4111-8111-111111111111",
      EXPORTED_AT,
    );

    expect(filename).toBe(
      "agent-conversation-11111111-1111-4111-8111-111111111111-2026-10-16T12-30-01.123Z.json",
    );
    expect(filename).not.toContain(":");
  });

  it("redacts individual strings without touching ordinary text", () => {
    expect(redactSensitiveString("Bearer token.value.here")).toBe("Bearer [redacted]");
    expect(redactSensitiveString("https://cdn.example.com/a.png?w=100")).toBe(
      "https://cdn.example.com/a.png?[redacted]",
    );
    expect(redactSensitiveString("把 disk-usage 和 task-list 写进说明")).toBe(
      "把 disk-usage 和 task-list 写进说明",
    );
  });
});

function conversationDetail({ user = "", assistant = "" }: { user?: string; assistant?: string }) {
  return {
    conversation: {
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      projectId: "project-1",
      title: "导出检查",
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
    },
    messages: [
      {
        schemaVersion: 1,
        id: "22222222-2222-4222-8222-222222222222",
        conversationId: "11111111-1111-4111-8111-111111111111",
        role: "user",
        content: user || "帮我看看这组节点",
        createdAt: "2026-10-16T12:00:00.000Z",
      },
      {
        schemaVersion: 1,
        id: "33333333-3333-4333-8333-333333333333",
        conversationId: "11111111-1111-4111-8111-111111111111",
        role: "assistant",
        content: assistant,
        createdAt: "2026-10-16T12:00:01.000Z",
      },
    ],
    latestRun: run(),
  } as unknown as AgentConversationDetail;
}

function run() {
  return {
    schemaVersion: 1,
    id: "44444444-4444-4444-8444-444444444444",
    conversationId: "11111111-1111-4111-8111-111111111111",
    userMessageId: "22222222-2222-4222-8222-222222222222",
    assistantMessageId: "33333333-3333-4333-8333-333333333333",
    modelId: "gpt-5-mini",
    status: "completed",
    actions: [],
    executionMode: "none",
    executionPermission: "request_approval",
    skillIds: [],
    proposal: null,
    proposalStatus: null,
    contextRevision: "ctx-1",
    receipt: null,
    error: null,
    createdAt: "2026-10-16T12:00:00.000Z",
    startedAt: "2026-10-16T12:00:00.100Z",
    completedAt: "2026-10-16T12:00:02.000Z",
  };
}
