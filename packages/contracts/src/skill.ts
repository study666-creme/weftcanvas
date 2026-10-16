import { z } from "zod";

/**
 * 技能（Agent Skills）：一份带 YAML frontmatter 的 Markdown 工作流说明。
 *
 * 我们这里只做"用户自己导入"这一条路径——不内置任何第三方技能、不做市场、
 * 不做 GitHub 同步：技能正文会进模型上下文，来源不明的技能等于把提示注入权交
 * 出去（公开生态实测有 13% 的已发布技能含严重问题）。因此导入是显式动作，
 * 只收单文件 `SKILL.md`（可粘贴或选文件），不接受压缩包与脚本。
 *
 * 字段约束对齐公开规范：name ≤64 字符、description ≤1024 字符、正文 ≤100KB。
 */
export const agentSkillLimits = {
  nameChars: 64,
  descriptionChars: 1024,
  contentChars: 100_000,
  /** 每轮最多启用几个技能：正文是直接进上下文的，多了只会挤掉画布与对话。 */
  enabledPerRun: 4,
  /** 一轮里所有技能正文的合计上限（字符），超出部分由服务端截断并记警告。 */
  promptCharsPerRun: 16_000,
} as const;

export const agentSkillSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(agentSkillLimits.nameChars),
  description: z.string().max(agentSkillLimits.descriptionChars).default(""),
  /** 正文（去掉 frontmatter 之后的 Markdown）。 */
  body: z.string().max(agentSkillLimits.contentChars),
  /** 原文长度与内容哈希，用于判断导入后有没有被改过。 */
  size: z.number().int().nonnegative(),
  hash: z.string().min(1).max(64),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type AgentSkill = z.infer<typeof agentSkillSchema>;

/** 列表不带正文：抽屉里显示清单就够，正文只在真正运行时才需要。 */
export const agentSkillSummarySchema = agentSkillSchema.omit({ body: true });
export type AgentSkillSummary = z.infer<typeof agentSkillSummarySchema>;

/**
 * 传给 Agent 运行时的一条启用技能：正文已经在服务端按上限裁剪过，
 * 运行时只负责注入，不再做权限判断（判断在 API 侧完成）。
 */
export const agentSkillRunContextSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(agentSkillLimits.nameChars),
  description: z.string().max(agentSkillLimits.descriptionChars).default(""),
  body: z.string().min(1).max(agentSkillLimits.contentChars),
});
export type AgentSkillRunContext = z.infer<typeof agentSkillRunContextSchema>;

export const agentSkillImportRequestSchema = z
  .object({
    content: z
      .string()
      .min(1)
      .max(agentSkillLimits.contentChars + 8_000),
  })
  .strict();
export type AgentSkillImportRequest = z.infer<typeof agentSkillImportRequestSchema>;

export const agentSkillListResponseSchema = z.object({
  ok: z.literal(true),
  data: z.array(agentSkillSummarySchema),
});

export const agentSkillResponseSchema = z.object({
  ok: z.literal(true),
  data: agentSkillSummarySchema,
});

export const agentSkillDeleteResponseSchema = z.object({
  ok: z.literal(true),
  data: z.object({ id: z.string().uuid(), deleted: z.literal(true) }),
});

export type AgentSkillListResponse = z.infer<typeof agentSkillListResponseSchema>;
export type AgentSkillResponse = z.infer<typeof agentSkillResponseSchema>;
export type AgentSkillDeleteResponse = z.infer<typeof agentSkillDeleteResponseSchema>;

export type ParsedAgentSkill = {
  name: string;
  description: string;
  body: string;
};

/**
 * 解析 `SKILL.md`：只认识顶层 `name` / `description` 两个键（公开规范里可移植的
 * 就是这两个），其余 frontmatter 原样忽略——我们不做完整 YAML 解析，免得在导入
 * 路径上引入解析器攻击面。缺字段时按公开实现的兜底：取第一个 `# 标题` 当名字、
 * 第一段正文当描述，实在没有就给一个明确的名字，而不是拒绝导入。
 */
export function parseAgentSkillMarkdown(content: string): ParsedAgentSkill {
  const text = content.replace(/\r\n?/g, "\n").trim();
  if (!text) throw new Error("技能内容为空");

  let frontmatter = "";
  let body = text;
  const matched = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (matched) {
    frontmatter = matched[1] ?? "";
    body = text.slice(matched[0].length);
  }

  const fields = new Map<string, string>();
  for (const line of frontmatter.split("\n")) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!field) continue;
    fields.set(field[1]!.toLowerCase(), stripQuotes(field[2] ?? ""));
  }

  const heading = /^#\s+(.+)$/m.exec(body)?.[1] ?? "";
  const paragraph =
    body
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find((block) => block && !block.startsWith("#")) ?? "";
  const name = clip(fields.get("name") || heading || "未命名技能", agentSkillLimits.nameChars);
  const description = clip(
    fields.get("description") || paragraph.replace(/\s+/g, " "),
    agentSkillLimits.descriptionChars,
  );
  return { name, description, body: body.trim().slice(0, agentSkillLimits.contentChars) };
}

/** 导入前的前置校验：正文本身不能是空的，名字与描述必须是解析出来的真实内容。 */
export function assertImportableAgentSkill(parsed: ParsedAgentSkill) {
  if (!parsed.body.trim()) throw new Error("技能正文为空，请确认导入的是 SKILL.md 内容");
  return parsed;
}

function stripQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }
  return trimmed;
}

function clip(value: string, max: number) {
  const trimmed = value.trim();
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}
