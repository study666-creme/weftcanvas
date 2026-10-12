import type { AgentConnectorRegistry } from "./connectors/registry.js";
import { BlenderBridgeClient } from "./connectors/blender-bridge.js";
import { CodexRunner } from "./connectors/codex.js";

export type AgentToolResult = {
  ok: boolean;
  content: string;
};

export type AgentToolContext = {
  signal?: AbortSignal;
};

export type AgentTool = {
  name: string;
  description: string;
  /** 只暴露扁平字符串参数，保持提示词与解析都简单可校验。 */
  parameters: Array<{ name: string; description: string; required: boolean }>;
  run(args: Record<string, unknown>, context: AgentToolContext): Promise<AgentToolResult>;
};

export type AgentToolFactoryDeps = {
  blenderClient?: (target: string) => BlenderBridgeClient;
  codexRunner?: (target: string) => CodexRunner;
};

/**
 * 按当前启用且可达的连接构建本轮工具。断开的连接不会出现在这里，
 * 模型也就不会以为它能操作 Blender 或委派 Codex。
 */
export async function buildAgentTools(
  registry: AgentConnectorRegistry,
  deps: AgentToolFactoryDeps = {},
  signal?: AbortSignal,
): Promise<AgentTool[]> {
  const active = await registry.active(signal);
  const tools: AgentTool[] = [];
  for (const connector of active) {
    if (connector.id === "blender") {
      const client = (deps.blenderClient ?? ((target: string) => new BlenderBridgeClient(target)))(
        connector.target,
      );
      tools.push(createBlenderTool(client));
    }
    if (connector.id === "codex") {
      const runner = (deps.codexRunner ?? ((target: string) => new CodexRunner(target)))(
        connector.target,
      );
      tools.push(createCodexTool(runner));
    }
  }
  return tools;
}

function createBlenderTool(client: BlenderBridgeClient): AgentTool {
  return {
    name: "blender_run_python",
    description:
      "在本机 Blender 中执行一段 Python（bpy）代码，并返回 stdout 与结果值。用于建模、材质、场景整理和渲染准备。",
    parameters: [
      {
        name: "code",
        description: "完整可执行的 Python 代码，可用 bpy 与 bpy.context",
        required: true,
      },
      { name: "purpose", description: "这次操作的中文目的，会显示给用户", required: false },
    ],
    async run(args, context) {
      const code = readString(args, "code");
      if (!code) return { ok: false, content: "缺少要执行的 Python 代码" };
      const result = await client.runPython(code, context.signal);
      if (!result.ok) return { ok: false, content: result.error };
      const value =
        result.value === null || result.value === undefined
          ? ""
          : `\n结果：${safeJson(result.value)}`;
      const stdout = result.stdout.trim() ? `\n输出：${result.stdout.trim().slice(0, 2_000)}` : "";
      return { ok: true, content: `Blender 执行完成。${stdout}${value}`.trim() };
    },
  };
}

function createCodexTool(runner: CodexRunner): AgentTool {
  return {
    name: "codex_delegate",
    description:
      "把一段自包含的编码任务交给本机 Codex 非交互执行，并返回它的输出摘要。适合生成脚本、批量改写和本机工具编排。",
    parameters: [{ name: "task", description: "交给 Codex 的完整任务描述", required: true }],
    async run(args, context) {
      const task = readString(args, "task");
      if (!task) return { ok: false, content: "缺少交给 Codex 的任务描述" };
      const result = await runner.run(task, context.signal);
      if (!result.ok) return { ok: false, content: result.error };
      return {
        ok: true,
        content: result.output
          ? `Codex 已完成：\n${result.output}`
          : "Codex 执行完成，但没有输出内容。",
      };
    },
  };
}

/** 写进系统提示的工具清单，让模型知道本轮真正可用的能力。 */
export function formatToolCatalog(tools: readonly AgentTool[]): string {
  const lines = ["本轮可用的本机工具（只有这些；需要时在 toolCalls 里调用）："];
  for (const tool of tools) {
    const params = tool.parameters
      .map((parameter) => `${parameter.name}${parameter.required ? "" : "?"}`)
      .join(", ");
    lines.push(`- ${tool.name}(${params})：${tool.description}`);
  }
  lines.push("一次最多调用两个工具；调用后你会收到结果，再给出最终 JSON 回复。");
  return lines.join("\n");
}

function readString(args: Record<string, unknown>, key: string) {
  const value = args[key];
  return typeof value === "string" ? value.trim() : "";
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 2_000);
  } catch {
    return String(value).slice(0, 2_000);
  }
}
