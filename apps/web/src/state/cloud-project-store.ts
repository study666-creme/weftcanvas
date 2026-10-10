import type {
  CanvasProject,
  CloudProjectSummary,
  CloudProjectUsage,
} from "@kachang/contracts";
import { create } from "zustand";

import {
  CanvasApiError,
  createCloudProject,
  deleteCloudProject,
  fetchCloudProject,
  listCloudProjects,
  saveCloudProject,
} from "../lib/api-client";
import {
  canvasDocumentFingerprint,
  canvasDocumentToProject,
  projectToCanvasDocument,
} from "../lib/cloud-project-adapter";
import { prepareProjectMediaForCloud } from "../lib/cloud-project-media";
import {
  duplicateProjectSnapshot,
  loadProjectLibrary,
  readProject,
  uniqueProjectName,
  writeProject,
} from "../lib/project-library";
import { useCanvasStore } from "./canvas-store";
import { useIdentityStore } from "./identity-store";
import { useProjectLibraryStore } from "./project-library-store";
import { useStorageTipStore } from "./storage-tip-store";
import { useToastStore } from "./toast-store";

export type CloudSyncStatus = "idle" | "syncing" | "synced" | "conflict" | "error" | "unavailable" | "local-only";

export type SharedCloudProjectSummary = CloudProjectSummary & {
  ownerId: string;
  role: "member";
};

export const CLOUD_QUOTA_LOCAL_MESSAGE = "云空间已满，当前内容仍保存在本地";
export const CLOUD_SIZE_LOCAL_MESSAGE = "内容超过云端单项大小限制，当前内容仍保存在本地";

type CloudProjectLink = {
  ownerId: string;
  projectOwnerId: string;
  projectId: string;
  revision: number;
  lastSyncedFingerprint: string;
};

type CloudProjectState = {
  ownerId: string | null;
  loading: boolean;
  projects: CloudProjectSummary[];
  sharedProjects: SharedCloudProjectSummary[];
  usage: CloudProjectUsage | null;
  links: Record<string, CloudProjectLink>;
  statusByProject: Record<string, CloudSyncStatus>;
  errorByProject: Record<string, string | null>;
  refresh: (ownerId: string, force?: boolean) => Promise<void>;
  enableProject: (ownerId: string, project: CanvasProject, options?: { silent?: boolean }) => Promise<boolean>;
  ensureAutoSync: (ownerId: string, project: CanvasProject) => void;
  scheduleSync: (ownerId: string, project: CanvasProject, immediate?: boolean) => void;
  retrySync: (ownerId: string, project: CanvasProject) => void;
  openRemoteProject: (ownerId: string, projectId: string, projectOwnerId?: string) => Promise<boolean>;
  deleteProject: (ownerId: string, projectId: string) => Promise<boolean>;
  reset: () => void;
};

const LINK_KEY_PREFIX = "kachang-canvas:cloud-link:v1:";
const TERMINAL_LOCAL_KEY_PREFIX = "kachang-canvas:cloud-terminal-local:v1:";
const CONFLICT_PRESERVED_KEY_PREFIX = "kachang-canvas:cloud-conflict-preserved:v1:";
const SYNC_DELAY_MS = 3_000;
const TERMINAL_LOCAL_ERROR_CODES = new Set([
  "MEDIA_STORAGE_LIMIT_REACHED",
  "CLOUD_PROJECT_LIMIT_REACHED",
  "CLOUD_PROJECT_STORAGE_LIMIT_REACHED",
  "CLOUD_PROJECT_DOCUMENT_TOO_LARGE",
  "MEDIA_TOO_LARGE",
]);
const SIZE_LIMIT_ERROR_CODES = new Set([
  "CLOUD_PROJECT_DOCUMENT_TOO_LARGE",
  "MEDIA_TOO_LARGE",
]);
const timers = new Map<string, number>();
const pending = new Map<string, CanvasProject>();
const inFlight = new Map<string, Promise<void>>();
const autoEnableInFlight = new Map<string, Promise<boolean>>();
let refreshRequest: { ownerId: string; promise: Promise<void> } | null = null;
let refreshVersion = 0;
let operationEpoch = 0;

export const useCloudProjectStore = create<CloudProjectState>((set, get) => ({
  ownerId: null,
  loading: false,
  projects: [],
  sharedProjects: [],
  usage: null,
  links: {},
  statusByProject: {},
  errorByProject: {},

  refresh: async (ownerId, force = false) => {
    if (!identityMatches(ownerId)) return;
    if (!force && refreshRequest?.ownerId === ownerId) return refreshRequest.promise;
    const ownerChanged = get().ownerId !== ownerId;
    if (ownerChanged) invalidateOperations();
    const terminalLocal = ownerChanged ? readTerminalLocalState(ownerId) : null;
    const epoch = operationEpoch;
    set({
      ownerId,
      loading: true,
      links: readCloudLinks(ownerId),
      ...(ownerChanged ? {
        projects: [],
        sharedProjects: [],
        usage: null,
        statusByProject: terminalLocal?.statusByProject ?? {},
        errorByProject: terminalLocal?.errorByProject ?? {},
      } : {}),
    });
    const version = ++refreshVersion;
    const promise = (async () => {
      try {
        const result = await listCloudProjects();
        if (!operationIsCurrent(ownerId, epoch, get) || refreshVersion !== version) return;
        set({
          projects: result.projects,
          sharedProjects: result.sharedProjects ?? [],
          usage: result.usage,
          loading: false,
        });
        // 用量到达时驱动配额贴士（含宽限期）重算。
        useStorageTipStore.getState().reevaluate(result.usage, result.usage.storageGrace ?? null);
      } catch (cause) {
        if (!operationIsCurrent(ownerId, epoch, get) || refreshVersion !== version) return;
        if (cause instanceof CanvasApiError && cause.status === 401) useIdentityStore.getState().expire();
        set({ loading: false });
      } finally {
        if (refreshVersion === version) refreshRequest = null;
      }
    })();
    refreshRequest = { ownerId, promise };
    return promise;
  },

  enableProject: async (ownerId, project, options) => {
    const silent = options?.silent === true;
    const epoch = operationEpoch;
    if (!operationIsCurrent(ownerId, epoch, get)) return false;
    clearTerminalLocal(ownerId, project.id);
    setProjectState(set, project.id, "syncing", null);
    try {
      const document = projectToCanvasDocument(project);
      const bootstrapDocument = projectToCloudBootstrapDocument(project);
      let cloud: Awaited<ReturnType<typeof createCloudProject>>;
      try {
        cloud = await createCloudProject({ document: bootstrapDocument });
        if (!operationIsCurrent(ownerId, epoch, get)) return false;
      } catch (cause) {
        if (!operationIsCurrent(ownerId, epoch, get)) return false;
        if (!(cause instanceof CanvasApiError) || cause.code !== "CLOUD_PROJECT_EXISTS") throw cause;
        const existing = await fetchCloudProject(project.id, ownerId);
        if (!operationIsCurrent(ownerId, epoch, get)) return false;
        const [existingFingerprint, documentFingerprint] = await Promise.all([
          canvasDocumentFingerprint(existing.document),
          canvasDocumentFingerprint(document),
        ]);
        if (!operationIsCurrent(ownerId, epoch, get)) return false;
        if (existingFingerprint !== documentFingerprint) {
          // 静默自动开通遇同名云端项目：不打断用户（无 toast、无冲突态），
          // 直接放弃自动开通；手动入口仍会显示冲突提示。
          if (silent) return false;
          setProjectState(set, project.id, "conflict", "云端已有同名项目，请先打开云端版本确认内容");
          return false;
        }
        cloud = existing;
      }
      const initialLink = await linkFromCloud(ownerId, cloud, ownerId);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      persistCloudLink(initialLink);
      set((state) => ({
        links: { ...state.links, [project.id]: initialLink },
        projects: upsertSummary(state.projects, cloud),
      }));

      const prepared = await prepareMediaWithoutCanvasSideEffects(project);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      const preparedDocument = projectToCanvasDocument(prepared);
      const preparedFingerprint = await canvasDocumentFingerprint(preparedDocument);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      if (preparedFingerprint !== initialLink.lastSyncedFingerprint) {
        cloud = await saveCloudProject(project.id, {
          baseRevision: initialLink.revision,
          document: preparedDocument,
          checkpoint: false,
        }, initialLink.projectOwnerId);
        if (!operationIsCurrent(ownerId, epoch, get)) return false;
      }

      const link = await linkFromCloud(ownerId, cloud, initialLink.projectOwnerId);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      applyPreparedMediaToCanvas(project, prepared, ownerId, epoch, get);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      persistCloudLink(link);
      set((state) => ({
        links: { ...state.links, [project.id]: link },
        projects: upsertSummary(state.projects, cloud),
      }));
      setProjectState(set, project.id, "synced", null);
      if (!silent) useToastStore.getState().show("项目已保存到云端", "success");
      void get().refresh(ownerId, true);
      return true;
    } catch (cause) {
      // 静默开通的失败全部静默：配额类转 local-only（贴士条可见），其余仅置
      // error 态等待下次编辑自动重试；手动入口（非 silent）保持原 toast 行为。
      handleSyncFailure(set, project.id, cause, ownerId, epoch, get, silent);
      return false;
    }
  },

  ensureAutoSync: (ownerId, project) => {
    const link = get().links[project.id];
    if (!operationIsCurrent(ownerId, operationEpoch, get)) return;
    if (link?.ownerId === ownerId) {
      get().scheduleSync(ownerId, project);
      return;
    }
    const status = get().statusByProject[project.id];
    if (status === "local-only" || status === "conflict") return;
    // 首次编辑静默开通云端项目；进行中/失败的自动开通不重复触发。
    if (autoEnableInFlight.has(project.id)) return;
    const request = get().enableProject(ownerId, project, { silent: true })
      .catch(() => false)
      .finally(() => autoEnableInFlight.delete(project.id));
    autoEnableInFlight.set(project.id, request);
    void request;
  },

  scheduleSync: (ownerId, project, immediate = false) => {
    const link = get().links[project.id];
    if (!operationIsCurrent(ownerId, operationEpoch, get) || link?.ownerId !== ownerId) return;
    if (get().statusByProject[project.id] === "local-only") return;
    enqueueSync(ownerId, project, immediate, get, set);
  },

  retrySync: (ownerId, project) => {
    const link = get().links[project.id];
    if (!operationIsCurrent(ownerId, operationEpoch, get) || link?.ownerId !== ownerId) return;
    clearTerminalLocal(ownerId, project.id);
    setProjectState(set, project.id, "syncing", null);
    enqueueSync(ownerId, project, true, get, set);
  },

  openRemoteProject: async (ownerId, projectId, projectOwnerId = ownerId) => {
    const epoch = operationEpoch;
    if (!operationIsCurrent(ownerId, epoch, get)) return false;
    setProjectState(set, projectId, "syncing", null);
    try {
      const cloud = await fetchCloudProject(projectId, projectOwnerId);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      const remote = canvasDocumentToProject(cloud.document);
      const local = readProject(projectId);
      let preserveLocal = false;
      if (local) {
        const [localFingerprint, remoteFingerprint] = await Promise.all([
          canvasDocumentFingerprint(projectToCanvasDocument(local)),
          canvasDocumentFingerprint(cloud.document),
        ]);
        if (!operationIsCurrent(ownerId, epoch, get)) return false;
        const link = get().links[projectId];
        preserveLocal = localFingerprint !== remoteFingerprint
          && (!link || localFingerprint !== link.lastSyncedFingerprint);
      }
      const nextLink = await linkFromCloud(ownerId, cloud, projectOwnerId);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      if (preserveLocal && local) {
        const localFingerprint = await canvasDocumentFingerprint(projectToCanvasDocument(local));
        if (!operationIsCurrent(ownerId, epoch, get)) return false;
        if (readConflictPreserved(ownerId, projectId) !== localFingerprint) {
          preserveLocalCopy(local);
          writeConflictPreserved(ownerId, projectId, localFingerprint);
        }
      }
      dropPendingSync(ownerId, projectId);
      writeProject(remote);
      useCanvasStore.getState().replaceProject(remote);
      useProjectLibraryStore.getState().refresh();
      clearTerminalLocal(ownerId, projectId);
      persistCloudLink(nextLink);
      set((state) => ({
        links: { ...state.links, [projectId]: nextLink },
        ...(projectOwnerId === ownerId
          ? { projects: upsertSummary(state.projects, cloud) }
          : { sharedProjects: upsertSharedSummary(state.sharedProjects, cloud, projectOwnerId) }),
      }));
      setProjectState(set, projectId, "synced", null);
      return true;
    } catch (cause) {
      handleSyncFailure(set, projectId, cause, ownerId, epoch, get);
      return false;
    }
  },

  deleteProject: async (ownerId, projectId) => {
    const epoch = operationEpoch;
    if (!operationIsCurrent(ownerId, epoch, get)) return false;
    const project = get().projects.find((item) => item.id === projectId);
    try {
      if (project) await deleteCloudProject(projectId, project.revision);
      if (!operationIsCurrent(ownerId, epoch, get)) return false;
      if (project) {
        removeCloudLink(ownerId, projectId);
        set((state) => ({
          projects: state.projects.filter((item) => item.id !== projectId),
          links: Object.fromEntries(Object.entries(state.links).filter(([key]) => key !== projectId)),
          statusByProject: Object.fromEntries(
            Object.entries(state.statusByProject).filter(([key]) => key !== projectId),
          ),
          errorByProject: Object.fromEntries(
            Object.entries(state.errorByProject).filter(([key]) => key !== projectId),
          ),
        }));
        useToastStore.getState().show("云端项目已删除", "success");
      }
      void get().refresh(ownerId, true);
      return true;
    } catch (cause) {
      const message = cause instanceof CanvasApiError
        ? cause.status === 409
          ? "云端项目已更新，请刷新后重试"
          : cause.status === 404
            ? "云端项目不存在或已删除"
            : "删除失败，请稍后重试"
        : "删除失败，请稍后重试";
      useToastStore.getState().show(message, "error");
      void get().refresh(ownerId, true);
      return false;
    }
  },

  reset: () => {
    invalidateOperations();
    set({
      ownerId: null,
      loading: false,
      projects: [],
      sharedProjects: [],
      usage: null,
      links: {},
      statusByProject: {},
      errorByProject: {},
    });
  },
}));

async function drainSync(
  ownerId: string,
  projectId: string,
  get: () => CloudProjectState,
  set: Parameters<typeof setProjectState>[0],
) {
  const epoch = operationEpoch;
  if (!operationIsCurrent(ownerId, epoch, get)) return;
  const key = syncKey(ownerId, projectId);
  if (get().statusByProject[projectId] === "local-only") {
    pending.delete(key);
    return;
  }
  if (inFlight.has(key)) return;
  const project = pending.get(key);
  if (!project) return;
  pending.delete(key);
  const request = performSync(ownerId, project, epoch, get, set).finally(() => {
    inFlight.delete(key);
    if (pending.has(key) && get().statusByProject[projectId] !== "local-only") {
      timers.set(key, window.setTimeout(() => {
        timers.delete(key);
        void drainSync(ownerId, projectId, get, set);
      }, 0));
    }
  });
  inFlight.set(key, request);
  await request;
}

async function performSync(
  ownerId: string,
  project: CanvasProject,
  epoch: number,
  get: () => CloudProjectState,
  set: Parameters<typeof setProjectState>[0],
) {
  const link = get().links[project.id];
  if (!operationIsCurrent(ownerId, epoch, get) || link?.ownerId !== ownerId) return;
  setProjectState(set, project.id, "syncing", null);
  let prepared: CanvasProject | null = null;
  let document: ReturnType<typeof projectToCanvasDocument> | null = null;
  let fingerprint: string | null = null;
  try {
    prepared = await prepareMediaWithoutCanvasSideEffects(project);
    if (!operationIsCurrent(ownerId, epoch, get)) return;
    document = projectToCanvasDocument(prepared);
    fingerprint = await canvasDocumentFingerprint(document);
    if (!operationIsCurrent(ownerId, epoch, get)) return;
    if (fingerprint === link.lastSyncedFingerprint) {
      setProjectState(set, project.id, "synced", null);
      return;
    }
    const cloud = await saveCloudProject(project.id, {
      baseRevision: link.revision,
      document,
      checkpoint: false,
    }, link.projectOwnerId);
    if (!operationIsCurrent(ownerId, epoch, get)) return;
    await acceptSyncedCloud(ownerId, project, prepared, cloud, link.projectOwnerId, epoch, get, set, true);
  } catch (cause) {
    if (!operationIsCurrent(ownerId, epoch, get)) return;
    if (
      cause instanceof CanvasApiError
      && cause.code === "CLOUD_PROJECT_REVISION_CONFLICT"
      && prepared
      && document
      && fingerprint
    ) {
      await resolveConflict(ownerId, project, prepared, document, fingerprint, link, epoch, get, set, true);
      return;
    }
    handleSyncFailure(set, project.id, cause, ownerId, epoch, get);
  }
}

async function resolveConflict(
  ownerId: string,
  local: CanvasProject,
  prepared: CanvasProject,
  localDocument: ReturnType<typeof projectToCanvasDocument>,
  localFingerprint: string,
  baseLink: CloudProjectLink,
  epoch: number,
  get: () => CloudProjectState,
  set: Parameters<typeof setProjectState>[0],
  allowFastForwardRetry: boolean,
) {
  try {
    const projectOwnerId = get().links[local.id]?.projectOwnerId ?? baseLink.projectOwnerId ?? ownerId;
    const cloud = await fetchCloudProject(local.id, projectOwnerId);
    if (!operationIsCurrent(ownerId, epoch, get)) return;
    const remoteFingerprint = await canvasDocumentFingerprint(cloud.document);
    if (!operationIsCurrent(ownerId, epoch, get)) return;

    // A repeated request can receive 409 after another tab already committed
    // the same content. Adopt the newer revision without creating a copy.
    if (remoteFingerprint === localFingerprint) {
      await acceptSyncedCloud(
        ownerId,
        local,
        prepared,
        cloud,
        projectOwnerId,
        epoch,
        get,
        set,
        false,
        remoteFingerprint,
      );
      return;
    }

    // The server revision can advance for a checkpoint or equivalent write
    // while its document stays on our synchronization baseline. Retry once
    // against the current revision because there is no competing content.
    if (remoteFingerprint === baseLink.lastSyncedFingerprint) {
      const currentLink = await linkFromCloud(ownerId, cloud, projectOwnerId, remoteFingerprint);
      if (!operationIsCurrent(ownerId, epoch, get)) return;
      if (allowFastForwardRetry) {
        try {
          const saved = await saveCloudProject(local.id, {
            baseRevision: cloud.revision,
            document: localDocument,
            checkpoint: false,
          }, projectOwnerId);
          if (!operationIsCurrent(ownerId, epoch, get)) return;
          await acceptSyncedCloud(ownerId, local, prepared, saved, projectOwnerId, epoch, get, set, true);
          return;
        } catch (cause) {
          if (
            cause instanceof CanvasApiError
            && cause.code === "CLOUD_PROJECT_REVISION_CONFLICT"
            && operationIsCurrent(ownerId, epoch, get)
          ) {
            await resolveConflict(
              ownerId,
              local,
              prepared,
              localDocument,
              localFingerprint,
              currentLink,
              epoch,
              get,
              set,
              false,
            );
            return;
          }
          throw cause;
        }
      }

      // A rapidly advancing but content-identical remote should not manufacture
      // conflict copies or enter an endless retry loop. Advance the baseline;
      // the next real edit can retry with the current revision.
      persistCloudLink(currentLink);
      useCloudProjectStore.setState((state) => ({
        links: { ...state.links, [local.id]: currentLink },
        ...(projectOwnerId === ownerId
          ? { projects: upsertSummary(state.projects, cloud) }
          : { sharedProjects: upsertSharedSummary(state.sharedProjects, cloud, projectOwnerId) }),
      }));
      setProjectState(set, local.id, "conflict", "云端版本号已更新，请再次保存");
      return;
    }

    const remote = canvasDocumentToProject(cloud.document);
    const link = await linkFromCloud(ownerId, cloud, projectOwnerId, remoteFingerprint);
    if (!operationIsCurrent(ownerId, epoch, get)) return;
    // Preserving the local edit as a copy is idempotent and bounded: the same
    // conflicting content is archived once, even when a stale tab, a repeated
    // sync, or recovery re-enters the same conflict.
    let copy: CanvasProject | null = null;
    if (readConflictPreserved(ownerId, local.id) !== localFingerprint) {
      copy = preserveLocalCopy(local);
      writeConflictPreserved(ownerId, local.id, localFingerprint);
    }
    // Drop queued pre-conflict snapshots so autosave, an old pending item, or a
    // recovery flow cannot re-sync the stale content into a new revision after
    // the remote version has replaced the local project.
    dropPendingSync(ownerId, local.id);
    writeProject(remote);
    if (useCanvasStore.getState().projectId === local.id) useCanvasStore.getState().replaceProject(remote);
    useProjectLibraryStore.getState().refresh();
    persistCloudLink(link);
    useCloudProjectStore.setState((state) => ({
      links: { ...state.links, [local.id]: link },
      ...(projectOwnerId === ownerId
        ? { projects: upsertSummary(state.projects, cloud) }
        : { sharedProjects: upsertSharedSummary(state.sharedProjects, cloud, projectOwnerId) }),
    }));
    setProjectState(set, local.id, "conflict", null);
    if (copy) useToastStore.getState().show(`检测到其他设备的修改，已保留“${copy.name}”`, "info");
  } catch (cause) {
    handleSyncFailure(set, local.id, cause, ownerId, epoch, get);
  }
}

async function acceptSyncedCloud(
  ownerId: string,
  source: CanvasProject,
  prepared: CanvasProject,
  cloud: Awaited<ReturnType<typeof fetchCloudProject>>,
  projectOwnerId: string,
  epoch: number,
  get: () => CloudProjectState,
  set: Parameters<typeof setProjectState>[0],
  refresh: boolean,
  knownFingerprint?: string,
) {
  const link = await linkFromCloud(ownerId, cloud, projectOwnerId, knownFingerprint);
  if (!operationIsCurrent(ownerId, epoch, get)) return false;
  applyPreparedMediaToCanvas(source, prepared, ownerId, epoch, get);
  if (!operationIsCurrent(ownerId, epoch, get)) return false;
  persistCloudLink(link);
  clearTerminalLocal(ownerId, source.id);
  useCloudProjectStore.setState((state) => ({
    links: { ...state.links, [source.id]: link },
    ...(projectOwnerId === ownerId
      ? { projects: upsertSummary(state.projects, cloud) }
      : { sharedProjects: upsertSharedSummary(state.sharedProjects, cloud, projectOwnerId) }),
  }));
  setProjectState(set, source.id, "synced", null);
  if (refresh) void get().refresh(ownerId, true);
  return true;
}

function preserveLocalCopy(project: CanvasProject) {
  const summaries = loadProjectLibrary().projects;
  const name = uniqueProjectName(`${project.name} 冲突副本`, summaries);
  const copy = duplicateProjectSnapshot(project, name);
  writeProject(copy, undefined, false);
  return copy;
}

function projectToCloudBootstrapDocument(project: CanvasProject) {
  return projectToCanvasDocument({
    ...project,
    nodes: project.nodes.map((node) => {
      const media = node.data.media;
      if (!media?.serverId) return node;
      return {
        ...node,
        data: {
          ...node.data,
          media: { ...media, source: "local", serverId: null },
        },
      };
    }),
  });
}

async function linkFromCloud(
  ownerId: string,
  cloud: Awaited<ReturnType<typeof fetchCloudProject>>,
  projectOwnerId: string,
  knownFingerprint?: string,
): Promise<CloudProjectLink> {
  return {
    ownerId,
    projectOwnerId,
    projectId: cloud.id,
    revision: cloud.revision,
    lastSyncedFingerprint: knownFingerprint ?? await canvasDocumentFingerprint(cloud.document),
  };
}

function setProjectState(
  set: (partial: Partial<CloudProjectState> | ((state: CloudProjectState) => Partial<CloudProjectState>)) => void,
  projectId: string,
  status: CloudSyncStatus,
  error: string | null,
) {
  set((state) => ({
    statusByProject: { ...state.statusByProject, [projectId]: status },
    errorByProject: { ...state.errorByProject, [projectId]: error },
  }));
}

function handleSyncFailure(
  set: Parameters<typeof setProjectState>[0],
  projectId: string,
  cause: unknown,
  ownerId: string,
  epoch: number,
  get: () => CloudProjectState,
  silent = false,
) {
  if (!operationIsCurrent(ownerId, epoch, get)) return;
  if (cause instanceof CanvasApiError && cause.status === 401) useIdentityStore.getState().expire();
  const terminalLocal = terminalLocalFailure(cause);
  if (terminalLocal) {
    suspendPendingSync(ownerId, projectId);
    persistTerminalLocal(ownerId, projectId, terminalLocal.code);
    setProjectState(set, projectId, "local-only", terminalLocal.message);
    if (!silent) useToastStore.getState().show(terminalLocal.message, "info");
    void get().refresh(ownerId, true);
    return;
  }
  const unavailable = cause instanceof CanvasApiError && (cause.status === 0 || cause.status >= 500);
  const status = unavailable ? "unavailable" : "error";
  const message = cause instanceof Error ? cause.message : "云端保存没有完成";
  setProjectState(set, projectId, status, message);
}

function enqueueSync(
  ownerId: string,
  project: CanvasProject,
  immediate: boolean,
  get: () => CloudProjectState,
  set: Parameters<typeof setProjectState>[0],
) {
  const key = syncKey(ownerId, project.id);
  pending.set(key, structuredClone(project));
  const existing = timers.get(key);
  if (existing !== undefined) window.clearTimeout(existing);
  timers.set(key, window.setTimeout(() => {
    timers.delete(key);
    void drainSync(ownerId, project.id, get, set);
  }, immediate ? 0 : SYNC_DELAY_MS));
}

function suspendPendingSync(ownerId: string, projectId: string) {
  const key = syncKey(ownerId, projectId);
  const timer = timers.get(key);
  if (timer !== undefined) window.clearTimeout(timer);
  timers.delete(key);
  pending.delete(key);
}

function dropPendingSync(ownerId: string, projectId: string) {
  suspendPendingSync(ownerId, projectId);
}

function terminalLocalFailure(cause: unknown) {
  if (!(cause instanceof CanvasApiError) || !TERMINAL_LOCAL_ERROR_CODES.has(cause.code)) return null;
  return { code: cause.code, message: terminalLocalMessage(cause.code) };
}

async function prepareMediaWithoutCanvasSideEffects(project: CanvasProject) {
  return prepareProjectMediaForCloud(project, { applyToCanvas: false });
}

function applyPreparedMediaToCanvas(
  source: CanvasProject,
  prepared: CanvasProject,
  ownerId: string,
  epoch: number,
  get: () => CloudProjectState,
) {
  if (!operationIsCurrent(ownerId, epoch, get)) return;
  const canvas = useCanvasStore.getState();
  if (canvas.projectId !== source.id) return;
  prepared.nodes.forEach((node) => {
    if (!operationIsCurrent(ownerId, epoch, get)) return;
    const media = node.data.media;
    if (!media?.serverId) return;
    const current = useCanvasStore.getState().nodes.find((item) => item.id === node.id)?.data.media;
    if (current?.id === media.id && current.serverId !== media.serverId) {
      useCanvasStore.getState().updateNodeData(node.id, { media: { ...current, serverId: media.serverId } }, false);
    }
  });
}

function operationIsCurrent(ownerId: string, epoch: number, get: () => CloudProjectState) {
  return operationEpoch === epoch && get().ownerId === ownerId && identityMatches(ownerId);
}

function identityMatches(ownerId: string) {
  const identity = useIdentityStore.getState();
  return identity.status === "authenticated" && identity.session?.user.id === ownerId;
}

function invalidateOperations() {
  operationEpoch += 1;
  refreshVersion += 1;
  refreshRequest = null;
  for (const timer of timers.values()) window.clearTimeout(timer);
  timers.clear();
  pending.clear();
  autoEnableInFlight.clear();
}

function upsertSummary(
  projects: CloudProjectSummary[],
  cloud: Awaited<ReturnType<typeof fetchCloudProject>>,
) {
  const { document: _document, ...summary } = cloud;
  return [...projects.filter((project) => project.id !== summary.id), summary]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

function upsertSharedSummary(
  projects: SharedCloudProjectSummary[],
  cloud: Awaited<ReturnType<typeof fetchCloudProject>>,
  ownerId: string,
) {
  const { document: _document, ...summary } = cloud;
  const shared = { ...summary, ownerId, role: "member" as const };
  return [...projects.filter((project) => project.id !== shared.id || project.ownerId !== ownerId), shared]
    .sort((left, right) => (
      right.updatedAt.localeCompare(left.updatedAt)
      || left.ownerId.localeCompare(right.ownerId)
      || left.id.localeCompare(right.id)
    ));
}

function syncKey(ownerId: string, projectId: string) {
  return `${ownerId}:${projectId}`;
}

function cloudLinkKey(ownerId: string, projectId: string) {
  return `${LINK_KEY_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(projectId)}`;
}

function terminalLocalKey(ownerId: string, projectId: string) {
  return `${TERMINAL_LOCAL_KEY_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(projectId)}`;
}

function terminalLocalMessage(code: string) {
  return SIZE_LIMIT_ERROR_CODES.has(code) ? CLOUD_SIZE_LOCAL_MESSAGE : CLOUD_QUOTA_LOCAL_MESSAGE;
}

function persistTerminalLocal(ownerId: string, projectId: string, code: string) {
  if (!TERMINAL_LOCAL_ERROR_CODES.has(code)) return;
  try {
    localStorage.setItem(terminalLocalKey(ownerId, projectId), JSON.stringify({ code }));
  } catch {
    // The in-memory suspension still protects the current session.
  }
}

function clearTerminalLocal(ownerId: string, projectId: string) {
  try {
    localStorage.removeItem(terminalLocalKey(ownerId, projectId));
  } catch {
    // A failed cleanup must not block an explicit retry.
  }
}

function readTerminalLocalState(ownerId: string) {
  const statusByProject: Record<string, CloudSyncStatus> = {};
  const errorByProject: Record<string, string | null> = {};
  const prefix = `${TERMINAL_LOCAL_KEY_PREFIX}${encodeURIComponent(ownerId)}:`;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      try {
        const projectId = decodeURIComponent(key.slice(prefix.length));
        const code = parseTerminalLocalCode(localStorage.getItem(key));
        if (!projectId || !code) continue;
        statusByProject[projectId] = "local-only";
        errorByProject[projectId] = terminalLocalMessage(code);
      } catch {
        // Ignore a malformed key without hiding other valid suspensions.
      }
    }
  } catch {
    return { statusByProject: {}, errorByProject: {} };
  }
  return { statusByProject, errorByProject };
}

function parseTerminalLocalCode(raw: string | null) {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { code?: unknown };
    return typeof value.code === "string" && TERMINAL_LOCAL_ERROR_CODES.has(value.code) ? value.code : null;
  } catch {
    return null;
  }
}

function persistCloudLink(link: CloudProjectLink) {
  localStorage.setItem(cloudLinkKey(link.ownerId, link.projectId), JSON.stringify(link));
}

function removeCloudLink(ownerId: string, projectId: string) {
  try {
    localStorage.removeItem(cloudLinkKey(ownerId, projectId));
  } catch {
    // storage unavailable（隐私模式等）：仅内存态更新，不影响云端删除
  }
}

function readCloudLinks(ownerId: string) {
  const links: Record<string, CloudProjectLink> = {};
  const prefix = `${LINK_KEY_PREFIX}${encodeURIComponent(ownerId)}:`;
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const link = parseCloudLink(localStorage.getItem(key));
      if (link?.ownerId === ownerId) links[link.projectId] = link;
    }
  } catch {
    return {};
  }
  return links;
}

function parseCloudLink(raw: string | null): CloudProjectLink | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (typeof value.ownerId !== "string" || typeof value.projectId !== "string") return null;
    const projectOwnerId = typeof value.projectOwnerId === "string" ? value.projectOwnerId : value.ownerId;
    if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 1) return null;
    if (typeof value.lastSyncedFingerprint !== "string" || !/^[a-f0-9]{16,64}$/.test(value.lastSyncedFingerprint)) return null;
    return {
      ownerId: value.ownerId,
      projectOwnerId,
      projectId: value.projectId,
      revision: Number(value.revision),
      lastSyncedFingerprint: value.lastSyncedFingerprint,
    };
  } catch {
    return null;
  }
}

function conflictPreservedKey(ownerId: string, projectId: string) {
  return `${CONFLICT_PRESERVED_KEY_PREFIX}${encodeURIComponent(ownerId)}:${encodeURIComponent(projectId)}`;
}

function readConflictPreserved(ownerId: string, projectId: string): string | null {
  try {
    const raw = localStorage.getItem(conflictPreservedKey(ownerId, projectId));
    const value = JSON.parse(raw ?? "null") as { fingerprint?: unknown } | null;
    return typeof value?.fingerprint === "string" && /^[a-f0-9]{16,64}$/.test(value.fingerprint) ? value.fingerprint : null;
  } catch {
    return null;
  }
}

function writeConflictPreserved(ownerId: string, projectId: string, fingerprint: string) {
  try {
    localStorage.setItem(conflictPreservedKey(ownerId, projectId), JSON.stringify({ fingerprint }));
  } catch {
    // A failed marker write must not block the current conflict resolution; the
    // in-memory replacement below still keeps the local copy creation bounded.
  }
}
