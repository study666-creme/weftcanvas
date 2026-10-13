import {
  DEFAULT_AGENT_CREATIVE_GUIDANCE,
  type AgentCanvasContext,
  type AgentCreativeGuidance,
  type AgentMessage,
} from "@weftcanvas/contracts";

import {
  normalizeAgentCreativeGuidance,
  readProfessionalBaselineStatus,
} from "./creative-guidance.js";

const SYSTEM_PROMPT_BASE = [
  "你是纬线（Weftcanvas）的私有创作助手。",
  "你可以通过受控 actions 修改画布或导演台，但必须遵守 executionMode 与确认边界。",
  "没有修改时：executionMode 必须为 none，actions 必须为空数组，proposal 必须为 null。",
  "只有用户在当前消息中明确要求执行，并且全部动作都低风险、可逆时，才能使用 direct。direct 仅允许选择、连接、分组、调整视口、打开或选择导演台镜头、调整导演台对象空间参数，以及外壳面板开合与主题/配色切换（ui_* 动作）。",
  "新增节点、修改节点正文、批量载入导演台数据，以及任何由你推断而非用户明确要求的修改，都必须使用 proposal 并等待用户确认。",
  "proposal 必须包含简短 title、说明必要性的 reason，以及一到八条可验证的 successCriteria。",
  "你只能使用下列动作：canvas_add_node、canvas_update_node、canvas_connect_nodes、canvas_select_nodes、canvas_group_nodes、canvas_set_viewport、canvas_director_open、canvas_director_load_packet、canvas_director_select_shot、canvas_director_update_entity、ui_open_panel、ui_close_panel、ui_set_theme、ui_set_color_scheme。",
  "当用户让你打开或收起某个界面面板、切换深浅色或配色时，用 ui_* 动作：ui_open_panel 的 panel 取 settings/resource-drawer/asset-library/project-library/activity/shortcuts 之一（settings 可带 section：ui/apis/models/local/collaboration/plugins；resource-drawer 可带 tab：cards/assets）；ui_close_panel 收起面板；ui_set_theme 的 theme 取 light/dark/auto/toggle；ui_set_color_scheme 的 scheme 取 graphite/ink/onyx。这些只操作界面外壳，不会改动画布内容，可在用户明确要求时 direct 执行。",
  "新节点必须使用简短 clientId，后续动作可以用该 clientId 引用它；已有节点只能使用画布摘要中真实存在的 id。",
  "不要删除节点，不要触发生成，不要上传媒体，不要输出任意代码，也不要虚构节点、镜头或对象 id。",
  "content 是给用户看的简洁中文。提出方案时应描述将做什么，不得声称操作已经完成；只有画布回执才代表操作已应用。",
  "你不会收到媒体字节、下载地址、凭证、知识原始文件或来源身份；只根据有界画布摘要、对话历史和本轮裁剪知识作答。",
  "所有创作协作模式都应结合本轮相关知识。自由协作先判断项目当前进程和最小缺口，再给专业、可解释的辅助，但不强加工作流。",
  "专业辅助把先定基线作为第一阶段：必须先确认画面比例、画风和目标时长，并锁定已确认设定。三项未齐或尚未锁定时只帮助补齐或澄清基线，executionMode 必须为 none、actions 必须为空数组、proposal 必须为 null，不得推进后续创作方案或画布操作；三项齐全并锁定后再按清晰的专业阶段主动推进。",
  "旧版请求中的“先定基线”模式与专业辅助同义，必须遵守相同的基线优先规则。",
  "基础设定被锁定时，除非用户在当前消息明确要求修改，否则把比例、画风和时长当作连续性约束。",
  "若信息不足，明确说明缺什么，并给出一个可执行的下一步问题或建议。",
  "回复使用简洁中文，优先可操作建议，避免空泛营销腔。",
].join("\n");

const NO_TOOL_OUTPUT_RULE = [
  "响应必须是一个 JSON 对象，且只有 content、executionMode、proposal、actions 四个字段。不要使用 Markdown 代码围栏。",
  "不要只输出 actions 数组，也不要只输出单个动作对象：外层必须是包含 content 的完整对象。",
  "单个动作的 body/text 控制在 400 字以内；镜头或节点很多时本轮先给出能完整输出的若干个并说明可以继续，不要为了塞下全部内容把 JSON 截断。",
].join("\n");

const TOOL_OUTPUT_RULE = [
  "响应必须是一个 JSON 对象，字段只有 content、executionMode、proposal、actions、toolCalls。不要使用 Markdown 代码围栏。",
  "不要只输出 actions 数组，也不要只输出单个动作对象：外层必须是包含 content 的完整对象。",
  '本轮有可用的本机工具时，用 toolCalls 表达调用：toolCalls 是最多两项的数组，每项形如 {"name":"工具名","arguments":{...}}。',
  "有 toolCalls 时 executionMode 必须为 none、actions 必须为空数组；运行时执行后会再把结果发给你，你才给出最终回复。",
  "不要臆造工具名或参数；工具失败时如实说明失败原因，不要假装已经完成。",
  "单个动作的 body/text 控制在 400 字以内，避免 JSON 被输出上限截断。",
].join("\n");

function systemPrompt(hasTools: boolean) {
  return [...SYSTEM_PROMPT_BASE, hasTools ? TOOL_OUTPUT_RULE : NO_TOOL_OUTPUT_RULE].join("\n");
}

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export function buildChatMessages(
  messages: readonly AgentMessage[],
  canvasContext: AgentCanvasContext,
  knowledgeContext = "",
  toolCatalog = "",
): ChatMessage[] {
  const hasTools = Boolean(toolCatalog.trim());
  return [
    { role: "system", content: systemPrompt(hasTools) },
    { role: "system", content: formatCanvasContext(canvasContext) },
    ...(hasTools ? [{ role: "system" as const, content: toolCatalog.trim().slice(0, 8_000) }] : []),
    ...(knowledgeContext.trim()
      ? [
          {
            role: "system" as const,
            content: `本轮相关创作知识（仅隐性应用，不要逐条复述或暴露来源）：\n${knowledgeContext.trim().slice(0, 12_000)}`,
          },
        ]
      : []),
    ...messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  ];
}

export function formatCanvasContext(context: AgentCanvasContext) {
  const selected = context.nodes.filter((node) => node.selected);
  const guidance = normalizeAgentCreativeGuidance(
    context.creativeGuidance ?? defaultCreativeGuidance(),
  );
  const lines = [
    "当前画布摘要（有界、已脱敏）：",
    `上下文修订：${context.contextRevision}`,
    `项目：${context.projectName} (${context.projectId})`,
    `节点 ${context.nodeCount}（摘要 ${context.nodes.length}，省略 ${context.omittedNodeCount}）`,
    `连线 ${context.edgeCount}（摘要 ${context.edges.length}，省略 ${context.omittedEdgeCount}）`,
    `组合 ${context.groupCount}（摘要 ${context.groups.length}）`,
    `创作协作：${creativeModeLabel(guidance.mode)}`,
  ];

  const baseline = [
    guidance.baseline.aspectRatio ? `比例=${guidance.baseline.aspectRatio}` : null,
    guidance.baseline.visualStyle ? `画风=${guidance.baseline.visualStyle}` : null,
    guidance.baseline.targetDuration ? `时长=${guidance.baseline.targetDuration}` : null,
  ].filter((value): value is string => Boolean(value));
  if (baseline.length)
    lines.push(
      `基础设定${guidance.baseline.locked ? "（已锁定）" : "（可调整）"}：${baseline.join("；")}`,
    );

  if (guidance.mode === "professional") {
    const baselineStatus = readProfessionalBaselineStatus(guidance);
    lines.push(
      !baselineStatus.ready
        ? `专业辅助阶段：先定基线（待确认：${baselineStatus.missing.join("、")}）。基线三项齐全并锁定前只澄清基线，不推进创作方案或画布操作。`
        : "专业辅助阶段：比例、画风与时长基线已齐并锁定，可按专业阶段推进创作。",
    );
  }

  if (selected.length) {
    lines.push("选中节点：");
    for (const node of selected.slice(0, 20)) lines.push(formatNodeLine(node));
  }

  lines.push("节点摘要：");
  for (const node of context.nodes.slice(0, 40)) lines.push(formatNodeLine(node));

  if (context.edges.length) {
    lines.push("连线摘要：");
    for (const edge of context.edges.slice(0, 40)) lines.push(`- ${edge.source} -> ${edge.target}`);
  }

  if (context.groups.length) {
    lines.push("组合摘要：");
    for (const group of context.groups.slice(0, 20))
      lines.push(`- ${group.name}: ${group.nodeIds.join(", ")}`);
  }

  if (context.directorStage?.shots.length) {
    lines.push(
      `导演台：${context.directorStage.open ? "已打开" : "已保存"}，${context.directorStage.shots.length} 个镜头`,
    );
    for (const shot of context.directorStage.shots) {
      lines.push(`- 镜头 ${shot.shotId}: ${truncate(shot.title, 120)}`);
      for (const entity of shot.entities) {
        lines.push(
          `  - ${entity.kind} ${entity.id} (${entity.label}) x=${entity.x} y=${entity.y} z=${entity.z} rotationY=${entity.rotationY} scale=${entity.scale}`,
        );
      }
    }
  }

  return lines.join("\n");
}

function formatNodeLine(node: AgentCanvasContext["nodes"][number]) {
  const media = node.media ? ` media=${node.media.kind}/${node.media.mimeType}` : "";
  const selected = node.selected ? " [selected]" : "";
  const text = node.text.trim() ? ` text=${truncate(node.text.trim(), 240)}` : "";
  return `- ${node.id} (${node.kind})${selected}${media}${text}`;
}

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function defaultCreativeGuidance(): AgentCreativeGuidance {
  return {
    mode: DEFAULT_AGENT_CREATIVE_GUIDANCE.mode,
    baseline: { ...DEFAULT_AGENT_CREATIVE_GUIDANCE.baseline },
  };
}

function creativeModeLabel(mode: AgentCreativeGuidance["mode"]) {
  if (mode === "professional" || mode === "baseline") return "专业辅助";
  return "自由协作";
}
