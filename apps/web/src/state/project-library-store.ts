import { canvasProjectSchema, type CanvasProject } from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  duplicateProjectSnapshot,
  loadProjectLibrary,
  readProject,
  removeProject,
  setActiveProject,
  uniqueProjectName,
  writeProject,
  type ProjectSummary,
} from "../lib/project-library";
import { selectProject, useCanvasStore } from "./canvas-store";
import { useToastStore } from "./toast-store";

type ProjectLibraryState = {
  open: boolean;
  query: string;
  projects: ProjectSummary[];
  setOpen: (open: boolean) => void;
  toggle: () => void;
  setQuery: (query: string) => void;
  refresh: () => void;
  persistCurrent: () => CanvasProject | null;
  createProject: () => void;
  switchProject: (projectId: string) => void;
  renameProject: (projectId: string, name: string) => boolean;
  duplicateProject: (projectId: string) => void;
  deleteProject: (projectId: string) => void;
  importProject: (project: CanvasProject) => void;
};

export const useProjectLibraryStore = create<ProjectLibraryState>((set, get) => ({
  open: false,
  query: "",
  projects: initialProjects(),
  setOpen: (open) => set({ open, ...(open ? {} : { query: "" }) }),
  toggle: () => set((state) => ({ open: !state.open, ...(!state.open ? {} : { query: "" }) })),
  setQuery: (query) => set({ query }),
  refresh: () => set({ projects: loadSummaries() }),

  persistCurrent: () => {
    try {
      const project = selectProject(useCanvasStore.getState());
      writeProject(project);
      set({ projects: loadSummaries() });
      return project;
    } catch {
      useCanvasStore.getState().setSaveState("error");
      useToastStore.getState().show("项目保存失败，请检查浏览器存储空间", "error");
      return null;
    }
  },

  createProject: () => {
    if (!get().persistCurrent()) return;
    const name = nextCanvasName(get().projects);
    const canvas = useCanvasStore.getState();
    canvas.resetProject(name);
    try {
      writeProject(selectProject(useCanvasStore.getState()));
      set({ projects: loadSummaries(), open: false, query: "" });
      useToastStore.getState().show("新画布已创建", "success");
    } catch {
      canvas.setSaveState("error");
      useToastStore.getState().show("新画布无法保存", "error");
    }
  },

  switchProject: (projectId) => {
    const canvas = useCanvasStore.getState();
    if (canvas.projectId === projectId) {
      set({ open: false, query: "" });
      return;
    }
    if (!get().persistCurrent()) return;
    const project = readProject(projectId);
    if (!project || !setActiveProject(projectId)) {
      useToastStore.getState().show("这个项目暂时无法打开", "error");
      get().refresh();
      return;
    }
    canvas.replaceProject(project);
    set({ projects: loadSummaries(), open: false, query: "" });
  },

  renameProject: (projectId, value) => {
    const name = value.trim().slice(0, 64);
    if (!name) return false;
    try {
      const canvas = useCanvasStore.getState();
      if (canvas.projectId === projectId) {
        canvas.setProjectName(name);
        writeProject(selectProject(useCanvasStore.getState()));
      } else {
        const project = readProject(projectId);
        if (!project) return false;
        writeProject({ ...project, name, updatedAt: Date.now() }, undefined, false);
      }
      set({ projects: loadSummaries() });
      return true;
    } catch {
      useToastStore.getState().show("项目名称没有保存", "error");
      return false;
    }
  },

  duplicateProject: (projectId) => {
    if (useCanvasStore.getState().projectId === projectId && !get().persistCurrent()) return;
    const source = readProject(projectId);
    if (!source) {
      useToastStore.getState().show("没有找到要复制的项目", "error");
      return;
    }
    try {
      const name = uniqueProjectName(`${source.name} 副本`, get().projects);
      const duplicate = duplicateProjectSnapshot(source, name);
      writeProject(duplicate);
      useCanvasStore.getState().replaceProject(duplicate);
      set({ projects: loadSummaries(), open: false, query: "" });
      useToastStore.getState().show("项目副本已创建", "success");
    } catch {
      useToastStore.getState().show("项目复制失败", "error");
    }
  },

  deleteProject: (projectId) => {
    try {
      const canvas = useCanvasStore.getState();
      const deletingActive = canvas.projectId === projectId;
      removeProject(projectId);
      let projects = loadSummaries();
      if (deletingActive) {
        const replacement = projects
          .map((summary) => readProject(summary.id))
          .find((project): project is CanvasProject => project !== null);
        if (replacement) {
          setActiveProject(replacement.id);
          canvas.replaceProject(replacement);
        } else {
          canvas.resetProject(nextCanvasName([]));
          writeProject(selectProject(useCanvasStore.getState()));
          projects = loadSummaries();
        }
      }
      set({
        projects,
        open: deletingActive ? false : get().open,
        query: deletingActive ? "" : get().query,
      });
      useToastStore.getState().show("项目已删除", "success");
    } catch {
      useToastStore.getState().show("项目删除失败", "error");
    }
  },

  importProject: (value) => {
    if (!get().persistCurrent()) return;
    const parsed = canvasProjectSchema.safeParse(value);
    if (!parsed.success) {
      useToastStore.getState().show("项目文件无效或版本不兼容", "error");
      return;
    }
    try {
      const source = parsed.data;
      const name = uniqueProjectName(source.name, get().projects);
      const imported = duplicateProjectSnapshot(source, name);
      writeProject(imported);
      useCanvasStore.getState().replaceProject(imported);
      set({ projects: loadSummaries(), open: false, query: "" });
      useToastStore.getState().show("项目已导入", "success");
    } catch {
      useToastStore.getState().show("项目无法保存，请检查浏览器存储空间", "error");
    }
  },
}));

function initialProjects() {
  try {
    return loadProjectLibrary().projects;
  } catch {
    return [];
  }
}

function loadSummaries() {
  return loadProjectLibrary().projects;
}

function nextCanvasName(projects: ProjectSummary[]) {
  const names = new Set(projects.map((project) => project.name));
  for (let index = 1; index < 10_000; index += 1) {
    const candidate = `纬线 ${index}`;
    if (!names.has(candidate)) return candidate;
  }
  return `纬线 ${Date.now()}`;
}
