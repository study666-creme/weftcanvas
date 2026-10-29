import { agentSkillLimits, parseAgentSkillMarkdown } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import { curatedSkills, curatedSkillUrl } from "./curated-skills";

describe("curated skills", () => {
  it("ships six unique MIT skills with a pinned upstream commit", () => {
    expect(curatedSkills).toHaveLength(6);
    expect(new Set(curatedSkills.map((skill) => skill.id)).size).toBe(6);
    expect(new Set(curatedSkills.map((skill) => skill.name)).size).toBe(6);

    for (const skill of curatedSkills) {
      expect(skill.license).toBe("MIT");
      expect(skill.repo).toMatch(/^[\w.-]+\/[\w.-]+$/);
      expect(skill.path.endsWith("SKILL.md")).toBe(true);
      expect(skill.commit).toMatch(/^[0-9a-f]{40}$/);
      expect(curatedSkillUrl(skill)).toBe(
        `https://github.com/${skill.repo}/commit/${skill.commit}`,
      );
    }
  });

  it("keeps every entry importable under the library limits", () => {
    for (const skill of curatedSkills) {
      expect(skill.content.length).toBeLessThanOrEqual(agentSkillLimits.contentChars);

      const parsed = parseAgentSkillMarkdown(skill.content);
      expect(parsed.name).toBe(skill.name);
      expect(parsed.description.length).toBeGreaterThan(0);
      expect(parsed.description.length).toBeLessThanOrEqual(agentSkillLimits.descriptionChars);
      expect(parsed.body.trim().length).toBeGreaterThan(0);
      expect(skill.description).toBe(parsed.description);
    }
  });

  it("carries no executable markup", () => {
    for (const skill of curatedSkills) {
      expect(skill.content).not.toMatch(/<script/i);
      expect(skill.content).not.toMatch(/<iframe/i);
    }
  });
});
