import type { CanvasMedia, PublicGenerationJob } from "@kachang/contracts";
import { create } from "zustand";

import { cacheServerMedia, readMedia } from "../lib/media-store";

const DATABASE_NAME = "kachang-canvas-local-output";
const DATABASE_VERSION = 1;
const SETTINGS_STORE = "settings";
const OUTPUT_STORE = "outputs";
const WRITE_LEASE_MS = 2 * 60_000;
const WRITE_LEASE_RENEW_MS = Math.floor(WRITE_LEASE_MS / 3);
const LOCK_PREFIX = "kachang-canvas:local-output";

export type LocalOutputKind = "image" | "video";
type LocalOutputPermission = PermissionState | "unknown";
type LocalOutputActivity = "idle" | "saving" | "error";
type GenerationMediaArtifact = Exclude<PublicGenerationJob["artifacts"][number], { kind: "text" }>;

export type LocalDirectoryHandle = {
  kind: "directory";
  name: string;
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<LocalFileHandle>;
  isSameEntry?: (other: LocalDirectoryHandle) => Promise<boolean>;
  queryPermission?: (descriptor?: { mode?: "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: "readwrite" }) => Promise<PermissionState>;
};

type LocalFileHandle = {
  createWritable: () => Promise<LocalFileWriter>;
};

type LocalFileWriter = {
  write: (data: Blob) => Promise<void>;
  close: () => Promise<void>;
  abort?: () => Promise<void>;
};

export type LocalOutputSettingsRecord = {
  key: LocalOutputKind;
  schemaVersion: 1;
  kind: LocalOutputKind;
  enabled: boolean;
  targetId: string;
  enabledAt: number;
  directoryName: string;
  handle: LocalDirectoryHandle;
};

export type LocalOutputRecord = {
  key: string;
  schemaVersion: 1;
  targetId: string;
  kind: LocalOutputKind;
  outputKey: string;
  state: "pending" | "writing" | "saved";
  fileName: string;
  media: CanvasMedia;
  artifactCreatedAt: number;
  leaseOwner: string | null;
  leaseUntil: number | null;
  savedAt: number | null;
  attempts: number;
  lastError: string | null;
};

export type LocalOutputPersistence = {
  readSettings: (kind: LocalOutputKind) => Promise<LocalOutputSettingsRecord | null>;
  writeSettings: (settings: LocalOutputSettingsRecord) => Promise<void>;
  deleteSettings: (kind: LocalOutputKind) => Promise<void>;
  enqueue: (record: LocalOutputRecord) => Promise<boolean>;
  listPending: (targetId: string) => Promise<LocalOutputRecord[]>;
  claim: (key: string, ownerId: string, now: number) => Promise<LocalOutputRecord | null>;
  renew: (key: string, ownerId: string, now: number) => Promise<boolean>;
  updateFileName: (key: string, ownerId: string, fileName: string) => Promise<LocalOutputRecord | null>;
  markSaved: (key: string, ownerId: string, savedAt: number) => Promise<boolean>;
  release: (key: string, ownerId: string, error: string) => Promise<boolean>;
  countPending: (targetId: string) => Promise<number>;
  movePending: (sourceTargetId: string, target: LocalOutputSettingsRecord) => Promise<number>;
  deleteTarget: (targetId: string) => Promise<void>;
};

export type LocalOutputTargetState = {
  enabled: boolean;
  directoryName: string | null;
  permission: LocalOutputPermission;
  activity: LocalOutputActivity;
  pendingCount: number;
  lastSavedName: string | null;
  error: string | null;
};

type LocalOutputState = {
  supported: boolean;
  initialized: boolean;
  targets: Record<LocalOutputKind, LocalOutputTargetState>;
  initialize: () => Promise<void>;
  chooseDirectory: (kind: LocalOutputKind) => Promise<boolean>;
  requestDirectoryPermission: (kind: LocalOutputKind) => Promise<boolean>;
  setEnabled: (kind: LocalOutputKind, enabled: boolean) => Promise<void>;
  clearDirectory: (kind: LocalOutputKind) => Promise<void>;
  retryPending: (kind?: LocalOutputKind) => Promise<void>;
  enqueueGenerationJob: (job: PublicGenerationJob, recovered?: boolean) => Promise<void>;
};

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "readwrite";
    startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
  }) => Promise<LocalDirectoryHandle>;
};

type LockManagerNavigator = Navigator & {
  locks?: {
    request: <T>(name: string, callback: () => T | PromiseLike<T>) => Promise<T>;
  };
};

const persistence = createIndexedDbPersistence();
const writerOwnerId = `writer:${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)}`;
let initializationRequest: Promise<void> | null = null;
let drainRequest: Promise<void> | null = null;
const drainRequested = new Set<LocalOutputKind>();
const localLockTails = new Map<LocalOutputKind, Promise<void>>();

const emptyTargetState = (): LocalOutputTargetState => ({
  enabled: false,
  directoryName: null,
  permission: "unknown",
  activity: "idle",
  pendingCount: 0,
  lastSavedName: null,
  error: null,
});

export const useLocalOutputStore = create<LocalOutputState>((set, get) => ({
  supported: supportsLocalOutputDirectory(),
  initialized: false,
  targets: { image: emptyTargetState(), video: emptyTargetState() },

  initialize: async () => {
    if (get().initialized) return;
    if (initializationRequest) return initializationRequest;
    initializationRequest = (async () => {
      if (!get().supported) {
        set({ initialized: true });
        return;
      }
      try {
        const entries = await Promise.all((["image", "video"] as const).map(async (kind) => {
          const settings = await persistence.readSettings(kind);
          if (!settings) return [kind, { settings: null, state: emptyTargetState() }] as const;
          const permission = await queryDirectoryPermission(settings.handle);
          const pendingCount = await persistence.countPending(settings.targetId);
          return [kind, {
            settings,
            state: {
              ...emptyTargetState(),
              enabled: settings.enabled,
              directoryName: settings.directoryName,
              permission,
              pendingCount,
            },
          }] as const;
        }));
        const loaded = Object.fromEntries(entries) as Record<LocalOutputKind, {
          settings: LocalOutputSettingsRecord | null;
          state: LocalOutputTargetState;
        }>;
        set({ initialized: true, targets: { image: loaded.image.state, video: loaded.video.state } });
        for (const kind of ["image", "video"] as const) {
          const entry = loaded[kind];
          if (entry.settings?.enabled && entry.state.permission === "granted") await requestDrain(kind);
        }
      } catch (cause) {
        const error = publicLocalOutputError(cause);
        set({
          initialized: true,
          targets: {
            image: { ...get().targets.image, activity: "error", error },
            video: { ...get().targets.video, activity: "error", error },
          },
        });
      }
    })().finally(() => {
      initializationRequest = null;
    });
    return initializationRequest;
  },

  chooseDirectory: async (kind) => {
    if (!get().supported) return false;
    const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
    if (!picker) return false;
    try {
      const handle = await picker({
        id: `kachang-generated-${kind}`,
        mode: "readwrite",
        startIn: kind === "video" ? "videos" : "pictures",
      });
      let permission = await queryDirectoryPermission(handle);
      if (permission === "prompt" && handle.requestPermission) {
        permission = await handle.requestPermission({ mode: "readwrite" });
      }
      await withTargetLock(kind, async () => {
        const previous = await persistence.readSettings(kind);
        const sameTarget = previous ? await handlesMatch(previous.handle, handle) : false;
        const settings: LocalOutputSettingsRecord = {
          key: kind,
          schemaVersion: 1,
          kind,
          enabled: true,
          targetId: sameTarget && previous ? previous.targetId : createRuntimeId("directory"),
          enabledAt: sameTarget && previous ? previous.enabledAt : Date.now(),
          directoryName: handle.name,
          handle,
        };
        if (previous && !sameTarget) {
          await persistence.movePending(previous.targetId, settings);
          await persistence.deleteTarget(previous.targetId);
        } else {
          await persistence.writeSettings(settings);
        }
        const pendingCount = await persistence.countPending(settings.targetId);
        set((state) => ({
          initialized: true,
          targets: {
            ...state.targets,
            [kind]: {
              ...emptyTargetState(),
              enabled: true,
              directoryName: handle.name,
              permission,
              pendingCount,
              error: permission === "denied" ? "没有该文件夹的写入权限" : null,
            },
          },
        }));
      });
      if (permission === "granted") await requestDrain(kind);
      return permission === "granted";
    } catch (cause) {
      if (isAbortError(cause)) return false;
      patchTarget(kind, { activity: "error", error: publicLocalOutputError(cause) });
      return false;
    }
  },

  requestDirectoryPermission: async (kind) => {
    try {
      let shouldDrain = false;
      const granted = await withTargetLock(kind, async () => {
        const settings = await persistence.readSettings(kind);
        if (!settings) return false;
        const permission = settings.handle.requestPermission
          ? await settings.handle.requestPermission({ mode: "readwrite" })
          : await queryDirectoryPermission(settings.handle);
        patchTarget(kind, { permission, error: permission === "granted" ? null : "需要文件夹写入权限才能自动保存" });
        shouldDrain = permission === "granted" && settings.enabled;
        return permission === "granted";
      });
      if (shouldDrain) await requestDrain(kind);
      return granted;
    } catch (cause) {
      patchTarget(kind, { activity: "error", error: publicLocalOutputError(cause) });
      return false;
    }
  },

  setEnabled: async (kind, enabled) => {
    try {
      let shouldDrain = false;
      await withTargetLock(kind, async () => {
        const settings = await persistence.readSettings(kind);
        if (!settings) {
          if (enabled) patchTarget(kind, { error: "请先选择自动保存文件夹" });
          return;
        }
        await persistence.writeSettings({ ...settings, enabled });
        const permission = await queryDirectoryPermission(settings.handle);
        patchTarget(kind, { enabled, permission, error: null });
        shouldDrain = enabled && permission === "granted";
      });
      if (shouldDrain) await requestDrain(kind);
    } catch (cause) {
      patchTarget(kind, { activity: "error", error: publicLocalOutputError(cause) });
    }
  },

  clearDirectory: async (kind) => {
    try {
      await withTargetLock(kind, async () => {
        const settings = await persistence.readSettings(kind);
        await persistence.deleteSettings(kind);
        if (settings) await persistence.deleteTarget(settings.targetId);
        set((state) => ({ initialized: true, targets: { ...state.targets, [kind]: emptyTargetState() } }));
      });
    } catch (cause) {
      patchTarget(kind, { activity: "error", error: publicLocalOutputError(cause) });
    }
  },

  retryPending: async (kind) => {
    try {
      await get().initialize();
      if (kind) {
        await requestDrain(kind);
        return;
      }
      await requestDrain("image");
      await requestDrain("video");
    } catch (cause) {
      const error = publicLocalOutputError(cause);
      if (kind) patchTarget(kind, { activity: "error", error });
      else for (const targetKind of ["image", "video"] as const) patchTarget(targetKind, { activity: "error", error });
    }
  },

  enqueueGenerationJob: async (job, recovered = false) => {
    if (job.status !== "completed" || !job.artifacts.some(isLocalOutputArtifact)) return;
    await get().initialize();
    if (!get().supported) return;
    try {
      for (const kind of ["image", "video"] as const) {
        let shouldDrain = false;
        await withTargetLock(kind, async () => {
          const settings = await persistence.readSettings(kind);
          if (!settings?.enabled) return;
          await enqueueGenerationOutputRecords(job, settings, persistence, recovered);
          patchTarget(kind, { pendingCount: await persistence.countPending(settings.targetId) });
          shouldDrain = true;
        });
        if (shouldDrain) await requestDrain(kind);
      }
    } catch (cause) {
      const error = publicLocalOutputError(cause);
      for (const kind of ["image", "video"] as const) patchTarget(kind, { activity: "error", error });
    }
  },
}));

export function enqueueCompletedGenerationOutputs(job: PublicGenerationJob, recovered = false) {
  if (job.status !== "completed") return;
  void useLocalOutputStore.getState().enqueueGenerationJob(job, recovered).catch(() => undefined);
}

export async function enqueueGeneratedMedia(input: {
  outputKey: string;
  createdAt: string | number;
  media: CanvasMedia;
}) {
  const kind = localOutputKind(input.media.mimeType);
  if (!kind) return;
  const store = useLocalOutputStore.getState();
  await store.initialize();
  if (!useLocalOutputStore.getState().supported) return;
  try {
    let shouldDrain = false;
    await withTargetLock(kind, async () => {
      const settings = await persistence.readSettings(kind);
      if (!settings?.enabled) return;
      const record = buildGeneratedMediaOutputRecord(input, settings);
      if (!record) return;
      await persistence.enqueue(record);
      patchTarget(kind, { pendingCount: await persistence.countPending(settings.targetId) });
      shouldDrain = true;
    });
    if (shouldDrain) await requestDrain(kind);
  } catch (cause) {
    patchTarget(kind, { activity: "error", error: publicLocalOutputError(cause) });
  }
}

export function buildGeneratedMediaOutputRecord(
  input: { outputKey: string; createdAt: string | number; media: CanvasMedia },
  settings: LocalOutputSettingsRecord,
) {
  const kind = localOutputKind(input.media.mimeType);
  const artifactCreatedAt = typeof input.createdAt === "number" ? input.createdAt : Date.parse(input.createdAt);
  if (!settings.enabled || kind !== settings.kind || !Number.isFinite(artifactCreatedAt) || artifactCreatedAt < settings.enabledAt) return null;
  const outputKey = `browser:${input.outputKey}`;
  return {
    key: `${settings.targetId}:${outputKey}`,
    schemaVersion: 1 as const,
    targetId: settings.targetId,
    kind,
    outputKey,
    state: "pending" as const,
    fileName: buildLocalOutputFileName(input.media.name, input.media.mimeType, outputKey),
    media: input.media,
    artifactCreatedAt,
    leaseOwner: null,
    leaseUntil: null,
    savedAt: null,
    attempts: 0,
    lastError: null,
  } satisfies LocalOutputRecord;
}

export function buildGenerationOutputRecords(
  job: PublicGenerationJob,
  settings: LocalOutputSettingsRecord,
  recovered = true,
) {
  if (job.status !== "completed" || !settings.enabled) return [];
  return job.artifacts.flatMap((artifact): LocalOutputRecord[] => {
    if (!isLocalOutputArtifact(artifact) || artifact.kind !== settings.kind) return [];
    const artifactCreatedAt = Date.parse(artifact.createdAt);
    if (!Number.isFinite(artifactCreatedAt) || (recovered && artifactCreatedAt < settings.enabledAt)) return [];
    const outputKey = `hosted:${job.id}:${artifact.id}`;
    return [{
      key: `${settings.targetId}:${outputKey}`,
      schemaVersion: 1,
      targetId: settings.targetId,
      kind: settings.kind,
      outputKey,
      state: "pending",
      fileName: buildLocalOutputFileName(artifact.name, artifact.mimeType, outputKey),
      media: mediaFromArtifact(artifact),
      artifactCreatedAt,
      leaseOwner: null,
      leaseUntil: null,
      savedAt: null,
      attempts: 0,
      lastError: null,
    }];
  });
}

export async function enqueueGenerationOutputRecords(
  job: PublicGenerationJob,
  settings: LocalOutputSettingsRecord,
  target: Pick<LocalOutputPersistence, "enqueue">,
  recovered = true,
) {
  let inserted = 0;
  for (const record of buildGenerationOutputRecords(job, settings, recovered)) {
    if (await target.enqueue(record)) inserted += 1;
  }
  return inserted;
}

export function migrateLocalOutputSettings(
  value: unknown,
  kind: LocalOutputKind,
  createTargetId: () => string = () => createRuntimeId("directory"),
  now = Date.now(),
): LocalOutputSettingsRecord | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const handle = isDirectoryHandle(source.handle)
    ? source.handle
    : isDirectoryHandle(source.directoryHandle) ? source.directoryHandle : null;
  if (!handle) return null;
  const storedKind = source.kind === "image" || source.kind === "video" ? source.kind : null;
  if (storedKind && storedKind !== kind) return null;
  const legacySingleTarget = source.key === "active";
  const sourceTargetId = typeof source.targetId === "string" && source.targetId ? source.targetId : null;
  const targetId = sourceTargetId ? (legacySingleTarget ? `${sourceTargetId}:${kind}` : sourceTargetId) : createTargetId();
  const enabledAt = typeof source.enabledAt === "number" && Number.isFinite(source.enabledAt)
    ? source.enabledAt
    : typeof source.selectedAt === "number" && Number.isFinite(source.selectedAt) ? source.selectedAt : now;
  return {
    key: kind,
    schemaVersion: 1,
    kind,
    enabled: source.enabled !== false,
    targetId,
    enabledAt,
    directoryName: typeof source.directoryName === "string" && source.directoryName ? source.directoryName : handle.name,
    handle,
  };
}

export function claimLocalOutputRecord(
  record: LocalOutputRecord,
  ownerId: string,
  now: number,
  leaseMs = WRITE_LEASE_MS,
) {
  if (record.state === "saved") return null;
  if (record.state === "writing" && record.leaseUntil !== null && record.leaseUntil > now) return null;
  return {
    ...record,
    state: "writing" as const,
    leaseOwner: ownerId,
    leaseUntil: now + leaseMs,
    attempts: record.attempts + 1,
    lastError: null,
  };
}

export function renewLocalOutputRecord(
  record: LocalOutputRecord,
  ownerId: string,
  now: number,
  leaseMs = WRITE_LEASE_MS,
) {
  if (record.state !== "writing" || record.leaseOwner !== ownerId) return null;
  return { ...record, leaseUntil: now + leaseMs };
}

export function completeLocalOutputRecord(record: LocalOutputRecord, ownerId: string, savedAt: number) {
  if (record.state !== "writing" || record.leaseOwner !== ownerId) return null;
  return { ...record, state: "saved" as const, leaseOwner: null, leaseUntil: null, savedAt, lastError: null };
}

export function migratePendingLocalOutputRecord(record: LocalOutputRecord, target: LocalOutputSettingsRecord) {
  if (record.state === "saved") return null;
  return {
    ...record,
    key: `${target.targetId}:${record.outputKey}`,
    targetId: target.targetId,
    kind: target.kind,
    state: "pending" as const,
    leaseOwner: null,
    leaseUntil: null,
    savedAt: null,
    lastError: null,
  };
}

export function buildLocalOutputFileName(name: string, mimeType: string, outputKey: string) {
  const normalized = name.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").trim();
  const dot = normalized.lastIndexOf(".");
  let stem = dot > 0 ? normalized.slice(0, dot) : normalized;
  stem = stem.replace(/^[. ]+|[. ]+$/g, "").slice(0, 120) || (mimeType.startsWith("video/") ? "video" : "image");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
  return `${stem}-${stableHash(outputKey)}-${randomFileToken()}.${extensionForMimeType(mimeType)}`;
}

export async function findAvailableLocalOutputFileName(handle: LocalDirectoryHandle, record: LocalOutputRecord) {
  let candidate = record.fileName;
  for (let attempt = 0; attempt < 32; attempt += 1) {
    if (!(await localOutputFileExists(handle, candidate))) return candidate;
    candidate = buildLocalOutputFileName(record.media.name, record.media.mimeType, record.outputKey);
  }
  throw new Error("无法为自动保存结果分配唯一文件名");
}

function supportsLocalOutputDirectory() {
  return typeof window !== "undefined"
    && window.isSecureContext
    && typeof indexedDB !== "undefined"
    && typeof (window as DirectoryPickerWindow).showDirectoryPicker === "function";
}

function patchTarget(kind: LocalOutputKind, change: Partial<LocalOutputTargetState>) {
  useLocalOutputStore.setState((state) => ({
    targets: {
      ...state.targets,
      [kind]: { ...state.targets[kind], ...change },
    },
  }));
}

async function withTargetLock<T>(kind: LocalOutputKind, operation: () => Promise<T>): Promise<T> {
  const lockManager = typeof navigator !== "undefined" ? (navigator as LockManagerNavigator).locks : undefined;
  if (lockManager?.request) return lockManager.request(`${LOCK_PREFIX}:${kind}`, operation);

  const previous = localLockTails.get(kind) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  localLockTails.set(kind, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (localLockTails.get(kind) === tail) localLockTails.delete(kind);
  }
}

async function requestDrain(kind: LocalOutputKind) {
  drainRequested.add(kind);
  if (drainRequest) return drainRequest;
  drainRequest = (async () => {
    while (drainRequested.size) {
      const next = drainRequested.values().next().value as LocalOutputKind;
      drainRequested.delete(next);
      try {
        await drainOnce(next);
      } catch (cause) {
        patchTarget(next, { activity: "error", error: publicLocalOutputError(cause) });
      }
    }
  })().finally(() => {
    drainRequest = null;
  });
  return drainRequest;
}

async function drainOnce(kind: LocalOutputKind) {
  await withTargetLock(kind, async () => {
    const settings = await persistence.readSettings(kind);
    if (!settings?.enabled) return;
    const permission = await queryDirectoryPermission(settings.handle);
    patchTarget(kind, { permission });
    if (permission !== "granted") return;

    const records = await persistence.listPending(settings.targetId);
    if (!records.length) {
      patchTarget(kind, { activity: "idle", pendingCount: 0, error: null });
      return;
    }
    patchTarget(kind, { activity: "saving", error: null });
    for (const record of records) {
      const claimed = await persistence.claim(record.key, writerOwnerId, Date.now());
      if (!claimed) continue;
      try {
        const savedName = await writeClaimedLocalOutput(settings.handle, claimed);
        patchTarget(kind, { lastSavedName: savedName });
      } catch (cause) {
        const message = publicLocalOutputError(cause);
        await persistence.release(claimed.key, writerOwnerId, message).catch(() => false);
        patchTarget(kind, { activity: "error", error: message });
        break;
      }
    }
    const pendingCount = await persistence.countPending(settings.targetId);
    patchTarget(kind, {
      pendingCount,
      activity: useLocalOutputStore.getState().targets[kind].activity === "error" ? "error" : "idle",
    });
  });
}

async function writeClaimedLocalOutput(handle: LocalDirectoryHandle, claimed: LocalOutputRecord) {
  let activeWriter: LocalFileWriter | null = null;
  let leaseError: Error | null = null;
  let renewalRequest: Promise<void> | null = null;
  let stopped = false;
  const loseLease = (cause: unknown) => {
    if (!leaseError) leaseError = cause instanceof Error ? cause : new Error("自动保存写入租约已失效");
    void activeWriter?.abort?.().catch(() => undefined);
  };
  const renewLease = () => {
    if (stopped || renewalRequest) return;
    const request = (async () => {
      try {
        if (!(await persistence.renew(claimed.key, writerOwnerId, Date.now()))) {
          loseLease(new Error("自动保存写入权已转移，将自动重试"));
        }
      } catch (cause) {
        loseLease(cause);
      }
    })();
    renewalRequest = request;
    void request.finally(() => {
      if (renewalRequest === request) renewalRequest = null;
    });
  };
  const renewalTimer = globalThis.setInterval(renewLease, WRITE_LEASE_RENEW_MS);
  try {
    let current = claimed;
    const fileName = await findAvailableLocalOutputFileName(handle, current);
    if (fileName !== current.fileName) {
      const updated = await persistence.updateFileName(current.key, writerOwnerId, fileName);
      if (!updated) throw new Error("自动保存写入权已转移，将自动重试");
      current = updated;
    }
    if (leaseError) throw leaseError;
    await writeLocalOutput(
      handle,
      current,
      (writer) => { activeWriter = writer; },
      () => { if (leaseError) throw leaseError; },
    );
    stopped = true;
    globalThis.clearInterval(renewalTimer);
    if (renewalRequest) await renewalRequest;
    if (leaseError) throw leaseError;
    if (!(await persistence.markSaved(current.key, writerOwnerId, Date.now()))) {
      throw new Error("自动保存写入权已转移，将自动重试");
    }
    return current.fileName;
  } catch (cause) {
    if (leaseError) throw leaseError;
    throw cause;
  } finally {
    stopped = true;
    globalThis.clearInterval(renewalTimer);
  }
}

async function writeLocalOutput(
  handle: LocalDirectoryHandle,
  record: LocalOutputRecord,
  setActiveWriter: (writer: LocalFileWriter | null) => void,
  assertLease: () => void,
) {
  let stored = await readMedia(record.media.id);
  if (!stored && record.media.source === "server") {
    await cacheServerMedia(record.media);
    stored = await readMedia(record.media.id);
  }
  if (!stored) throw new Error("生成结果尚未缓存，稍后可重试自动保存");
  assertLease();
  const file = await handle.getFileHandle(record.fileName, { create: true });
  assertLease();
  const writer = await file.createWritable();
  setActiveWriter(writer);
  try {
    assertLease();
    await writer.write(stored.blob);
    assertLease();
    await writer.close();
  } catch (cause) {
    await writer.abort?.().catch(() => undefined);
    throw cause;
  } finally {
    setActiveWriter(null);
  }
}

function createIndexedDbPersistence(): LocalOutputPersistence {
  return {
    readSettings: async (kind) => {
      const database = await openDatabase();
      let raw = await requestResult<unknown>(database.transaction(SETTINGS_STORE, "readonly").objectStore(SETTINGS_STORE).get(kind));
      if (!raw) raw = await requestResult<unknown>(database.transaction(SETTINGS_STORE, "readonly").objectStore(SETTINGS_STORE).get("active"));
      const settings = migrateLocalOutputSettings(raw, kind);
      if (settings && (!raw || (raw as { schemaVersion?: unknown }).schemaVersion !== 1 || (raw as { key?: unknown }).key !== kind)) {
        await writeSettingsRecord(database, settings);
      }
      return settings;
    },
    writeSettings: async (settings) => writeSettingsRecord(await openDatabase(), settings),
    deleteSettings: async (kind) => {
      const database = await openDatabase();
      await transactionDone(database.transaction(SETTINGS_STORE, "readwrite"), (transaction) => {
        const store = transaction.objectStore(SETTINGS_STORE);
        store.delete(kind);
        store.delete("active");
      });
    },
    enqueue: async (record) => {
      const database = await openDatabase();
      let inserted = false;
      const transaction = database.transaction(OUTPUT_STORE, "readwrite");
      const store = transaction.objectStore(OUTPUT_STORE);
      const existing = store.get(record.key);
      existing.onsuccess = () => {
        if (existing.result) return;
        store.add(record);
        inserted = true;
      };
      await transactionCompletion(transaction);
      return inserted;
    },
    listPending: async (targetId) => {
      const database = await openDatabase();
      const records = await requestResult<LocalOutputRecord[]>(database.transaction(OUTPUT_STORE, "readonly").objectStore(OUTPUT_STORE).index("targetId").getAll(targetId));
      return records.filter((record) => record.state !== "saved").sort((left, right) => left.artifactCreatedAt - right.artifactCreatedAt || left.key.localeCompare(right.key));
    },
    claim: async (key, ownerId, now) => mutateRecord(key, (record) => claimLocalOutputRecord(record, ownerId, now)),
    renew: async (key, ownerId, now) => Boolean(await mutateRecord(
      key,
      (record) => renewLocalOutputRecord(record, ownerId, now),
    )),
    updateFileName: async (key, ownerId, fileName) => mutateRecord(key, (record) => {
      if (record.state !== "writing" || record.leaseOwner !== ownerId) return null;
      return { ...record, fileName };
    }),
    markSaved: async (key, ownerId, savedAt) => Boolean(await mutateRecord(
      key,
      (record) => completeLocalOutputRecord(record, ownerId, savedAt),
    )),
    release: async (key, ownerId, error) => Boolean(await mutateRecord(key, (record) => {
      if (record.state !== "writing" || record.leaseOwner !== ownerId) return null;
      return { ...record, state: "pending", leaseOwner: null, leaseUntil: null, lastError: error };
    })),
    countPending: async (targetId) => {
      const records = await requestResult<LocalOutputRecord[]>((await openDatabase()).transaction(OUTPUT_STORE, "readonly").objectStore(OUTPUT_STORE).index("targetId").getAll(targetId));
      return records.filter((record) => record.state !== "saved").length;
    },
    movePending: async (sourceTargetId, target) => {
      const database = await openDatabase();
      const transaction = database.transaction([SETTINGS_STORE, OUTPUT_STORE], "readwrite");
      const settings = transaction.objectStore(SETTINGS_STORE);
      const outputs = transaction.objectStore(OUTPUT_STORE);
      let moved = 0;
      settings.put(target);
      settings.delete("active");
      const cursor = outputs.index("targetId").openCursor(sourceTargetId);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        const record = current.value as LocalOutputRecord;
        const next = migratePendingLocalOutputRecord(record, target);
        if (!next) {
          current.continue();
          return;
        }
        const existing = outputs.get(next.key);
        existing.onsuccess = () => {
          if (!existing.result) {
            outputs.put(next);
            moved += 1;
          }
          current.continue();
        };
      };
      await transactionCompletion(transaction);
      return moved;
    },
    deleteTarget: async (targetId) => {
      const database = await openDatabase();
      const transaction = database.transaction(OUTPUT_STORE, "readwrite");
      const cursor = transaction.objectStore(OUTPUT_STORE).index("targetId").openKeyCursor(targetId);
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current) return;
        transaction.objectStore(OUTPUT_STORE).delete(current.primaryKey);
        current.continue();
      };
      await transactionCompletion(transaction);
    },
  };
}

let databaseRequest: Promise<IDBDatabase> | null = null;

function openDatabase() {
  if (databaseRequest) return databaseRequest;
  databaseRequest = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SETTINGS_STORE)) database.createObjectStore(SETTINGS_STORE, { keyPath: "key" });
      if (!database.objectStoreNames.contains(OUTPUT_STORE)) {
        const outputs = database.createObjectStore(OUTPUT_STORE, { keyPath: "key" });
        outputs.createIndex("targetId", "targetId", { unique: false });
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        databaseRequest = null;
      };
      resolve(database);
    };
    request.onerror = () => {
      databaseRequest = null;
      reject(request.error ?? new Error("自动保存设置无法打开"));
    };
  });
  return databaseRequest;
}

async function writeSettingsRecord(database: IDBDatabase, settings: LocalOutputSettingsRecord) {
  await transactionDone(database.transaction(SETTINGS_STORE, "readwrite"), (transaction) => {
    transaction.objectStore(SETTINGS_STORE).put(settings);
  });
}

async function mutateRecord(
  key: string,
  update: (record: LocalOutputRecord) => LocalOutputRecord | null,
) {
  const database = await openDatabase();
  const transaction = database.transaction(OUTPUT_STORE, "readwrite");
  const store = transaction.objectStore(OUTPUT_STORE);
  let updated: LocalOutputRecord | null = null;
  const request = store.get(key);
  request.onsuccess = () => {
    const record = request.result as LocalOutputRecord | undefined;
    if (!record) return;
    updated = update(record);
    if (updated) store.put(updated);
  };
  await transactionCompletion(transaction);
  return updated;
}

function transactionDone(transaction: IDBTransaction, mutate: (transaction: IDBTransaction) => void) {
  mutate(transaction);
  return transactionCompletion(transaction);
}

function transactionCompletion(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("自动保存记录写入失败"));
    transaction.onabort = () => reject(transaction.error ?? new Error("自动保存记录写入中断"));
  });
}

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("自动保存记录读取失败"));
  });
}

function isLocalOutputArtifact(artifact: PublicGenerationJob["artifacts"][number]): artifact is GenerationMediaArtifact {
  return artifact.kind === "image" || artifact.kind === "video";
}

function mediaFromArtifact(artifact: GenerationMediaArtifact): CanvasMedia {
  return {
    id: artifact.mediaId,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    source: "server",
    serverId: artifact.mediaId,
    width: artifact.width ?? null,
    height: artifact.height ?? null,
    durationMs: artifact.duration ? Math.max(1, Math.round(artifact.duration * 1_000)) : null,
  };
}

function isDirectoryHandle(value: unknown): value is LocalDirectoryHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Partial<LocalDirectoryHandle>;
  return handle.kind === "directory" && typeof handle.name === "string" && typeof handle.getFileHandle === "function";
}

async function handlesMatch(left: LocalDirectoryHandle, right: LocalDirectoryHandle) {
  if (!right.isSameEntry) return false;
  try {
    return await right.isSameEntry(left);
  } catch {
    return false;
  }
}

async function queryDirectoryPermission(handle: LocalDirectoryHandle): Promise<LocalOutputPermission> {
  if (!handle.queryPermission) return "prompt";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

function localOutputKind(mimeType: string): LocalOutputKind | null {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  return null;
}

function extensionForMimeType(mimeType: string) {
  const known: Record<string, string> = {
    "image/avif": "avif",
    "image/gif": "gif",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "video/webm": "webm",
  };
  return known[mimeType.toLowerCase()] ?? (mimeType.startsWith("video/") ? "mp4" : "png");
}

async function localOutputFileExists(handle: LocalDirectoryHandle, fileName: string) {
  try {
    await handle.getFileHandle(fileName);
    return true;
  } catch (cause) {
    if (hasErrorName(cause, "NotFoundError")) return false;
    throw cause;
  }
}

function randomFileToken() {
  const bytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  }
  return `${stableHash(`${Date.now()}:${Math.random()}`)}${stableHash(`${Math.random()}:${Date.now()}`)}${stableHash(`${performance.now?.() ?? 0}:${Math.random()}`)}`;
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function createRuntimeId(prefix: string) {
  const id = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}:${id}`;
}

function isAbortError(cause: unknown) {
  return hasErrorName(cause, "AbortError");
}

function hasErrorName(cause: unknown, name: string) {
  return Boolean(cause && typeof cause === "object" && "name" in cause && (cause as { name?: unknown }).name === name);
}

function publicLocalOutputError(cause: unknown) {
  if (cause instanceof DOMException) {
    if (cause.name === "NotAllowedError") return "文件夹写入权限已失效，请重新授权";
    if (cause.name === "QuotaExceededError") return "本地磁盘空间不足，自动保存已暂停";
    if (cause.name === "NotFoundError") return "自动保存文件夹已不可用，请重新选择";
  }
  return cause instanceof Error && cause.message ? cause.message : "本地自动保存失败，请稍后重试";
}
