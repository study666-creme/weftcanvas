import type { AgentCreativeGuidance } from "@weftcanvas/contracts";

export type ProfessionalBaselineStatus = {
  required: boolean;
  ready: boolean;
  missing: string[];
};

export function normalizeAgentCreativeGuidance(
  guidance: AgentCreativeGuidance,
): AgentCreativeGuidance {
  return guidance.mode === "baseline" ? { ...guidance, mode: "professional" } : guidance;
}

export function readProfessionalBaselineStatus(
  guidance: AgentCreativeGuidance | undefined,
): ProfessionalBaselineStatus {
  if (!guidance) return { required: false, ready: true, missing: [] };
  const normalized = normalizeAgentCreativeGuidance(guidance);
  if (normalized.mode !== "professional") return { required: false, ready: true, missing: [] };
  const missing = [
    normalized.baseline.aspectRatio?.trim() ? null : "画面比例",
    normalized.baseline.visualStyle?.trim() ? null : "画风",
    normalized.baseline.targetDuration?.trim() ? null : "目标时长",
    normalized.baseline.locked ? null : "确认并锁定基线",
  ].filter((value): value is string => Boolean(value));
  return { required: true, ready: missing.length === 0, missing };
}
