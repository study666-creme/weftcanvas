import {
  agentActionSchema,
  type AgentAction,
} from "@kachang/contracts";
import type {
  Plugin,
  PluginContext,
  PluginNodeBodyProps,
  PluginNodeDefinition,
  PluginOp,
} from "@kachang/plugin-sdk";

import { executeAgentActions } from "./agent-action-executor";
import { createSyntheticCustomModel, createSyntheticCustomRoute, executeCustomGeneration } from "./custom-api";
import { getNodeDefinition, registerNode, type NodeCreateContext, type NodeDefinition } from "./node-registry";
import { useCanvasStore } from "../state/canvas-store";
import { useCustomApiStore } from "../state/custom-api-store";

/**
 * 画布操作通道：与 Agent 命令同一套 schema 校验 + 执行路径（含命令 id 去重）。
 * 插件面板与插件节点体共用；runTag 只用于去重键命名空间。
 */
export function applyCanvasOps(runTag: string, ops: PluginOp[]): { applied: number; skipped: number } {
  const actions: AgentAction[] = ops.map((op) => agentActionSchema.parse(op));
  const result = executeAgentActions(useCanvasStore.getState().projectId, `${runTag}-${Date.now()}`, actions);
  return { applied: result.applied, skipped: result.skipped };
}

/**
 * 插件宿主（docs/PLUGIN-ROADMAP.md §6 P3）：装载/卸载官方与本地开发插件。
 *
 * - 命名空间：插件节点 kind 一律 `plugin:<pluginId>:<name>`，撞名直接报错；
 * - 对称卸载：setup 里注册的资源经 onDispose 逆序回收；
 * - 密钥纪律：插件 API 面上没有任何密钥读取；ai.* 由宿主走既有 BYOK 通道代发；
 * - 不做 URL 远程加载、不用 eval——插件只来自随包 chunk 或本地开发入口。
 */

type LoadedPlugin = {
  plugin: Plugin;
  disposers: (() => void)[];
  registeredKinds: string[];
};

const loadedPlugins = new Map<string, LoadedPlugin>();
const listeners = new Set<() => void>();

function emitChange() {
  for (const listener of listeners) listener();
}

export function listInstalledPluginIds(): string[] {
  return [...loadedPlugins.keys()];
}

export function subscribeToPlugins(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getPluginBodyRenderer(kind: string) {
  return getNodeDefinition(kind)?.renderBody ?? null;
}

function namespacedKind(pluginId: string, name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error(`[plugin-host] 节点短名 "${name}" 含非法字符（只允许字母数字 ._ -）`);
  }
  return `plugin:${pluginId}:${name}`;
}

function createPluginContext(
  plugin: Plugin,
  disposers: (() => void)[],
  registeredKinds: string[],
): PluginContext {
  const onDispose = (fn: () => void) => {
    disposers.push(fn);
  };
  const registeredSummaries: { kind: string; label: () => string }[] = [];
  return {
    pluginId: plugin.id,
    theme: {},
    nodes: {
      registerNode(definition: PluginNodeDefinition) {
        const kind = namespacedKind(plugin.id, definition.name);
        if (getNodeDefinition(kind)) {
          throw new Error(`[plugin-host] 节点类型 "${kind}" 已存在（宿主拒绝覆盖）`);
        }
        const hostDefinition: NodeDefinition = {
          // kind 命名空间由 pluginId 保证；contracts 的模板字面量类型在边界收窄。
          kind: kind as NodeDefinition["kind"],
          label: definition.label,
          // 插件自带的图标组件是结构化 PluginIcon；菜单渲染只需要 className/aria。
          icon: definition.icon as NodeDefinition["icon"],
          accent: definition.accent ?? "jade",
          creatable: definition.creatable !== false,
          createDraft: (ctx: NodeCreateContext) => {
            const draft = definition.createDraft({ defaultAspectRatio: ctx.defaultAspectRatio as string });
            return { kind: kind as NodeDefinition["kind"], ...draft };
          },
          renderBody: definition.renderBody as NodeDefinition["renderBody"],
          owner: plugin.id,
        };
        const unregister = registerNode(hostDefinition);
        registeredKinds.push(kind);
        registeredSummaries.push({ kind, label: definition.label });
        onDispose(() => unregister());
        return () => {
          const index = registeredKinds.indexOf(kind);
          if (index >= 0) registeredKinds.splice(index, 1);
          const summaryIndex = registeredSummaries.findIndex((item) => item.kind === kind);
          if (summaryIndex >= 0) registeredSummaries.splice(summaryIndex, 1);
          unregister();
        };
      },
      listNodes: () => registeredSummaries,
    },
    storage(namespace: string) {
      if (!/^[a-z0-9_-]{1,64}$/i.test(namespace)) {
        throw new Error(`[plugin-host] 存储命名空间 "${namespace}" 含非法字符`);
      }
      const prefix = `kachang-canvas:plugin:${plugin.id}:${namespace}:`;
      const read = (key: string) => {
        try {
          return localStorage.getItem(prefix + key);
        } catch {
          return null;
        }
      };
      return {
        get: read,
        set(key, value) {
          try {
            localStorage.setItem(prefix + key, value);
          } catch {
            // 存储不可用时静默：会话内 state 仍可用。
          }
        },
        remove(key) {
          try {
            localStorage.removeItem(prefix + key);
          } catch {
            // 同上。
          }
        },
        keys() {
          const result: string[] = [];
          try {
            for (let index = 0; index < localStorage.length; index += 1) {
              const key = localStorage.key(index);
              if (key?.startsWith(prefix)) result.push(key.slice(prefix.length));
            }
          } catch {
            // 存储不可用时返回空。
          }
          return result;
        },
      };
    },
    ai: {
      async generateText(input) {
        // 宿主代发：插件只给意图，密钥不出 localStorage（BYOK 通道）。
        const state = useCustomApiStore.getState();
        const profile = state.profiles.find((item) => item.id === state.activeProfileId)
          ?? state.profiles.find((item) => item.enabled)
          ?? null;
        const connection = profile?.connection ?? state.connection;
        if (!connection?.apiKey?.trim()) {
          throw new Error("PLUGINS_AI_UNAVAILABLE: 未配置可用的自定义 API（设置 → API 配置）");
        }
        const modelId = input.modelId?.trim()
          || profile?.catalog?.models.find((model) => model.modality === "text")?.id;
        if (!modelId) {
          throw new Error("PLUGINS_AI_UNAVAILABLE: 当前 API 配置里没有可选的文本模型");
        }
        const model = createSyntheticCustomModel(modelId, "text");
        const route = createSyntheticCustomRoute(modelId, "text");
        if (!route) throw new Error("PLUGINS_AI_UNAVAILABLE: 当前 API 配置不支持文本执行");
        const result = await executeCustomGeneration({
          connection,
          model,
          route,
          parameters: {
            prompt: input.prompt,
            ...(input.maxOutputTokens ? { max_tokens: input.maxOutputTokens } : {}),
          },
          inputs: { images: [], videos: [], audios: [] },
        });
        if (!result.text) {
          throw new Error("PLUGINS_AI_UNAVAILABLE: 文本生成没有返回可用内容");
        }
        return result.text;
      },
    },
    ops: {
      async apply(ops: PluginOp[]) {
        return applyCanvasOps(`plugin-${plugin.id}`, ops);
      },
    },
    onDispose,
  };
}

/** 装载一个插件模块（default 导出 Plugin）。重复 id 直接报错。 */
export async function installPlugin(module: { default: Plugin } | Plugin): Promise<void> {
  const plugin = "default" in module ? module.default : module;
  if (loadedPlugins.has(plugin.id)) {
    throw new Error(`[plugin-host] 插件 "${plugin.id}" 已装载`);
  }
  if (typeof plugin.version !== "string" || !plugin.version.trim()) {
    throw new Error(`[plugin-host] 插件 "${plugin.id}" 缺少 version`);
  }
  const disposers: (() => void)[] = [];
  const registeredKinds: string[] = [];
  const context = createPluginContext(plugin, disposers, registeredKinds);
  await plugin.setup(context);
  loadedPlugins.set(plugin.id, { plugin, disposers, registeredKinds });
  emitChange();
}

/** 卸载一个插件：onDispose 逆序执行（节点注册随 disposer 回收）。 */
export function uninstallPlugin(pluginId: string): void {
  const loaded = loadedPlugins.get(pluginId);
  if (!loaded) return;
  loadedPlugins.delete(pluginId);
  for (const disposer of [...loaded.disposers].reverse()) {
    try {
      disposer();
    } catch (error) {
      console.error(`[plugin-host] 插件 ${pluginId} 的清理回调失败`, error);
    }
  }
  emitChange();
}

export function getLoadedPlugin(pluginId: string): Plugin | null {
  return loadedPlugins.get(pluginId)?.plugin ?? null;
}

/** 供测试与调试：DEV 下挂到 window，用于装/卸演练。 */
export function exposePluginHostTestHook(): void {
  (globalThis as Record<string, unknown>).__kachangPluginHost = {
    install: installPlugin,
    uninstall: uninstallPlugin,
    list: listInstalledPluginIds,
  };
}

export type { PluginNodeBodyProps };
