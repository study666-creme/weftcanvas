import { describe, expect, it, vi } from "vitest";

import type { AgentConnectorRegistry } from "./connectors/registry.js";
import type { BlenderBridgeClient } from "./connectors/blender-bridge.js";
import type { CodexRunner } from "./connectors/codex.js";
import { buildAgentTools, formatToolCatalog } from "./tools.js";

function registryStub(active: Array<{ id: "codex" | "blender"; target: string }>): AgentConnectorRegistry {
  return { active: async () => active } as unknown as AgentConnectorRegistry;
}

describe("buildAgentTools", () => {
  it("builds nothing when no connector is enabled and reachable", async () => {
    await expect(buildAgentTools(registryStub([]))).resolves.toEqual([]);
  });

  it("runs Blender python through the bridge and reports the result", async () => {
    const runPython = vi.fn(async () => ({ ok: true as const, stdout: "cube added\n", value: { objects: 1 } }));
    const tools = await buildAgentTools(registryStub([{ id: "blender", target: "127.0.0.1:9876" }]), {
      blenderClient: () => ({ runPython } as unknown as BlenderBridgeClient),
    });
    expect(tools.map((tool) => tool.name)).toEqual(["blender_run_python"]);

    const result = await tools[0]!.run({ code: "bpy.ops.mesh.primitive_cube_add()" }, {});
    expect(runPython).toHaveBeenCalledWith("bpy.ops.mesh.primitive_cube_add()", undefined);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("cube added");
    expect(result.content).toContain("objects");
  });

  it("reports a Blender failure as a failed tool result", async () => {
    const tools = await buildAgentTools(registryStub([{ id: "blender", target: "127.0.0.1:9876" }]), {
      blenderClient: () => ({
        runPython: async () => ({ ok: false as const, error: "Blender 桥接没有在监听" }),
      } as unknown as BlenderBridgeClient),
    });
    await expect(tools[0]!.run({ code: "print(1)" }, {})).resolves.toEqual({
      ok: false,
      content: "Blender 桥接没有在监听",
    });
  });

  it("delegates a task to Codex", async () => {
    const run = vi.fn(async () => ({ ok: true as const, output: "wrote script.py" }));
    const tools = await buildAgentTools(registryStub([{ id: "codex", target: "codex" }]), {
      codexRunner: () => ({ run } as unknown as CodexRunner),
    });
    const result = await tools[0]!.run({ task: "写一个批量改名脚本" }, {});
    expect(run).toHaveBeenCalledWith("写一个批量改名脚本", undefined);
    expect(result).toEqual({ ok: true, content: "Codex 已完成：\nwrote script.py" });
  });

  it("rejects a tool call without its required argument", async () => {
    const tools = await buildAgentTools(registryStub([{ id: "codex", target: "codex" }]), {
      codexRunner: () => ({ run: async () => ({ ok: true as const, output: "" }) } as unknown as CodexRunner),
    });
    await expect(tools[0]!.run({}, {})).resolves.toEqual({ ok: false, content: "缺少交给 Codex 的任务描述" });
  });

  it("describes the tool contract for the system prompt", () => {
    const catalog = formatToolCatalog([{
      name: "blender_run_python",
      description: "在 Blender 中执行 Python",
      parameters: [
        { name: "code", description: "代码", required: true },
        { name: "purpose", description: "目的", required: false },
      ],
      run: async () => ({ ok: true, content: "" }),
    }]);
    expect(catalog).toContain("blender_run_python(code, purpose?)");
    expect(catalog).toContain("在 Blender 中执行 Python");
  });
});
