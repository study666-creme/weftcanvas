import { createId } from "@kachang/canvas-core";
import { canvasProjectSchema, type CanvasProject } from "@kachang/contracts";

import {
  ACTIVE_PROJECT_STORAGE_KEY,
  PROJECT_LIBRARY_INDEX_KEY,
  readProjectSummaryIndex,
  type ProjectSummary,
} from "./project-summary-storage";

export { ACTIVE_PROJECT_STORAGE_KEY, PROJECT_LIBRARY_INDEX_KEY } from "./project-summary-storage";
export type { ProjectSummary } from "./project-summary-storage";

export const LEGACY_PROJECT_STORAGE_KEY = "kachang-canvas:project:v1";
const PROJECT_KEY_PREFIX = "kachang-canvas:project-data:v1:";

/**
 * Imported project files are bounded before parsing. Ordinary authored
 * projects stay far below this ceiling, and the guard keeps oversized or
 * malformed payloads from being fully parsed or written into the library.
 */
export const PROJECT_IMPORT_MAX_BYTES = 4 * 1024 * 1024;

export type ProjectImportOutcome =
  | { ok: true; project: CanvasProject }
  | { ok: false; reason: "too-large" | "parse" | "invalid" };

export function parseProjectImportText(text: string, maxBytes = PROJECT_IMPORT_MAX_BYTES): ProjectImportOutcome {
  if (typeof text !== "string" || text.length > maxBytes) return { ok: false, reason: "too-large" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "parse" };
  }
  const parsed = canvasProjectSchema.safeParse(value);
  if (!parsed.success) return { ok: false, reason: "invalid" };
  return { ok: true, project: parsed.data };
}

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">;

export function loadProjectLibrary(storage: StorageLike = localStorage) {
  let projects = readIndexedProjects(storage);
  if (!projects.length) {
    const legacy = parseProject(storage.getItem(LEGACY_PROJECT_STORAGE_KEY));
    if (legacy) {
      writeProject(legacy, storage, true);
      storage.removeItem(LEGACY_PROJECT_STORAGE_KEY);
      projects = [legacy];
    }
  }
  const summaries = sortSummaries(projects.map(projectSummary));
  persistIndex(storage, summaries);
  const requestedActiveId = storage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  const activeProject = projects.find((project) => project.id === requestedActiveId)
    ?? projects.find((project) => project.id === summaries[0]?.id)
    ?? null;
  if (activeProject) storage.setItem(ACTIVE_PROJECT_STORAGE_KEY, activeProject.id);
  return { projects: summaries, activeProject };
}

export function readProject(projectId: string, storage: StorageLike = localStorage) {
  return parseProject(storage.getItem(projectStorageKey(projectId)));
}

export function readAllProjects(storage: StorageLike = localStorage) {
  return readIndexedProjects(storage);
}

export function writeProject(project: CanvasProject, storage: StorageLike = localStorage, makeActive = true) {
  storage.setItem(projectStorageKey(project.id), JSON.stringify(project));
  const summaries = readProjectSummaryIndex(storage).filter((item) => item.id !== project.id);
  persistIndex(storage, sortSummaries([...summaries, projectSummary(project)]));
  if (makeActive) storage.setItem(ACTIVE_PROJECT_STORAGE_KEY, project.id);
  return project;
}

export function removeProject(projectId: string, storage: StorageLike = localStorage) {
  storage.removeItem(projectStorageKey(projectId));
  const next = readProjectSummaryIndex(storage).filter((item) => item.id !== projectId);
  persistIndex(storage, next);
  if (storage.getItem(ACTIVE_PROJECT_STORAGE_KEY) === projectId) storage.removeItem(ACTIVE_PROJECT_STORAGE_KEY);
  return next;
}

export function setActiveProject(projectId: string, storage: StorageLike = localStorage) {
  if (!readProject(projectId, storage)) return false;
  storage.setItem(ACTIVE_PROJECT_STORAGE_KEY, projectId);
  return true;
}

export function collectLocalMediaIds(projects: CanvasProject[]) {
  const ids = new Set<string>();
  projects.forEach((project) => {
    project.nodes.forEach((node) => {
      const media = node.data.media;
      if (media?.source === "local") ids.add(media.id);
    });
  });
  return ids;
}

export function collectProjectMediaIds(projects: CanvasProject[]) {
  const ids = new Set<string>();
  projects.forEach((project) => {
    project.nodes.forEach((node) => {
      if (node.data.media) ids.add(node.data.media.id);
    });
  });
  return ids;
}

export function duplicateProjectSnapshot(project: CanvasProject, name: string, now = Date.now()): CanvasProject {
  const nodeIds = new Map(project.nodes.map((node) => [node.id, createId("node")]));
  return canvasProjectSchema.parse({
    ...structuredClone(project),
    id: createId("project"),
    name,
    nodes: project.nodes.map((node) => ({
      ...structuredClone(node),
      id: nodeIds.get(node.id)!,
      selected: false,
      data: {
        ...structuredClone(node.data),
        status: node.data.media ? "success" : "idle",
        progress: null,
        generation: {
          ...structuredClone(node.data.generation),
          referenceNodeIds: node.data.generation.referenceNodeIds.flatMap((id) => nodeIds.get(id) ?? []),
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: null,
        },
        createdAt: now,
        updatedAt: now,
      },
    })),
    edges: project.edges.flatMap((edge) => {
      const source = nodeIds.get(edge.source);
      const target = nodeIds.get(edge.target);
      return source && target ? [{ ...structuredClone(edge), id: createId("edge"), source, target, selected: false }] : [];
    }),
    groups: project.groups.flatMap((group) => {
      const groupNodeIds = group.nodeIds.flatMap((id) => nodeIds.get(id) ?? []);
      return groupNodeIds.length >= 2 ? [{
        ...structuredClone(group),
        id: createId("group"),
        nodeIds: groupNodeIds,
        createdAt: now,
        updatedAt: now,
      }] : [];
    }),
    createdAt: now,
    updatedAt: now,
  });
}

export function uniqueProjectName(base: string, projects: ProjectSummary[]) {
  const normalized = base.trim().slice(0, 64) || "未命名画布";
  const names = new Set(projects.map((project) => project.name));
  if (!names.has(normalized)) return normalized;
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = ` ${index}`;
    const candidate = `${normalized.slice(0, 64 - suffix.length)}${suffix}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${normalized.slice(0, 48)} ${Date.now()}`;
}

function readIndexedProjects(storage: StorageLike) {
  const ids = new Set(readProjectSummaryIndex(storage).map((item) => item.id));
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(PROJECT_KEY_PREFIX)) ids.add(decodeURIComponent(key.slice(PROJECT_KEY_PREFIX.length)));
  }
  return [...ids].flatMap((id) => {
    const project = readProject(id, storage);
    return project ? [project] : [];
  });
}

function persistIndex(storage: StorageLike, projects: ProjectSummary[]) {
  storage.setItem(PROJECT_LIBRARY_INDEX_KEY, JSON.stringify({ version: 1, projects: sortSummaries(projects) }));
}

function parseProject(raw: string | null) {
  if (!raw) return null;
  try {
    return canvasProjectSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function projectSummary(project: CanvasProject): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    nodeCount: project.nodes.length,
  };
}

function sortSummaries(projects: ProjectSummary[]) {
  return [...projects].sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt || left.name.localeCompare(right.name, "zh-CN"));
}

function projectStorageKey(projectId: string) {
  return `${PROJECT_KEY_PREFIX}${encodeURIComponent(projectId)}`;
}
