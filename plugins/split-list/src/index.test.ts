import { describe, expect, it } from "vitest";

import plugin from "./index";
import { splitLines } from "./body";

type CapturedDefinition = {
  name: string;
  label: () => string;
  icon: unknown;
  accent?: string;
  creatable?: boolean;
  createDraft: (ctx: { defaultAspectRatio: string }) => { width: number; height: number };
  renderBody?: unknown;
};

describe("split-list plugin", () => {
  it("splits non-empty trimmed lines", () => {
    expect(splitLines("  a \n\nb\r\nc\n")).toEqual(["a", "b", "c"]);
    expect(splitLines("   ")).toEqual([]);
  });

  it("registers exactly one creatable node under a stable draft", async () => {
    expect(plugin.id).toBe("split-list");
    const captured: CapturedDefinition[] = [];
    const disposers: Array<() => void> = [];
    const kv = new Map<string, string>();
    await plugin.setup({
      pluginId: plugin.id,
      theme: {},
      nodes: {
        registerNode(definition) {
          captured.push(definition as unknown as CapturedDefinition);
          return () => {};
        },
        listNodes: () => [],
      },
      storage: () => ({
        get: (key) => kv.get(key) ?? null,
        set: (key, value) => void kv.set(key, value),
        remove: (key) => void kv.delete(key),
        keys: () => [...kv.keys()],
      }),
      ai: {
        generateText: async () => {
          throw new Error("not used in this test");
        },
      },
      ops: {
        apply: async () => ({ applied: 0, skipped: 0 }),
      },
      onDispose(fn) {
        disposers.push(fn);
      },
    });

    expect(captured).toHaveLength(1);
    const definition = captured[0]!;
    expect(definition.name).toBe("board");
    expect(definition.label()).toBe("批量拆单");
    expect(definition.creatable).not.toBe(false);
    expect(definition.accent).toBe("jade");
    expect(definition.createDraft({ defaultAspectRatio: "16:9" })).toEqual({
      width: 308,
      height: 190,
    });
    expect(typeof definition.renderBody).toBe("function");
  });
});
