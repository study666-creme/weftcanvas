import type { CanvasProject } from "@weftcanvas/contracts";
import { useEffect } from "react";

import type { WeftcanvasNode } from "../types";
import { requestPersistentMediaStorage } from "../lib/media-store";
import { readProject, writeProject } from "../lib/project-library";
import { selectProject, useCanvasStore } from "../state/canvas-store";
import { useCloudProjectStore } from "../state/cloud-project-store";
import { useIdentityStore } from "../state/identity-store";
import { useProjectLibraryStore } from "../state/project-library-store";
import { useToastStore } from "../state/toast-store";

// 顶栏不再常驻保存状态，保存失败改用节流 toast 兜底，避免连续失败刷屏。
const SAVE_FAILURE_TOAST_INTERVAL_MS = 30_000;
let lastSaveFailureToastAt = 0;

function isRunningProgressChange(
  previous: WeftcanvasNode | undefined,
  next: WeftcanvasNode | undefined,
) {
  if (!previous || !next) return false;
  const p = previous.data;
  const n = next.data;
  if (p.status !== "running" || n.status !== "running") return false;
  if (p.media !== n.media || p.body !== n.body) return false;
  if (
    p.progress === n.progress &&
    p.generation.jobStatus === n.generation.jobStatus &&
    p.generation.jobVersion === n.generation.jobVersion
  )
    return false;
  return (
    p.generation.modelId === n.generation.modelId &&
    p.generation.jobId === n.generation.jobId &&
    p.generation.jobCreatedAt === n.generation.jobCreatedAt &&
    p.generation.error === n.generation.error
  );
}

function updateProjectSummary(project: CanvasProject) {
  const summary = {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    nodeCount: project.nodes.length,
  };
  useProjectLibraryStore.setState((state) => ({
    projects: [...state.projects.filter((item) => item.id !== summary.id), summary].sort(
      (left, right) =>
        right.updatedAt - left.updatedAt ||
        right.createdAt - left.createdAt ||
        left.name.localeCompare(right.name, "zh-CN"),
    ),
  }));
}

export function useProjectPersistence() {
  useEffect(() => {
    void requestPersistentMediaStorage();
    let delayTimer = 0;
    let idleHandle: number | null = null;
    let dirty = false;

    const cancelIdleFlush = () => {
      if (idleHandle === null) return;
      window.cancelIdleCallback?.(idleHandle);
      idleHandle = null;
    };
    const flush = () => {
      window.clearTimeout(delayTimer);
      cancelIdleFlush();
      if (!dirty) return;
      dirty = false;
      const project = selectProject(useCanvasStore.getState());
      try {
        // writeProject 内部会做 schema 校验和一次持久化序列化；这里不再为去重额外序列化整张画布。
        const stored = writeProject(project);
        updateProjectSummary(stored);
        useCanvasStore.getState().setSaveState("saved", Date.now());
        const identity = useIdentityStore.getState();
        const ownerId = identity.status === "authenticated" ? identity.session?.user.id : null;
        // 登录即全自动：未开通云项目的首次编辑在此静默开通，已开通的直接排队
        // 同步；local-only（配额满）时内部自行跳过。
        if (ownerId) useCloudProjectStore.getState().ensureAutoSync(ownerId, stored);
      } catch {
        useCanvasStore.getState().setSaveState("error");
        const now = Date.now();
        if (now - lastSaveFailureToastAt >= SAVE_FAILURE_TOAST_INTERVAL_MS) {
          lastSaveFailureToastAt = now;
          useToastStore.getState().show("项目自动保存失败，请检查浏览器存储空间", "error");
        }
      }
    };
    const scheduleIdleFlush = () => {
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(
          () => {
            idleHandle = null;
            flush();
          },
          { timeout: 640 },
        );
        return;
      }
      delayTimer = window.setTimeout(flush, 0);
    };
    const schedule = (markSaving = true, delay = 420) => {
      dirty = true;
      window.clearTimeout(delayTimer);
      cancelIdleFlush();
      delayTimer = window.setTimeout(scheduleIdleFlush, delay);
      if (markSaving && useCanvasStore.getState().saveState !== "saving") {
        useCanvasStore.getState().setSaveState("saving");
      }
    };
    const flushWhenHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const unsubscribe = useCanvasStore.subscribe((state, previous) => {
      const progressOnly =
        state.nodes !== previous.nodes &&
        state.edges === previous.edges &&
        state.groups === previous.groups &&
        state.viewport === previous.viewport &&
        state.projectName === previous.projectName &&
        state.projectId === previous.projectId &&
        state.nodes.length === previous.nodes.length &&
        state.nodes.every(
          (node, index) =>
            node === previous.nodes[index] || isRunningProgressChange(previous.nodes[index], node),
        );
      if (progressOnly) return;
      const projectChanged =
        state.nodes !== previous.nodes ||
        state.edges !== previous.edges ||
        state.groups !== previous.groups ||
        state.viewport !== previous.viewport ||
        state.projectName !== previous.projectName ||
        state.projectId !== previous.projectId;
      if (projectChanged) schedule();
    });
    // A freshly created project has no durable record yet (first-run empty
    // canvas, never-edited graph). Write it once while the browser is idle so
    // a reload keeps the same project identity. Already-persisted projects
    // (the common dense-project path) skip the initial serialization entirely.
    if (readProject(selectProject(useCanvasStore.getState()).id) === null) {
      schedule(false, 0);
    }
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      unsubscribe();
      flush();
      window.clearTimeout(delayTimer);
      cancelIdleFlush();
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flushWhenHidden);
    };
  }, []);
}
