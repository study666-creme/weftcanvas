import {
  agentActionSchema,
  agentExecutionModeSchema,
  agentProposalDraftSchema,
  type AgentAction,
  type AgentExecutionMode,
  type AgentProposalDraft,
} from "@weftcanvas/contracts";
import { z } from "zod";

const agentOutputFields = {
  content: z.string().trim().min(1).max(16_000),
  actions: z.array(agentActionSchema).max(32).default([]),
};

/**
 * 本机工具调用。它不是画布契约的一部分：运行时执行完就把结果回灌给模型，
 * 浏览器只会看到最终 content 与 actions，因此工具调用不会进入执行回执。
 */
const agentToolCallSchema = z
  .object({
    name: z.string().trim().min(1).max(64),
    arguments: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type AgentToolCall = z.infer<typeof agentToolCallSchema>;

const agentOutputSchema = z
  .object({
    ...agentOutputFields,
    toolCalls: z.array(agentToolCallSchema).max(2).default([]),
    executionMode: agentExecutionModeSchema,
    proposal: agentProposalDraftSchema.nullable().default(null),
  })
  .strict();

const legacyAgentOutputSchema = z.object(agentOutputFields).strict();

export type AgentModelOutput = {
  content: string;
  actions: AgentAction[];
  toolCalls: AgentToolCall[];
  executionMode: AgentExecutionMode;
  proposal: AgentProposalDraft | null;
};

export function parseAgentModelOutput(value: string): AgentModelOutput {
  const raw = value.trim();
  const parsed = parseStructuredOutput(raw);
  if (parsed) return parsed;
  // 模型常见偏差：只输出 actions 数组（或单个 action），没有包 envelope；
  // 长方案还会撞上输出上限被截断成不完整 JSON。两条都尽量把动作救回来，
  // 而不是把原始 JSON 当正文直接丢给用户（那会泄露英文键名、且画布什么都不做）。
  const recovered = parseActionPayload(raw);
  if (recovered) return recovered;
  const visible = sanitizeVisibleContent(raw);
  return {
    content: visible === EMPTY_VISIBLE_CONTENT ? EMPTY_VISIBLE_MESSAGE : visible,
    actions: [],
    toolCalls: [],
    executionMode: "none",
    proposal: null,
  };
}

/**
 * 从「没有 envelope」或「被截断」的输出里抢救动作：
 * 1. 找到第一段 JSON，逐对象解析（截断时只丢最后一个不完整的）；
 * 2. 用 JSON 之前的自然语言当 content，没有就合成一句中文说明。
 */
function parseActionPayload(value: string): AgentModelOutput | null {
  const start = findJsonStart(value);
  if (start < 0) return null;
  const objects = collectJsonObjects(value.slice(start));
  const actions: AgentAction[] = [];
  for (const candidate of objects) {
    const normalized = normalizeAgentOutputJson({ actions: [candidate] });
    const parsed = z.object({ actions: z.array(agentActionSchema).max(32) }).safeParse(normalized);
    if (parsed.success && parsed.data.actions[0]) actions.push(parsed.data.actions[0]);
    if (actions.length >= 32) break;
  }
  if (!actions.length) return null;
  const prose = sanitizeVisibleContent(value.slice(0, start));
  return normalizeOutput({
    content:
      prose === EMPTY_VISIBLE_CONTENT ? `已生成 ${actions.length} 项画布操作，确认后应用。` : prose,
    actions,
    toolCalls: [],
    executionMode: "proposal",
    proposal: null,
  });
}

function findJsonStart(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "[" || char === "{") return index;
  }
  return -1;
}

/** 在（可能被截断的）文本里逐个抓取花括号平衡的 JSON 对象。 */
function collectJsonObjects(value: string): unknown[] {
  const objects: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          objects.push(JSON.parse(value.slice(start, index + 1)));
        } catch {
          // 单个对象解析失败就跳过，继续找下一个
        }
        start = -1;
      }
    }
  }
  return objects;
}

const EMPTY_VISIBLE_CONTENT = "\u0000empty";
const EMPTY_VISIBLE_MESSAGE =
  "模型这次没有返回可用的回复（响应格式无法解析），请重试或换一个模型。";

/** 兜底展示：去掉围栏与裸 JSON 行，避免把英文键名当正文给用户看。 */
export function sanitizeVisibleContent(value: string) {
  const withoutFence = value.replace(/```[a-z]*\n?/gi, "");
  const lines = withoutFence
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return true;
      if (/^[[\]{}]/.test(trimmed)) return false;
      if (/^"[^"]+"\s*:/.test(trimmed)) return false;
      if (
        /^(type|clientId|kind|body|text|actions|content|executionMode|proposal|toolCalls|sourceNodeId|targetNodeId)"?\s*:/.test(
          trimmed,
        )
      )
        return false;
      return true;
    });
  const collapsed = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return collapsed || EMPTY_VISIBLE_CONTENT;
}

/**
 * A few OpenAI-compatible models wrap a second JSON envelope inside `content`.
 * Recover it only from an otherwise empty no-op envelope so normal prose is
 * still returned unchanged.
 */
function parseStructuredOutput(value: string, depth = 0): AgentModelOutput | null {
  if (depth > 2) return null;
  const candidate = unwrapJsonFence(value.trim());
  try {
    const json = normalizeAgentOutputJson(JSON.parse(candidate));
    const current = agentOutputSchema.safeParse(json);
    if (current.success) {
      const normalized = normalizeOutput(current.data);
      if (
        depth < 2 &&
        normalized.actions.length === 0 &&
        normalized.toolCalls.length === 0 &&
        normalized.executionMode === "none" &&
        normalized.proposal === null
      ) {
        const nested = parseStructuredOutput(current.data.content, depth + 1);
        if (
          nested &&
          (nested.actions.length > 0 || nested.executionMode !== "none" || nested.proposal !== null)
        ) {
          return nested;
        }
      }
      return normalized;
    }
    const legacy = legacyAgentOutputSchema.safeParse(json);
    if (legacy.success) {
      return normalizeOutput({
        ...legacy.data,
        toolCalls: [],
        executionMode: legacy.data.actions.length ? "proposal" : "none",
        proposal: null,
      });
    }
  } catch {
    // Fall through to a plain answer when the provider ignores the JSON contract.
  }
  return null;
}

/**
 * Models occasionally use descriptive aliases for the two most common canvas
 * actions. Map only aliases we explicitly support before running the strict
 * contract parse. Unknown fields remain untouched and are rejected by the
 * schema; supplying both names leaves the action ambiguous and is rejected as
 * well.
 */
function normalizeAgentOutputJson(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.actions)) return value;
  return {
    ...value,
    actions: value.actions.map(normalizeAgentAction).filter((action) => action !== null),
  };
}

/** 动作字段别名表：只映射明确支持的两组常见写法。 */
const ACTION_ALIASES: Record<
  string,
  ReadonlyArray<readonly [canonical: string, aliases: readonly string[]]>
> = {
  canvas_add_node: [
    ["kind", ["nodeType"]],
    ["body", ["text"]],
  ],
  canvas_connect_nodes: [
    ["sourceNodeId", ["source", "from"]],
    ["targetNodeId", ["target", "to"]],
  ],
};

function normalizeAgentAction(value: unknown): unknown | null {
  if (!isRecord(value)) return value;
  let normalized = flattenActionPayload(value);
  const type = typeof normalized.type === "string" ? normalized.type : null;
  if (!type) return normalized;
  // 同时给出规范名和别名时语义不明确，宁可丢弃这条动作，也不要替模型猜。
  if (hasAmbiguousAlias(normalized, type)) return null;
  normalized = mapActionAliases(normalized, ACTION_ALIASES[type] ?? []);
  const allowed = ACTION_ALLOWED_KEYS[type];
  if (!allowed) return normalized;
  // 模型会顺手塞 title/description 这类装饰字段，还会漏掉有默认语义的 kind。
  // 装饰字段丢掉即可，不要为它整条拒收；缺 kind 且有正文就按文本节点处理。
  const filtered: Record<string, unknown> = {};
  for (const key of allowed) {
    if (hasOwn(normalized, key)) filtered[key] = normalized[key];
  }
  if (type === "canvas_add_node" && !hasOwn(filtered, "kind") && hasOwn(filtered, "body")) {
    filtered.kind = "text";
  }
  return filtered;
}

function hasAmbiguousAlias(value: Record<string, unknown>, type: string) {
  return (ACTION_ALIASES[type] ?? []).some(
    ([canonical, aliases]) =>
      hasOwn(value, canonical) && aliases.some((alias) => hasOwn(value, alias)),
  );
}

/** 每个动作类型允许的字段，直接从契约 schema 读，避免和契约漂移。 */
const ACTION_ALLOWED_KEYS: Record<string, readonly string[]> = (() => {
  const map: Record<string, readonly string[]> = {};
  const options = (agentActionSchema as unknown as { options?: readonly unknown[] }).options ?? [];
  for (const option of options) {
    const shape = (option as { shape?: Record<string, unknown> }).shape;
    const literal = shape?.type as { value?: unknown } | undefined;
    if (shape && typeof literal?.value === "string") map[literal.value] = Object.keys(shape);
  }
  return map;
})();

/**
 * 模型经常把动作参数套一层：`{"type":"canvas_add_node","payload":{"kind":"text",...}}`，
 * 或者用工具调用风格的 `{"name":"canvas_add_node","arguments":{...}}`。
 * 这里把嵌套层摊平到顶层（顶层字段优先），并把 name 提升为 type，其余交给严格 schema 校验。
 */
function flattenActionPayload(value: Record<string, unknown>) {
  let result = { ...value };
  for (const key of ["payload", "arguments", "input"]) {
    const nested = result[key];
    if (!isRecord(nested)) continue;
    delete result[key];
    result = { ...nested, ...result };
  }
  if (typeof result.type !== "string" && typeof result.name === "string") {
    result.type = result.name;
  }
  if (typeof result.name === "string" && typeof result.type === "string") {
    delete result.name;
  }
  return result;
}

function mapActionAliases(
  value: Record<string, unknown>,
  aliases: ReadonlyArray<readonly [canonical: string, aliases: ReadonlyArray<string>]>,
): Record<string, unknown> {
  const normalized = { ...value };
  for (const [canonical, aliasNames] of aliases) {
    const present = [canonical, ...aliasNames].filter((key) => hasOwn(value, key));
    if (present.length !== 1) continue;
    const alias = present[0]!;
    if (alias === canonical) continue;
    normalized[canonical] = value[alias];
    delete normalized[alias];
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeOutput(value: {
  content: string;
  actions: AgentAction[];
  toolCalls: AgentToolCall[];
  executionMode: AgentExecutionMode;
  proposal: AgentProposalDraft | null;
}): AgentModelOutput {
  if (!value.actions.length) {
    return {
      content: value.content,
      actions: [],
      toolCalls: value.toolCalls,
      executionMode: "none",
      proposal: null,
    };
  }
  if (value.executionMode === "direct" && value.actions.every(isDirectAction)) {
    return { ...value, toolCalls: [], executionMode: "direct", proposal: null };
  }
  return {
    ...value,
    toolCalls: [],
    executionMode: "proposal",
    proposal: value.proposal ?? defaultProposal(),
  };
}

function isDirectAction(action: AgentAction) {
  return (
    action.type === "canvas_connect_nodes" ||
    action.type === "canvas_select_nodes" ||
    action.type === "canvas_group_nodes" ||
    action.type === "canvas_set_viewport" ||
    action.type === "canvas_director_open" ||
    action.type === "canvas_director_select_shot" ||
    action.type === "canvas_director_update_entity"
  );
}

function defaultProposal(): AgentProposalDraft {
  return {
    title: "应用建议的画布调整",
    reason: "这些操作会修改当前项目，执行前需要由你确认。",
    successCriteria: ["所列操作成功应用，无法应用的项目会显示原因"],
  };
}

function unwrapJsonFence(value: string) {
  const match = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match?.[1]?.trim() || value;
}
