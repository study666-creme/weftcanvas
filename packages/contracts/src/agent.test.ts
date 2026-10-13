import { describe, expect, it } from "vitest";

import { agentActionSchema } from "./agent.js";

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
