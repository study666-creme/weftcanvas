import { describe, expect, it } from "vitest";

import {
  agentSkillImportRequestSchema,
  agentSkillLimits,
  agentSkillSummarySchema,
  assertImportableAgentSkill,
  parseAgentSkillMarkdown,
} from "./skill.js";

describe("技能解析（SKILL.md）", () => {
  it("读 frontmatter 的 name / description，正文去掉 frontmatter", () => {
    const parsed = parseAgentSkillMarkdown(
      [
        "---",
        'name: "分镜脚本编写"',
        "description: >-",
        "  把一段故事拆成可拍的分镜。",
        "---",
        "",
        "# 分镜脚本编写",
        "",
        "1. 先确定每场的功能。",
      ].join("\n"),
    );
    expect(parsed.name).toBe("分镜脚本编写");
    expect(parsed.body.startsWith("# 分镜脚本编写")).toBe(true);
    expect(parsed.body).not.toContain("---");
  });

  it("缺 frontmatter 时用一级标题当名字、首段当描述", () => {
    const parsed = parseAgentSkillMarkdown("# 角色设定\n\n先写动机，再写外形。\n\n第二步……\n");
    expect(parsed.name).toBe("角色设定");
    expect(parsed.description).toBe("先写动机，再写外形。");
    expect(parsed.body).toContain("第二步");
  });

  it("引号、多余空白与 CRLF 都能处理", () => {
    const parsed = parseAgentSkillMarkdown(
      "---\r\nname: '短片节奏'\r\ndescription: \"  三幕结构  \"\r\n---\r\n正文\r\n",
    );
    expect(parsed.name).toBe("短片节奏");
    expect(parsed.description).toBe("三幕结构");
    expect(parsed.body).toBe("正文");
  });

  it("超长名字与描述按契约上限截断，正文超长也截断", () => {
    const long = "字".repeat(agentSkillLimits.descriptionChars + 50);
    const parsed = parseAgentSkillMarkdown(`# ${"名".repeat(80)}\n\n${long}\n`);
    expect(parsed.name.length).toBe(agentSkillLimits.nameChars);
    expect(parsed.description.length).toBe(agentSkillLimits.descriptionChars);
    const huge = parseAgentSkillMarkdown(
      `# 标题\n\n${"文".repeat(agentSkillLimits.contentChars + 10)}`,
    );
    expect(huge.body.length).toBe(agentSkillLimits.contentChars);
  });

  it("空内容与空正文分别拒绝，并给出可读原因", () => {
    expect(() => parseAgentSkillMarkdown("   \n  ")).toThrowError("技能内容为空");
    const onlyFrontmatter = parseAgentSkillMarkdown("---\nname: 只有元数据\n---\n");
    expect(onlyFrontmatter.name).toBe("只有元数据");
    expect(() => assertImportableAgentSkill(onlyFrontmatter)).toThrowError("技能正文为空");
  });

  it("导入请求体与列表摘要的形状", () => {
    expect(agentSkillImportRequestSchema.safeParse({ content: "# 标题\n\n正文" }).success).toBe(
      true,
    );
    expect(agentSkillImportRequestSchema.safeParse({ content: "" }).success).toBe(false);
    expect(agentSkillImportRequestSchema.safeParse({ content: "x", extra: 1 }).success).toBe(false);
    const summary = agentSkillSummarySchema.parse({
      id: "11111111-1111-4111-8111-111111111111",
      name: "分镜",
      body: "不该出现在摘要里".repeat(1),
      size: 10,
      hash: "abc",
      createdAt: "2026-10-16T12:00:00.000Z",
      updatedAt: "2026-10-16T12:00:00.000Z",
    });
    expect(summary.description).toBe("");
    expect("body" in summary).toBe(false);
  });
});
