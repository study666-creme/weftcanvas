import { describe, expect, it } from "vitest";

import {
  AGENT_MESSAGE_ATTACHMENT_LIMITS,
  agentActionSchema,
  agentMessageAttachmentInputSchema,
  agentMessageSchema,
} from "./agent.js";

describe("agent UI actions", () => {
  it("accepts ui_open_panel with settings section and resource tab", () => {
    expect(
      agentActionSchema.parse({ type: "ui_open_panel", panel: "settings", section: "plugins" }),
    ).toEqual({ type: "ui_open_panel", panel: "settings", section: "plugins" });
    expect(
      agentActionSchema.parse({ type: "ui_open_panel", panel: "resource-drawer", tab: "cards" }),
    ).toMatchObject({ panel: "resource-drawer", tab: "cards" });
    expect(agentActionSchema.parse({ type: "ui_open_panel", panel: "activity" })).toMatchObject({
      panel: "activity",
    });
  });

  it("rejects unknown panels, sections, tabs, themes and schemes", () => {
    expect(agentActionSchema.safeParse({ type: "ui_open_panel", panel: "wallet" }).success).toBe(
      false,
    );
    expect(
      agentActionSchema.safeParse({ type: "ui_open_panel", panel: "settings", section: "billing" })
        .success,
    ).toBe(false);
    expect(
      agentActionSchema.safeParse({ type: "ui_open_panel", panel: "resource-drawer", tab: "media" })
        .success,
    ).toBe(false);
    expect(agentActionSchema.safeParse({ type: "ui_set_theme", theme: "sepia" }).success).toBe(
      false,
    );
    expect(
      agentActionSchema.safeParse({ type: "ui_set_color_scheme", scheme: "neon" }).success,
    ).toBe(false);
  });

  it("keeps ui actions strict (no stray fields)", () => {
    expect(
      agentActionSchema.safeParse({
        type: "ui_close_panel",
        panel: "shortcuts",
        section: "ui",
      }).success,
    ).toBe(false);
  });

  it("accepts every openable panel and both close semantics", () => {
    for (const panel of [
      "settings",
      "resource-drawer",
      "asset-library",
      "project-library",
      "activity",
      "shortcuts",
    ] as const) {
      expect(agentActionSchema.safeParse({ type: "ui_open_panel", panel }).success).toBe(true);
      expect(agentActionSchema.safeParse({ type: "ui_close_panel", panel }).success).toBe(true);
    }
  });
});

describe("agent message attachments", () => {
  const base = {
    id: "reference-1",
    kind: "image" as const,
    name: "参考图.jpg",
    mimeType: "image/jpeg",
    dataUrl: "data:image/jpeg;base64,AAAA",
  };

  it("accepts bounded image data URLs and fills metadata defaults", () => {
    expect(agentMessageAttachmentInputSchema.parse(base)).toMatchObject({
      kind: "image",
      width: null,
      height: null,
      durationMs: null,
    });
  });

  it("rejects non-image data URLs and overlong payloads", () => {
    expect(
      agentMessageAttachmentInputSchema.safeParse({
        ...base,
        dataUrl: "data:text/html;base64,AAAA",
      }).success,
    ).toBe(false);
    expect(
      agentMessageAttachmentInputSchema.safeParse({
        ...base,
        dataUrl: `data:image/jpeg;base64,${"A".repeat(
          AGENT_MESSAGE_ATTACHMENT_LIMITS.maxDataUrlChars + 1,
        )}`,
      }).success,
    ).toBe(false);
  });

  it("keeps old messages without attachments readable", () => {
    const parsed = agentMessageSchema.parse({
      schemaVersion: 1,
      id: "11111111-1111-4111-8111-111111111111",
      conversationId: "22222222-2222-4222-8222-222222222222",
      role: "user",
      content: "旧消息",
      createdAt: "2026-10-17T00:00:00.000Z",
    });
    expect(parsed.attachments).toEqual([]);
  });
});
