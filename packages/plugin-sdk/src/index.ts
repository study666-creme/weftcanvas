import type { ComponentType } from "react";

/**
 * @weftcanvas/plugin-sdk（docs/PLUGIN-ROADMAP.md §6 P3）
 *
 * 插件与宿主之间的全部契约都在这里。类型Only + 一个身份校验函数，零运行时
 * 依赖；React 仅以类型形式出现（插件跟宿主共享同一份 React，不自带）。
 *
 * 与参考实现（infinite-canvas 插件系统）的差异化：
 * - 插件永远拿不到模型密钥：ai.* 由宿主代发（BYOK 通道），Key 不出 localStorage；
 * - 节点 kind 命名空间强制 `plugin:<pluginId>:<name>`，撞名直接报错而非静默覆盖；
 * - 每个插件体渲染都包宿主 ErrorBoundary，插件抛错不击穿画布；
 * - storage 按插件名隔离，拿不到别的插件的命名空间；
 * - onDispose 对称清理，卸载必须可逆。
 */

/** 宿主主题令牌的只读快照（CSS 自定义属性名 → 值）。插件 UI 跟随明暗。 */
export type ThemeTokens = Readonly<Record<string, string>>;

/** 图标的结构化类型（lucide 兼容），SDK 不绑定具体图标库。 */
export type PluginIcon = ComponentType<{
  className?: string;
  size?: number | string;
  "aria-hidden"?: boolean | "true" | "false";
}>;

/** 插件节点体渲染入参。data 是宿主节点数据（结构化宽松视图）。 */
export type PluginNodeBodyProps = {
  kind: string;
  nodeId: string;
  projectId: string;
  data: {
    body: string;
    status: string;
    [key: string]: unknown;
  };
  /** 宿主代发的操作原语（与 Agent 命令同一套，见 ops）。 */
  ops: OpsApi;
  /** 更新本节点 body（经宿主校验与持久化）。 */
  updateBody(nextBody: string): void;
};

export type PluginNodeDraft = {
  data?: Record<string, unknown>;
  width: number;
  height: number;
};

export type PluginNodeCreateContext = {
  /** 用户的"默认画幅"偏好（"16:9" 等，或 legacy 三档尺寸）。 */
  defaultAspectRatio: string;
};

/**
 * 插件节点定义。`name` 是插件内的短名，宿主拼成完整 kind
 * `plugin:<pluginId>:<name>`；同名冲突直接报错。
 */
export type PluginNodeDefinition = {
  name: string;
  label: () => string;
  icon?: PluginIcon;
  accent?: string;
  /** false = 不进创建菜单（已存在节点仍渲染）。缺省 true。 */
  creatable?: boolean;
  createDraft: (ctx: PluginNodeCreateContext) => PluginNodeDraft;
  /** 节点体渲染（可选）。宿主包 ErrorBoundary 后调用。 */
  renderBody?: ComponentType<PluginNodeBodyProps>;
  connectionPolicy?: (ctx: { sourceKind: string | null; targetKind: string | null }) => boolean;
};

export type NodeRegistryApi = {
  registerNode(definition: PluginNodeDefinition): () => void;
  listNodes(): readonly { kind: string; label: () => string }[];
};

/** 按插件 + 命名空间隔离的本地 KV（宿主持久化，其它插件读不到）。 */
export type PluginKV = {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
};

/**
 * AI 能力：宿主代发。插件只声明意图，**永远拿不到模型密钥**；
 * 没有可用通道时宿主抛出明确的不可用错误，不假装成功。
 */
export type AiApi = {
  generateText(input: {
    prompt: string;
    modelId?: string;
    maxOutputTokens?: number;
  }): Promise<string>;
};

/**
 * 画布操作原语：与 Agent 命令（applyAgentActions）同一套 schema 校验与
 * 执行路径。动作形状见 @weftcanvas/contracts 的 agentActionSchema
 * （canvas_add_node / canvas_update_node / canvas_connect_nodes …）。
 */
export type PluginOp = { type: string; [key: string]: unknown };

export type OpsApi = {
  apply(ops: PluginOp[]): Promise<{ applied: number; skipped: number }>;
};

export type PluginContext = {
  pluginId: string;
  theme: ThemeTokens;
  nodes: NodeRegistryApi;
  storage(namespace: string): PluginKV;
  ai: AiApi;
  ops: OpsApi;
  /** 注册卸载清理；卸载时按注册的逆序执行。 */
  onDispose(fn: () => void): void;
};

export type Plugin = {
  /** [a-z][a-z0-9-]*，全局唯一；宿主以它做 kind/storage 命名空间。 */
  id: string;
  version: string;
  description?: string;
  setup(ctx: PluginContext): void | Promise<void>;
};

/** 声明一个插件：做基础校验后原样返回（宿主装载时会再校验一次）。 */
export function definePlugin(plugin: Plugin): Plugin {
  if (!/^[a-z][a-z0-9-]*$/.test(plugin.id)) {
    throw new Error(`[plugin-sdk] 插件 id 必须匹配 [a-z][a-z0-9-]*，收到 "${plugin.id}"`);
  }
  if (!plugin.version || typeof plugin.version !== "string") {
    throw new Error(`[plugin-sdk] 插件 ${plugin.id} 缺少 version`);
  }
  if (typeof plugin.setup !== "function") {
    throw new Error(`[plugin-sdk] 插件 ${plugin.id} 缺少 setup(ctx)`);
  }
  return plugin;
}
