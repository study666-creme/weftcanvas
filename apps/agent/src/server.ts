import { serve } from "@hono/node-server";
import { fileURLToPath } from "node:url";

import { createAgentApp } from "./app.js";
import { CanvasControlQueue } from "./canvas-control.js";
import { AgentConnectorRegistry } from "./connectors/registry.js";
import { defaultProvisionContext, provisionBlender, provisionCodex } from "./connectors/provision.js";
import { createRemoteBlenderTool, RemoteBlenderRunner } from "./connectors/remote-blender.js";
import { MemoryConnectorSettingsStore } from "./connectors/settings.js";
import { createKnowledgeRetriever } from "./knowledge.js";
import { AgentModelRegistry } from "./models.js";
import { OpenAICompatibleClient } from "./openai-compatible.js";
import { AgentRunHandler } from "./run-handler.js";
import { buildAgentTools } from "./tools.js";

const port = readInteger(process.env.PORT, 8790, 1, 65_535);
const token = required("AGENT_RUNTIME_TOKEN");
const models = new AgentModelRegistry(required("OPENAI_MODEL"), process.env.OPENAI_MODELS);
const model = new OpenAICompatibleClient({
  baseUrl: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
  apiKey: required("OPENAI_API_KEY"),
  model: models.getCatalog().defaultModelId,
  timeoutMs: readInteger(process.env.OPENAI_TIMEOUT_MS, 120_000, 1_000, 30 * 60_000),
  ...(process.env.OPENAI_MAX_OUTPUT_TOKENS
    ? { maxOutputTokens: readInteger(process.env.OPENAI_MAX_OUTPUT_TOKENS, 2_048, 16, 16_000) }
    : {}),
});

// 本机连接：Blender 桥接地址与 Codex 命令都可用环境变量预设默认值，
// 面板里的开关在进程重启后回到这些默认值（连接状态本身不落盘）。
const connectorDefaults = {
  codex: process.env.CODEX_BIN?.trim() || "codex",
  blender: process.env.BLENDER_BRIDGE_ADDRESS?.trim() || "127.0.0.1:9876",
};
const connectors = new AgentConnectorRegistry(
  new MemoryConnectorSettingsStore({
    codex: { enabled: readBoolean(process.env.CODEX_CONNECTOR_ENABLED, false), endpoint: null },
    blender: { enabled: readBoolean(process.env.BLENDER_CONNECTOR_ENABLED, false), endpoint: null },
  }),
  {
    defaults: connectorDefaults,
    // 一键接入：这两个资源路径从 src/ 与 dist/ 都能解到 apps/agent 下。
    provisioner: (() => {
      const context = defaultProvisionContext({
        agentBaseUrl: `http://127.0.0.1:${port}`,
        agentToken: token,
        assets: {
          mcpScript: fileURLToPath(new URL("../mcp/canvas-mcp.mjs", import.meta.url)),
          blenderAddon: fileURLToPath(new URL("../blender/kachang_bridge.py", import.meta.url)),
        },
      });
      return {
        codex: (command: string) => provisionCodex(context, command),
        blender: (address: string, launch: boolean) => provisionBlender(context, { launch, address }),
      };
    })(),
  },
);
const canvasControl = new CanvasControlQueue({
  waitMs: readInteger(process.env.CANVAS_CONTROL_WAIT_MS, 60_000, 5_000, 10 * 60_000),
});

// 托管站点上"用户自己的 Blender"要通过 Canvas API 的配对通道派发。
// 生产机的 API 在 127.0.0.1:8788，本机开发在 8787，所以用 CANVAS_API_URL 显式指定。
const canvasApiUrl = process.env.CANVAS_API_URL?.trim() || "http://127.0.0.1:8787";
const remoteBlender = new RemoteBlenderRunner(canvasApiUrl, token);

const app = createAgentApp({
  token,
  models,
  runs: new AgentRunHandler(model, models, createKnowledgeRetriever(), {
    buildTools: async (request, signal) => {
      // 用户有在线的外部 Blender 时走远程通道；否则退回本机运行时（开发/自托管）。
      if (request.ownerId && request.remoteConnectors?.blender) {
        return [createRemoteBlenderTool(remoteBlender, request.ownerId)];
      }
      return buildAgentTools(connectors, {}, signal);
    },
  }),
  connectors,
  canvasControl,
});

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Canvas private agent listening on http://127.0.0.1:${info.port}`);
});

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readInteger(value: string | undefined, fallback: number, min: number, max: number) {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected an integer between ${min} and ${max}`);
  }
  return parsed;
}

function readBoolean(value: string | undefined, fallback: boolean) {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}
