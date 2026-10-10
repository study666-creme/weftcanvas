export const PROJECT_LIBRARY_INDEX_KEY = "kachang-canvas:projects:v1";
export const ACTIVE_PROJECT_STORAGE_KEY = "kachang-canvas:active-project:v1";

export type ProjectSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
};

type ProjectIndexStorage = Pick<Storage, "getItem">;

export function readProjectSummaryIndex(storage: ProjectIndexStorage = localStorage): ProjectSummary[] {
  try {
    const value = JSON.parse(storage.getItem(PROJECT_LIBRARY_INDEX_KEY) ?? "null") as unknown;
    if (!value || typeof value !== "object" || !("projects" in value) || !Array.isArray(value.projects)) return [];
    return value.projects.flatMap((item) => isProjectSummary(item) ? [item] : []);
  } catch {
    return [];
  }
}

function isProjectSummary(value: unknown): value is ProjectSummary {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string" && item.id.length > 0
    && typeof item.name === "string" && item.name.length > 0
    && typeof item.createdAt === "number" && Number.isFinite(item.createdAt)
    && typeof item.updatedAt === "number" && Number.isFinite(item.updatedAt)
    && typeof item.nodeCount === "number" && Number.isSafeInteger(item.nodeCount) && item.nodeCount >= 0;
}
