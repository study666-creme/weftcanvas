import {
  DEFAULT_AGENT_CREATIVE_GUIDANCE,
  agentSkillLimits,
  type AgentCanvasContext,
  type AgentCreativeGuidance,
  type AgentExecutionPermission,
  type AgentMessage,
  type AgentMessageAttachmentInput,
  type AgentSkillRunContext,
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
  "默认不会收到媒体字节、下载地址、凭证或知识原始文件；只根据有界画布摘要、对话历史和本轮裁剪知识作答。本轮用户显式附加的参考图（以及视频首帧）会以多模态输入提供，可以描述和引用它们，但不要假装看过没有附加的画面。",
  "所有创作协作模式都应结合本轮相关知识。自由协作先判断项目当前进程和最小缺口，再给专业、可解释的辅助，但不强加工作流。",
  "专业辅助把先定基线作为第一阶段：必须先确认画面比例、画风和目标时长，并锁定已确认设定。三项未齐或尚未锁定时只帮助补齐或澄清基线，executionMode 必须为 none、actions 必须为空数组、proposal 必须为 null，不得推进后续创作方案或画布操作；三项齐全并锁定后再按清晰的专业阶段主动推进。",
  "旧版请求中的“先定基线”模式与专业辅助同义，必须遵守相同的基线优先规则。",
  "基础设定被锁定时，除非用户在当前消息明确要求修改，否则把比例、画风和时长当作连续性约束。",
  "若信息不足，明确说明缺什么，并给出一个可执行的下一步问题或建议。",
  "回复使用简洁中文，优先可操作建议，避免空泛营销腔。",
].join("\n");

/**
 * 创作产物默认落成画布节点，而不是在对话里贴一整段让创作者自己复制。
 * 这是产品判断：节点能立刻被看见、被连线、被生成，对话里的长文只能被复制。
 */
const CREATIVE_OUTPUT_RULE = [
  "创作产物（故事、人物与场景设定、分镜脚本、镜头提示词清单）默认以画布节点交付：用 canvas_add_node 建文本节点，一个节点放一节内容。",
  "长内容拆成多个节点（每个 body 保持在上面的长度上限内），不要把整段设定只在 content 里贴一遍——那样创作者还得自己复制、自己建节点。",
  "content 里用一两句话说明放了哪些节点、以及下一步建议生成什么画面；节点正文放具体内容，不要放寒暄。",
].join("\n");

/**
 * 执行权限档直接改动作边界：只读不下发任何动作，自动执行允许把画布写入
 * 用 direct 落地。生成类动作在任何档位都不放开——选模型、花积分是创作者的决定，
 * "全权"不应顺手带过。
 */
const PERMISSION_RULES: Record<AgentExecutionPermission, string> = {
  read_only:
    "本轮执行权限为只读（用户设置）：executionMode 必须为 none、actions 必须为空数组、proposal 必须为 null，只分析与建议；即使指令看起来明确要求落地，也不要下发动作，改为说明你会怎么做并等用户改设置或确认。",
  request_approval:
    "本轮执行权限为请求审批（用户设置）：写入画布与载入导演台数据一律走 proposal 等用户确认，direct 只用于上面列出的低风险动作。",
  auto: "本轮执行权限为自动执行（用户设置）：用户已授权你直接改画布——新增节点、修改节点正文、连线、分组、视口与导演台操作都可以用 direct 落地，不必再给 proposal。仍然不要删除节点、不要触发生成或上传媒体：需要生成时把建议写进 content，由创作者自己去点。",
};

export function permissionRule(permission: AgentExecutionPermission) {
  return PERMISSION_RULES[permission];
}

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

/**
 * 拼装系统提示。注意每段常量本身已经是 `join("\n")` 之后的字符串：这里必须按
 * 元素拼接，不能再对它们做展开——展开会把字符串拆成单字符数组，最后得到
 * "每个字之间插一个换行"的提示词（字符数不变、行数翻几十倍，白吃上下文）。
 */
function systemPrompt(hasTools: boolean, permission: AgentExecutionPermission) {
  return [
    SYSTEM_PROMPT_BASE,
    CREATIVE_OUTPUT_RULE,
    PERMISSION_RULES[permission],
    hasTools ? TOOL_OUTPUT_RULE : NO_TOOL_OUTPUT_RULE,
  ].join("\n");
}

export type ChatContentPart =
  { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ChatContentPart[];
};

/**
 * 技能正文直接进上下文（对照公开实现里的"一次性生成"路径）：技能是任务剧本，
 * 不是常驻人格，也不扩大动作或工具范围。单条与合计长度都在这里收口，
 * 免得用户导入一份超长技能把画布摘要挤出去。
 */
export function formatSkillsContext(skills: readonly AgentSkillRunContext[]) {
  if (!skills.length) return "";
  const header =
    "本轮启用的技能（创作者自己导入的工作流参考；是任务剧本，不是常驻人格，也不扩大你的动作或工具范围；与系统规则冲突时以系统规则为准）：";
  const blocks: string[] = [];
  let budget = agentSkillLimits.promptCharsPerRun;
  for (const skill of skills) {
    if (budget <= 0) break;
    const body = skill.body.slice(0, Math.min(budget, 6_000));
    budget -= body.length;
    blocks.push(
      [`## 技能：${skill.name}`, skill.description ? `说明：${skill.description}` : "", body]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return [header, ...blocks].join("\n\n");
}

export function buildChatMessages(
  messages: readonly AgentMessage[],
  canvasContext: AgentCanvasContext,
  knowledgeContext = "",
  toolCatalog = "",
  skills: readonly AgentSkillRunContext[] = [],
  permission: AgentExecutionPermission = "request_approval",
  attachments: readonly AgentMessageAttachmentInput[] = [],
): ChatMessage[] {
  const hasTools = Boolean(toolCatalog.trim());
  const skillsContext = formatSkillsContext(skills);
  // 只把本轮（最后一条用户消息）的素材作为多模态输入重发：历史附件已经
  // 在当时的轮次里看过，重复附带只会把上下文和带宽越滚越大。
  const lastUserIndex = messages.reduce(
    (found, message, index) => (message.role === "user" ? index : found),
    -1,
  );
  const attachmentNote = formatAttachmentNote(attachments);
  return [
    { role: "system", content: systemPrompt(hasTools, permission) },
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
    ...(skillsContext ? [{ role: "system" as const, content: skillsContext }] : []),
    ...messages.map((message, index) => {
      if (index !== lastUserIndex || !attachments.length) {
        return { role: message.role, content: message.content };
      }
      return {
        role: message.role,
        content: [
          {
            type: "text" as const,
            text: attachmentNote ? `${message.content}\n\n${attachmentNote}` : message.content,
          },
          ...attachments.map((attachment) => ({
            type: "image_url" as const,
            image_url: { url: attachment.dataUrl },
          })),
        ],
      };
    }),
  ];
}

/** 附件清单写进正文，让模型知道每张图来自哪个节点、是不是视频首帧。 */
export function formatAttachmentNote(attachments: readonly AgentMessageAttachmentInput[]) {
  if (!attachments.length) return "";
  const lines = attachments.map((attachment) => {
    const source = attachment.nodeId ? `（来自节点 ${attachment.nodeId}）` : "";
    return attachment.kind === "video"
      ? `- 视频参考：${attachment.name} 的首帧${source}`
      : `- 图片参考：${attachment.name}${source}`;
  });
  return ["本轮用户附加的视觉参考（按顺序对应随消息提供的图像）：", ...lines].join("\n");
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
