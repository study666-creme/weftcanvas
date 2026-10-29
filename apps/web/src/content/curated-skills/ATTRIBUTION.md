# 精选技能：来源与许可

本目录收录 6 份第三方 Agent Skills，全部为 MIT 许可、单文件、无脚本。它们**不会**
自动注入任何一次 Agent 运行：用户在「技能」页点「添加」时才通过现有
`POST /api/v1/agent/skills` 显式导入到自己的技能库，之后仍需手动勾选才会进入某一轮
对话。这与 `AGENTS.md` 的「技能只做用户自己导入」是同一条路径，只是把内容随产品
一起分发，避免用户去公开生态里复制来源不明的技能。

## 变更说明

- 正文（frontmatter 之后的 Markdown）与上游**逐字节一致**。
- 仅把 frontmatter 的 `name` / `description` 本地化为中文，使技能库列表可读；其余
  frontmatter 字段保持不变。
- 未收录任何 `scripts/`、`references/`、`assets/` 或压缩包。正文里仍可能提到上游的
  `references/...`（属于该技能的补充阅读），这些文件不随本包分发，技能的核心步骤
  在单文件内自足。
- 上游许可证全文见 [`licenses/`](./licenses/)。

## 清单

| 本地目录                     | 技能名         | 上游仓库                            | 上游路径                                                      | 许可 |
| ---------------------------- | -------------- | ----------------------------------- | ------------------------------------------------------------- | ---- |
| `humanizer/`                 | 文案去 AI 味   | `blader/humanizer`                  | `SKILL.md`                                                    | MIT  |
| `image-prompts/`             | 营销图片提示词 | `coreyhaines31/marketingskills`     | `skills/image/SKILL.md`                                       | MIT  |
| `brand-voice/`               | 品牌口吻       | `arnabbagxd/Brand-building-skills`  | `skills/brand-voice/SKILL.md`                                 | MIT  |
| `hand-drawn-video/`          | 竖屏分镜提示词 | `kaomei/hand-drawn-video-prompts`   | `hand-drawn-video-prompts/SKILL.md`                           | MIT  |
| `ux-writing/`                | 界面文案       | `content-designer/ux-writing-skill` | `SKILL.md`                                                    | MIT  |
| `visual-design-foundations/` | 视觉设计基础   | `wshobson/agents`                   | `plugins/ui-design/skills/visual-design-foundations/SKILL.md` | MIT  |

## 版本与校验

| 本地目录                     | 上游 commit                                | 上游 SKILL.md SHA-256                                              | 本地 SKILL.md SHA-256（仅改 frontmatter 后）                       |
| ---------------------------- | ------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `humanizer/`                 | `8c307f367c91bd974002f10f2be2965d642c13df` | `0612f1dfb1672b0ea9b97e139bf1f06cabe98d8b27424fe8ff01e1fb4cc99cad` | `81630a49304c10659eb27a222cc025f4482ab34c5c094c3aa36c86b81c372c93` |
| `image-prompts/`             | `17772c7a80b7b8c7a47af30f648374cd8bd8adc5` | `a03da6dd4aed940f2fb8df1337a8dbe0f4108b3bef864e996f759fa4d94e2600` | `fb76b84bb4496d16e4e8064254c573e2d4f15984a59d95d7daca38cdfa78b333` |
| `brand-voice/`               | `4a0a8b5b7a0f64bf0fc551978a18a591670a5223` | `3ad0470fd39b34f955b03c36bd40d6926e8f7da76461ff7b0a66a9575446729e` | `1e7bfe6286d0e9b5f93101d9bc516304c6b9d1587d4d9937758a3b730ac67293` |
| `hand-drawn-video/`          | `72e64cd8962f107360bdca23010af78f65b4e8f5` | `b923778cbd9ff006ab937918e1bc06d209da30ef781f682c65561e772b4ad412` | `03e0684550bc0b65810003f46cf8927795e691e5302c7a7e5cae1e002a7197a3` |
| `ux-writing/`                | `98cacde4ba2dd10ed28df43a8d53eef1e321c539` | `67dda2a5ba7e26f69860e1018a37068ca201735ff8ae98199c143138d91b4550` | `840088830c3a3a7b4782e479fde78c0bb709be2227deac5c01be56a0b16d8998` |
| `visual-design-foundations/` | `0874a27b17a22e2b7c2e2bcd725768e0803cad06` | `0c6970d14f5d5df55c63d1be995205d140489e2d0c39896657fabee6f6a5df84` | `a92c6de74c1fff8e1aefebe0f04efc049d872884015b7fde95bca603e2f95f4b` |

## 收录标准

1. 仓库根目录有明确的 MIT 许可，允许商用与再分发，且技能目录没有覆盖许可。
2. 技能是单个 `SKILL.md`，正文在单文件内可独立执行；不随包分发脚本。
3. 正文 ≤ 100,000 字符（`agentSkillLimits.contentChars`），与技能库导入上限一致。
4. 内容与画布创作相关（文案、图片、视频、品牌、界面、视觉），而不是纯软件工程。

## 提醒

`hand-drawn-video-prompts` 与 `image-prompts` 的正文会提到上游的补充阅读
（`references/...`）。本包只发入口文件；如果以后技能库支持多文件技能，再把对应
`references/` 一并收录，并重新核对许可与哈希。
