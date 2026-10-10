import {
  DEFAULT_AGENT_CREATIVE_GUIDANCE,
  agentCreativeGuidanceSchema,
  type AgentCreativeGuidance,
} from "@kachang/contracts";

const STORAGE_PREFIX = "kachang-canvas:agent-creative-guidance:v1:";

export function readAgentCreativeGuidance(projectId: string): AgentCreativeGuidance {
  if (typeof localStorage === "undefined" || !projectId) return defaultGuidance();
  try {
    const raw = localStorage.getItem(storageKey(projectId));
    if (!raw) return defaultGuidance();
    const parsed = agentCreativeGuidanceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return defaultGuidance();
    const guidance = normalizeAgentCreativeGuidance(parsed.data);
    if (guidance.mode !== parsed.data.mode) {
      localStorage.setItem(storageKey(projectId), JSON.stringify(guidance));
    }
    return guidance;
  } catch {
    return defaultGuidance();
  }
}

export function writeAgentCreativeGuidance(projectId: string, value: AgentCreativeGuidance): AgentCreativeGuidance {
  const parsed = agentCreativeGuidanceSchema.safeParse(value);
  const guidance = parsed.success ? normalizeAgentCreativeGuidance(parsed.data) : defaultGuidance();
  if (typeof localStorage === "undefined" || !projectId) return guidance;
  try {
    localStorage.setItem(storageKey(projectId), JSON.stringify(guidance));
  } catch {
    // The active request still receives the valid in-memory value when storage is unavailable.
  }
  return guidance;
}

export function normalizeAgentCreativeGuidance(value: AgentCreativeGuidance): AgentCreativeGuidance {
  if (value.mode !== "baseline") return value;
  return { ...value, mode: "professional" };
}

export function readProfessionalBaselineStatus(value: AgentCreativeGuidance) {
  const guidance = normalizeAgentCreativeGuidance(value);
  if (guidance.mode !== "professional") return { required: false, ready: true, missing: [] as string[] };
  const missing = [
    guidance.baseline.aspectRatio?.trim() ? null : "画面比例",
    guidance.baseline.visualStyle?.trim() ? null : "画风",
    guidance.baseline.targetDuration?.trim() ? null : "目标时长",
    guidance.baseline.locked ? null : "确认并锁定基线",
  ].filter((item): item is string => Boolean(item));
  return { required: true, ready: missing.length === 0, missing };
}

function storageKey(projectId: string) {
  return `${STORAGE_PREFIX}${projectId}`;
}

function defaultGuidance(): AgentCreativeGuidance {
  return {
    mode: DEFAULT_AGENT_CREATIVE_GUIDANCE.mode,
    baseline: { ...DEFAULT_AGENT_CREATIVE_GUIDANCE.baseline },
  };
}
