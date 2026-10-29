import { parseAgentSkillMarkdown } from "@weftcanvas/contracts";

import brandVoice from "../content/curated-skills/brand-voice/SKILL.md?raw";
import handDrawnVideo from "../content/curated-skills/hand-drawn-video/SKILL.md?raw";
import humanizer from "../content/curated-skills/humanizer/SKILL.md?raw";
import imagePrompts from "../content/curated-skills/image-prompts/SKILL.md?raw";
import uxWriting from "../content/curated-skills/ux-writing/SKILL.md?raw";
import visualDesignFoundations from "../content/curated-skills/visual-design-foundations/SKILL.md?raw";

/**
 * 随产品分发的精选技能：MIT 许可、单文件、无脚本，来源与哈希记在
 * `content/curated-skills/ATTRIBUTION.md`。
 *
 * 这里只是"可供导入"的内容，不是内置技能：用户点「添加」才走现有
 * `POST /api/v1/agent/skills` 存进自己的技能库，并且仍要手动勾选才会进入某一轮
 * 对话。正文会直接进模型上下文，所以内容固定随版本发布，不从网络拉取。
 */
export type CuratedSkill = {
  id: string;
  /** 解析出的技能名（导入后技能库里显示的就是它）。 */
  name: string;
  description: string;
  content: string;
  repo: string;
  path: string;
  commit: string;
  license: "MIT";
};

const seeds: Omit<CuratedSkill, "name" | "description">[] = [
  {
    id: "humanizer",
    content: humanizer,
    repo: "blader/humanizer",
    path: "SKILL.md",
    commit: "8c307f367c91bd974002f10f2be2965d642c13df",
    license: "MIT",
  },
  {
    id: "image-prompts",
    content: imagePrompts,
    repo: "coreyhaines31/marketingskills",
    path: "skills/image/SKILL.md",
    commit: "17772c7a80b7b8c7a47af30f648374cd8bd8adc5",
    license: "MIT",
  },
  {
    id: "brand-voice",
    content: brandVoice,
    repo: "arnabbagxd/Brand-building-skills",
    path: "skills/brand-voice/SKILL.md",
    commit: "4a0a8b5b7a0f64bf0fc551978a18a591670a5223",
    license: "MIT",
  },
  {
    id: "hand-drawn-video",
    content: handDrawnVideo,
    repo: "kaomei/hand-drawn-video-prompts",
    path: "hand-drawn-video-prompts/SKILL.md",
    commit: "72e64cd8962f107360bdca23010af78f65b4e8f5",
    license: "MIT",
  },
  {
    id: "ux-writing",
    content: uxWriting,
    repo: "content-designer/ux-writing-skill",
    path: "SKILL.md",
    commit: "98cacde4ba2dd10ed28df43a8d53eef1e321c539",
    license: "MIT",
  },
  {
    id: "visual-design-foundations",
    content: visualDesignFoundations,
    repo: "wshobson/agents",
    path: "plugins/ui-design/skills/visual-design-foundations/SKILL.md",
    commit: "0874a27b17a22e2b7c2e2bcd725768e0803cad06",
    license: "MIT",
  },
];

export const curatedSkills: CuratedSkill[] = seeds.map((seed) => {
  const parsed = parseAgentSkillMarkdown(seed.content);
  return { ...seed, name: parsed.name, description: parsed.description };
});

export function curatedSkillUrl(skill: CuratedSkill) {
  return `https://github.com/${skill.repo}/commit/${skill.commit}`;
}
