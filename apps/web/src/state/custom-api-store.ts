import type { GenerationReferences } from "../lib/generation-inputs";
import {
  modelModalitySchema,
  modelParameterTypeSchema,
  publicModelCatalogSchema,
  type ModelModality,
  type PublicModel,
} from "@weftcanvas/contracts";
import { create } from "zustand";

import {
  createSyntheticCustomModel,
  createSyntheticCustomRoute,
  customModelKey,
  CustomApiError,
  DEFAULT_CUSTOM_API_BASE_URL,
  GEMINI_CUSTOM_API_BASE_URL,
  executeCustomGeneration,
  normalizeCustomApiFormat,
  normalizeCustomApiBaseUrl,
  parseCustomModelKey,
  publicReferenceKinds,
  testCustomApiConnection,
  type CustomApiCatalog,
  type CustomApiConnection,
  type CustomApiRoute,
  type CustomApiRouteParameter,
} from "../lib/custom-api";
import { resolveCanvasApiAccess } from "../lib/canvas-api-access";
import { beginBrowserGeneration, endBrowserGeneration } from "../lib/browser-generation-runtime";
import { composeModelParameters } from "../lib/generation-config";
import { prepareCustomGenerationInputs } from "../lib/generation-inputs";
import { findCanvasGenerationNode, useCanvasStore } from "./canvas-store";
import { useIdentityStore } from "./identity-store";
import { enqueueGeneratedMedia } from "./local-output-store";
import { useToastStore } from "./toast-store";
import { useWalletStore } from "./wallet-store";

const LEGACY_STORAGE_KEY = "weftcanvas:custom-api:v1";
const LEGACY_CATALOG_STORAGE_KEY = "weftcanvas:custom-api-catalog:v1";
export const CUSTOM_API_STORAGE_KEY = "weftcanvas:custom-api:v2";
export const CUSTOM_API_CATALOG_STORAGE_KEY = "weftcanvas:custom-api-catalog:v2";
const CATALOG_REFRESH_INTERVAL_MS = 60_000;
const CATALOG_MAX_STALE_MS = 7 * 24 * 60 * 60_000;
const LEGACY_PROFILE_ID = "legacy";
const MODEL_MODALITIES: ModelModality[] = ["text", "image", "video", "audio"];

export type CustomApiCatalogStatus = "idle" | "loading" | "ready" | "error";

export type CustomApiProfile = {
  id: string;
  name: string;
  connection: CustomApiConnection;
  enabled: boolean;
  status: CustomApiCatalogStatus;
  connecting: boolean;
  refreshing: boolean;
  catalog: CustomApiCatalog | null;
  error: string | null;
  loadedAt: number;
  availableModelIds: string[];
  manualModelModalities: Record<string, ModelModality[]>;
};

export type CustomApiModelChoice = {
  key: string;
  profileId: string;
  profileName: string;
  catalogModelId: string;
  rawModelId: string;
  model: PublicModel;
  route: CustomApiRoute | null;
  executable: boolean;
  unsupportedReason: string | null;
};

type CustomApiProfileInput = {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  apiFormat?: CustomApiConnection["apiFormat"];
  enabled?: boolean;
};

type CustomApiState = {
  profiles: CustomApiProfile[];
  activeProfileId: string | null;
  hiddenModelKeys: string[];
  dialogOpen: boolean;

  // Compatibility aliases for the existing single-connection UI. New code
  // should read profiles and select a source by its namespaced model key.
  connection: CustomApiConnection | null;
  status: CustomApiCatalogStatus;
  connecting: boolean;
  refreshing: boolean;
  catalog: CustomApiCatalog | null;
  error: string | null;
  loadedAt: number;

  openDialog: () => void;
  openProfileDialog: (profileId: string) => void;
  closeDialog: () => void;
  setActiveProfile: (profileId: string | null) => void;
  addProfile: (input?: CustomApiProfileInput) => string;
  updateProfile: (profileId: string, patch: CustomApiProfileInput) => void;
  configureProfile: (profileId: string, connection: CustomApiConnection) => Promise<boolean>;
  removeProfile: (profileId: string) => void;
  pullProfileModels: (profileId: string, force?: boolean) => Promise<CustomApiCatalog | null>;
  pullAllProfiles: (force?: boolean) => Promise<void>;
  assignProfileModelModality: (
    profileId: string,
    rawModelId: string,
    modality: ModelModality,
    assigned: boolean,
  ) => void;
  setModelVisible: (modelKey: string, visible: boolean) => void;
  toggleModelVisibility: (modelKey: string) => void;
  isModelVisible: (modelKey: string) => boolean;

  configure: (connection: CustomApiConnection) => Promise<boolean>;
  disconnect: () => void;
  loadCatalog: (force?: boolean) => Promise<CustomApiCatalog | null>;
  runGeneration: (input: {
    nodeId: string;
    model: PublicModel;
    modality: ModelModality;
    body: string;
    parameters: Record<string, unknown>;
    references: GenerationReferences;
  }) => string;
};

type PersistedProfile = {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  apiFormat: CustomApiConnection["apiFormat"];
  enabled: boolean;
  availableModelIds: string[];
  manualModelModalities: Record<string, ModelModality[]>;
};

const catalogRequests = new Map<string, Promise<CustomApiCatalog | null>>();
const configurationRequests = new Map<string, string>();
const initialState = readInitialState();

export const useCustomApiStore = create<CustomApiState>((set, get) => {
  const commit = (
    update: (state: CustomApiState) => Partial<CustomApiState>,
    options: { catalogs?: boolean } = {},
  ) => {
    set((state) => {
      const next = withCompatibilityAliases({ ...state, ...update(state) });
      writePersistedState(next);
      if (options.catalogs) writeCatalogCaches(next.profiles);
      return next;
    });
  };

  const configureProfile = async (profileId: string, value: CustomApiConnection) => {
    let connection: CustomApiConnection;
    try {
      connection = normalizeConnection(value);
    } catch (cause) {
      commit((state) => ({
        profiles: patchProfile(state.profiles, profileId, { error: publicError(cause) }),
      }));
      return false;
    }
    const before = get().profiles.find((profile) => profile.id === profileId);
    if (!before) return false;
    const previousIdentity = connectionIdentity(before.connection);
    const requestIdentity = connectionIdentity(connection);
    configurationRequests.set(profileId, requestIdentity);
    commit((state) => ({
      profiles: patchProfile(state.profiles, profileId, {
        status: state.profiles.find((profile) => profile.id === profileId)?.catalog
          ? "ready"
          : "loading",
        connecting: true,
        refreshing: false,
        error: null,
      }),
      activeProfileId: profileId,
    }));
    try {
      const catalog = await testCustomApiConnection(connection);
      const current = get().profiles.find((profile) => profile.id === profileId);
      if (
        !current ||
        configurationRequests.get(profileId) !== requestIdentity ||
        connectionIdentity(current.connection) !== previousIdentity
      )
        return false;
      const loadedAt = Date.now();
      catalogRequests.delete(profileId);
      commit(
        (state) => ({
          profiles: patchProfile(state.profiles, profileId, {
            connection,
            catalog,
            status: "ready",
            connecting: false,
            refreshing: false,
            error: null,
            loadedAt,
            availableModelIds: catalog.availableModelIds,
            manualModelModalities: mergeRichModelModalities(current.manualModelModalities, catalog),
          }),
          activeProfileId: profileId,
        }),
        { catalogs: true },
      );
      configurationRequests.delete(profileId);
      return true;
    } catch (cause) {
      const current = get().profiles.find((profile) => profile.id === profileId);
      if (
        current &&
        configurationRequests.get(profileId) === requestIdentity &&
        connectionIdentity(current.connection) === previousIdentity
      ) {
        commit((state) => ({
          profiles: patchProfile(state.profiles, profileId, {
            status: current.catalog ? "ready" : "error",
            connecting: false,
            refreshing: false,
            error: publicError(cause),
          }),
        }));
        configurationRequests.delete(profileId);
      }
      return false;
    }
  };

  const pullProfileModels = async (
    profileId: string,
    force = false,
  ): Promise<CustomApiCatalog | null> => {
    const profile = get().profiles.find((item) => item.id === profileId);
    if (!profile || !profile.enabled) return null;
    if (!force && profile.catalog && Date.now() - profile.loadedAt < CATALOG_REFRESH_INTERVAL_MS)
      return profile.catalog;
    const running = catalogRequests.get(profileId);
    if (running) return running;
    const connection = profile.connection;
    const requestIdentity = connectionIdentity(connection);
    commit((state) => ({
      profiles: patchProfile(state.profiles, profileId, {
        status: profile.catalog ? "ready" : "loading",
        refreshing: true,
        error: null,
      }),
    }));
    const request = testCustomApiConnection(connection)
      .then((catalog) => {
        const current = get().profiles.find((item) => item.id === profileId);
        if (!current || connectionIdentity(current.connection) !== requestIdentity)
          return current?.catalog ?? null;
        const loadedAt = Date.now();
        commit(
          (state) => ({
            profiles: patchProfile(state.profiles, profileId, {
              catalog,
              status: "ready",
              refreshing: false,
              error: null,
              loadedAt,
              availableModelIds: catalog.availableModelIds,
              manualModelModalities: mergeRichModelModalities(
                current.manualModelModalities,
                catalog,
              ),
            }),
          }),
          { catalogs: true },
        );
        return catalog;
      })
      .catch((cause) => {
        const current = get().profiles.find((item) => item.id === profileId);
        if (!current || connectionIdentity(current.connection) !== requestIdentity)
          return current?.catalog ?? null;
        commit((state) => ({
          profiles: patchProfile(state.profiles, profileId, {
            status: current.catalog ? "ready" : "error",
            refreshing: false,
            error: publicError(cause),
          }),
        }));
        return current.catalog;
      })
      .finally(() => {
        if (catalogRequests.get(profileId) === request) catalogRequests.delete(profileId);
      });
    catalogRequests.set(profileId, request);
    return request;
  };

  return withCompatibilityAliases({
    profiles: initialState.profiles,
    activeProfileId: initialState.activeProfileId,
    hiddenModelKeys: initialState.hiddenModelKeys,
    dialogOpen: false,
    connection: null,
    status: "idle",
    connecting: false,
    refreshing: false,
    catalog: null,
    error: null,
    loadedAt: 0,

    openDialog: () => set({ dialogOpen: true, error: null }),
    openProfileDialog: (profileId) => {
      if (!get().profiles.some((profile) => profile.id === profileId)) return;
      commit(() => ({ dialogOpen: true, activeProfileId: profileId }));
    },
    closeDialog: () => set({ dialogOpen: false }),
    setActiveProfile: (profileId) => {
      const nextId =
        profileId && get().profiles.some((profile) => profile.id === profileId) ? profileId : null;
      commit(() => ({ activeProfileId: nextId }));
    },
    addProfile: (input = {}) => {
      const id = createProfileId(get().profiles);
      const profile = createProfile(id, input);
      commit((state) => ({ profiles: [...state.profiles, profile], activeProfileId: id }));
      return id;
    },
    updateProfile: (profileId, patch) => {
      const current = get().profiles.find((profile) => profile.id === profileId);
      if (!current) return;
      configurationRequests.delete(profileId);
      // Keep URL editing as a draft. Validation and normalization happen when
      // the user explicitly pulls models, so controlled inputs never reject a
      // partially typed address.
      const connection = {
        baseUrl: patch.baseUrl === undefined ? current.connection.baseUrl : patch.baseUrl,
        apiKey: patch.apiKey === undefined ? current.connection.apiKey : patch.apiKey,
        apiFormat:
          patch.apiFormat === undefined
            ? current.connection.apiFormat
            : normalizeCustomApiFormat(patch.apiFormat),
      };
      const connectionChanged = !sameConnection(connection, current.connection);
      commit(
        (state) => ({
          profiles: patchProfile(state.profiles, profileId, {
            name:
              patch.name === undefined
                ? current.name
                : normalizedProfileName(patch.name, current.name),
            enabled: patch.enabled ?? current.enabled,
            connection,
            ...(connectionChanged
              ? {
                  catalog: null,
                  status: "idle" as const,
                  error: null,
                  loadedAt: 0,
                  availableModelIds: [],
                }
              : {}),
          }),
        }),
        { catalogs: connectionChanged },
      );
    },
    configureProfile,
    removeProfile: (profileId) => {
      catalogRequests.delete(profileId);
      configurationRequests.delete(profileId);
      commit(
        (state) => {
          const profiles = state.profiles.filter((profile) => profile.id !== profileId);
          const activeProfileId =
            state.activeProfileId === profileId ? (profiles[0]?.id ?? null) : state.activeProfileId;
          const prefix = `custom:${encodeURIComponent(profileId)}:`;
          return {
            profiles,
            activeProfileId,
            hiddenModelKeys: state.hiddenModelKeys.filter((key) => !key.startsWith(prefix)),
          };
        },
        { catalogs: true },
      );
    },
    pullProfileModels,
    pullAllProfiles: async (force = false) => {
      const profileIds = get()
        .profiles.filter((profile) => profile.enabled)
        .map((profile) => profile.id);
      await Promise.allSettled(profileIds.map((profileId) => pullProfileModels(profileId, force)));
    },
    assignProfileModelModality: (profileId, rawModelIdValue, modality, assigned) => {
      const rawModelId = rawModelIdValue.trim();
      if (!rawModelId || !modelModalitySchema.safeParse(modality).success) return;
      commit((state) => {
        const profile = state.profiles.find((item) => item.id === profileId);
        if (!profile || !profile.availableModelIds.includes(rawModelId)) return {};
        const current = profile.manualModelModalities[rawModelId] ?? [];
        const next = assigned
          ? uniqueModalities([...current, modality])
          : current.filter((item) => item !== modality);
        return {
          profiles: patchProfile(state.profiles, profileId, {
            manualModelModalities: { ...profile.manualModelModalities, [rawModelId]: next },
          }),
        };
      });
    },
    setModelVisible: (modelKey, visible) => {
      commit((state) => ({
        hiddenModelKeys: setVisibility(state.hiddenModelKeys, modelKey, visible),
      }));
    },
    toggleModelVisibility: (modelKey) => {
      commit((state) => ({
        hiddenModelKeys: setVisibility(
          state.hiddenModelKeys,
          modelKey,
          state.hiddenModelKeys.includes(modelKey),
        ),
      }));
    },
    isModelVisible: (modelKey) => !get().hiddenModelKeys.includes(modelKey),

    configure: async (connection) => {
      let profileId = get().activeProfileId ?? get().profiles[0]?.id ?? null;
      if (!profileId)
        profileId = get().addProfile({
          baseUrl: connection.baseUrl,
          apiKey: connection.apiKey,
          apiFormat: connection.apiFormat,
          name: "自有 API",
        });
      const configured = await configureProfile(profileId, connection);
      if (configured) set({ dialogOpen: false });
      return configured;
    },
    disconnect: () => {
      const profileId = get().activeProfileId ?? get().profiles[0]?.id;
      if (profileId) get().removeProfile(profileId);
    },
    loadCatalog: (force = false) => {
      const profileId = get().activeProfileId ?? get().profiles[0]?.id;
      return profileId ? pullProfileModels(profileId, force) : Promise.resolve(null);
    },
    runGeneration: (input) => runCustomGeneration(get(), input),
  });
});

export function getCustomModelChoices(
  state: Pick<CustomApiState, "profiles" | "hiddenModelKeys">,
  modality: ModelModality,
  includeHidden = false,
) {
  const choices: CustomApiModelChoice[] = [];
  for (const profile of state.profiles) {
    if (!profile.enabled) continue;
    const coveredRawIds = new Set<string>();
    for (const catalogModel of profile.catalog?.models ?? []) {
      if (catalogModel.modality !== modality) continue;
      const route = profile.catalog?.routes[catalogModel.id];
      if (!route) continue;
      const assigned =
        profile.manualModelModalities[route.sourceModelId]?.includes(modality) ?? false;
      if (!assigned) continue;
      if (coveredRawIds.has(route.sourceModelId)) continue;
      coveredRawIds.add(route.sourceModelId);
      const key = customModelKey(profile.id, modality, route.sourceModelId);
      if (!includeHidden && state.hiddenModelKeys.includes(key)) continue;
      choices.push(
        createChoice(profile, key, catalogModel.id, route.sourceModelId, catalogModel, route),
      );
    }
    const syntheticIds = profile.availableModelIds
      .filter((rawModelId) => !coveredRawIds.has(rawModelId))
      .filter((rawModelId) => profile.manualModelModalities[rawModelId]?.includes(modality))
      .sort((left, right) => left.localeCompare(right));
    for (const rawModelId of syntheticIds) {
      const key = customModelKey(profile.id, modality, rawModelId);
      if (!includeHidden && state.hiddenModelKeys.includes(key)) continue;
      const model = createSyntheticCustomModel(rawModelId, modality);
      const route = createSyntheticCustomRoute(rawModelId, modality);
      choices.push(createChoice(profile, key, rawModelId, rawModelId, model, route));
    }
  }
  return choices;
}

export function getMergedModels(
  platformModels: PublicModel[],
  modality: ModelModality,
  profiles: CustomApiProfile[],
  hiddenModelKeys: string[],
) {
  const platform = platformModels.filter(
    (model) => model.modality === modality && !hiddenModelKeys.includes(model.id),
  );
  const custom = getCustomModelChoices({ profiles, hiddenModelKeys }, modality).map(
    (choice) => choice.model,
  );
  return [...platform, ...custom];
}

export function getModelSourceLabel(modelKey: string, profiles: CustomApiProfile[]) {
  const parsed = parseCustomModelKey(modelKey);
  if (!parsed) return "内置";
  return profiles.find((profile) => profile.id === parsed.profileId)?.name ?? "已移除的 API";
}

export function resolveCustomModelChoice(
  state: Pick<CustomApiState, "profiles" | "hiddenModelKeys"> &
    Partial<Pick<CustomApiState, "activeProfileId">>,
  modelKey: string,
  expectedModality?: ModelModality,
): CustomApiModelChoice | null {
  const parsed = parseCustomModelKey(modelKey);
  if (parsed) {
    if (expectedModality && parsed.modality !== expectedModality) return null;
    return (
      getCustomModelChoices(state, parsed.modality, true).find(
        (choice) => choice.key === modelKey,
      ) ?? null
    );
  }
  // A v1 project contains only a bare public id. Preserve the historical
  // active-profile behavior without rewriting that node behind the user's back.
  const active = state.activeProfileId
    ? state.profiles.find((profile) => profile.id === state.activeProfileId)
    : null;
  const profiles = active
    ? [active, ...state.profiles.filter((profile) => profile.id !== active.id)]
    : state.profiles;
  for (const profile of profiles) {
    const catalogModel = profile.catalog?.models.find(
      (model) =>
        model.id === modelKey && (!expectedModality || model.modality === expectedModality),
    );
    if (!catalogModel) continue;
    const route = profile.catalog?.routes[catalogModel.id];
    if (!route) continue;
    return createChoice(
      profile,
      modelKey,
      catalogModel.id,
      route.sourceModelId,
      catalogModel,
      route,
    );
  }
  return null;
}

function createChoice(
  profile: CustomApiProfile,
  key: string,
  catalogModelId: string,
  rawModelId: string,
  sourceModel: PublicModel,
  route: CustomApiRoute | null,
): CustomApiModelChoice {
  const executable = route !== null;
  return {
    key,
    profileId: profile.id,
    profileName: profile.name,
    catalogModelId,
    rawModelId,
    model: {
      ...sourceModel,
      id: key,
      label: `${sourceModel.label} · ${profile.name}`,
    },
    route,
    executable,
    unsupportedReason: executable ? null : "当前模型没有已配置的兼容调用协议",
  };
}

function runCustomGeneration(
  state: CustomApiState,
  input: {
    nodeId: string;
    model: PublicModel;
    modality: ModelModality;
    body: string;
    parameters: Record<string, unknown>;
    references: GenerationReferences;
  },
) {
  const identityStatus = useIdentityStore.getState().status;
  const walletMembership = useWalletStore.getState().summary?.membership ?? null;
  const access = resolveCanvasApiAccess({
    authenticated: identityStatus === "authenticated",
    membership: walletMembership,
  });
  if (!access.allowed)
    throw new CustomApiError("需要标准会员才能使用画布 API", "CANVAS_API_MEMBERSHIP_REQUIRED");
  const choice = resolveCustomModelChoice(state, input.model.id, input.modality);
  if (!choice)
    throw new CustomApiError(
      "所选模型来源已移除或当前不可用，请重新选择",
      "MODEL_SOURCE_UNAVAILABLE",
    );
  if (state.hiddenModelKeys.includes(choice.key))
    throw new CustomApiError("所选模型已从节点可选项中停用，请重新选择", "MODEL_HIDDEN");
  if (!choice.executable || !choice.route)
    throw new CustomApiError(
      choice.unsupportedReason ?? "当前模型暂不支持直接生成",
      "MODEL_EXECUTION_UNSUPPORTED",
    );
  const profile = state.profiles.find((item) => item.id === choice.profileId);
  if (!profile?.enabled)
    throw new CustomApiError("所选 API 配置已停用，请重新选择", "API_PROFILE_DISABLED");
  if (input.model.modality !== input.modality)
    throw new CustomApiError("所选模型类型与节点不一致", "MODEL_MODALITY_MISMATCH");
  const executionModel = { ...choice.model, id: choice.catalogModelId, label: input.model.label };

  const jobId = `browser:${crypto.randomUUID()}`;
  const createdAt = new Date().toISOString();
  const canvas = useCanvasStore.getState();
  const node = canvas.nodes.find((item) => item.id === input.nodeId);
  if (!node) throw new CustomApiError("节点已不存在", "NODE_NOT_FOUND");
  canvas.applyGenerationUpdate(input.nodeId, {
    status: "running",
    progress: 2,
    generation: {
      ...node.data.generation,
      modelId: input.model.id,
      jobId,
      jobVersion: 1,
      jobCreatedAt: createdAt,
      jobStatus: "running",
      error: null,
    },
  });
  beginBrowserGeneration(jobId);

  void (async () => {
    try {
      const prepared = await prepareCustomGenerationInputs(
        input.references,
        publicReferenceKinds(choice.route!),
      );
      updateProgress(input.nodeId, jobId, 6);
      const result = await executeCustomGeneration({
        connection: profile.connection,
        model: executionModel,
        route: choice.route!,
        parameters: composeModelParameters(executionModel, input.body, input.parameters),
        inputs: prepared,
        onProgress: (progress) => updateProgress(input.nodeId, jobId, progress),
      });
      completeGeneration(input.nodeId, jobId, input.model.id, createdAt, result);
      useToastStore.getState().show("生成完成", "success");
    } catch (cause) {
      failGeneration(input.nodeId, jobId, cause);
      useToastStore.getState().show(publicError(cause), "error");
    } finally {
      endBrowserGeneration(jobId);
    }
  })();
  return jobId;
}

function updateProgress(nodeId: string, jobId: string, progress: number) {
  const canvas = useCanvasStore.getState();
  canvas.applyGenerationUpdate(
    nodeId,
    (node) => ({
      status: "running",
      progress: Math.max(0, Math.min(99, Math.round(progress))),
      generation: {
        ...node.data.generation,
        jobVersion: (node.data.generation.jobVersion ?? 1) + 1,
        jobStatus: "running",
      },
    }),
    { expectedJobId: jobId },
  );
}

function completeGeneration(
  nodeId: string,
  jobId: string,
  modelId: string,
  createdAt: string,
  result: Awaited<ReturnType<typeof executeCustomGeneration>>,
) {
  let canvas = useCanvasStore.getState();
  let node = findGenerationNode(canvas, nodeId);
  if (!node || node.data.generation.jobId !== jobId) return;
  const generation = {
    ...node.data.generation,
    modelId,
    jobId,
    jobVersion: (node.data.generation.jobVersion ?? 1) + 1,
    jobCreatedAt: createdAt,
    jobStatus: "completed" as const,
    error: null,
  };

  if (result.text !== undefined) {
    canvas.applyGenerationUpdate(
      nodeId,
      {
        body: result.text,
        media: null,
        status: "success",
        progress: null,
        generation,
      },
      { result: "text" },
    );
    return;
  }

  const [primary, ...additional] = result.media ?? [];
  if (!primary) throw new CustomApiError("生成完成但没有可用结果", "RESULT_EMPTY");
  const completedAt = Date.now();
  canvas.applyGenerationUpdate(
    nodeId,
    {
      media: primary,
      status: "success",
      progress: null,
      generation,
    },
    { result: "media" },
  );
  void enqueueGeneratedMedia({
    outputKey: `${jobId}:${primary.id}`,
    createdAt: completedAt,
    media: primary,
  });
  canvas = useCanvasStore.getState();
  node = findGenerationNode(canvas, nodeId);
  for (const media of additional) {
    void enqueueGeneratedMedia({
      outputKey: `${jobId}:${media.id}`,
      createdAt: completedAt,
      media,
    });
    useCanvasStore.getState().addGeneratedConnectedNode(nodeId, inputKindForMedia(media.mimeType), {
      body: node?.data.body ?? "",
      media,
      status: "success",
      progress: null,
      generation,
    });
  }
}

function failGeneration(nodeId: string, jobId: string, cause: unknown) {
  const canvas = useCanvasStore.getState();
  canvas.applyGenerationUpdate(
    nodeId,
    (node) => ({
      status: "error",
      progress: null,
      generation: {
        ...node.data.generation,
        jobVersion: (node.data.generation.jobVersion ?? 1) + 1,
        jobStatus: "failed",
        error: publicError(cause),
      },
    }),
    { expectedJobId: jobId },
  );
}

function findGenerationNode(canvas: ReturnType<typeof useCanvasStore.getState>, nodeId: string) {
  return findCanvasGenerationNode(canvas, nodeId) ?? null;
}

function inputKindForMedia(mimeType: string): "image" | "video" | "audio" {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "image";
}

function readInitialState() {
  const v2 = readPersistedV2();
  if (v2) return v2;
  const migrated = readLegacyState();
  if (!migrated)
    return {
      profiles: [] as CustomApiProfile[],
      activeProfileId: null,
      hiddenModelKeys: [] as string[],
    };
  const persisted = writeInitialMigration(migrated);
  if (persisted) {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    localStorage.removeItem(LEGACY_CATALOG_STORAGE_KEY);
  }
  return migrated;
}

function readPersistedV2() {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_API_STORAGE_KEY) || "null") as {
      version?: unknown;
      activeProfileId?: unknown;
      hiddenModelKeys?: unknown;
      profiles?: unknown;
    } | null;
    if (value?.version !== 2 || !Array.isArray(value.profiles)) return null;
    const caches = readCatalogCaches();
    const profiles = value.profiles.flatMap((item) => {
      const persisted = parsePersistedProfile(item);
      if (!persisted) return [];
      const cached = caches[persisted.id];
      const catalog =
        cached?.baseUrl === persisted.baseUrl &&
        normalizeCustomApiFormat(cached.apiFormat) ===
          normalizeCustomApiFormat(persisted.apiFormat) &&
        Date.now() - cached.storedAt <= CATALOG_MAX_STALE_MS
          ? cached.catalog
          : null;
      return [hydrateProfile(persisted, catalog, cached?.storedAt ?? 0)];
    });
    const requestedActiveId =
      typeof value.activeProfileId === "string" ? value.activeProfileId : null;
    const activeProfileId = profiles.some((profile) => profile.id === requestedActiveId)
      ? requestedActiveId
      : (profiles[0]?.id ?? null);
    return {
      profiles,
      activeProfileId,
      hiddenModelKeys: uniqueStrings(
        Array.isArray(value.hiddenModelKeys) ? value.hiddenModelKeys : [],
      ),
    };
  } catch {
    return null;
  }
}

function readLegacyState() {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = JSON.parse(
      localStorage.getItem(LEGACY_STORAGE_KEY) || "null",
    ) as Partial<CustomApiConnection> | null;
    if (!value?.baseUrl || !value.apiKey) return null;
    const connection = normalizeConnection({
      baseUrl: value.baseUrl,
      apiKey: value.apiKey,
      apiFormat: value.apiFormat,
    });
    const cached = readLegacyCatalogCache(connection.baseUrl);
    const catalog = cached?.catalog ?? null;
    const availableModelIds = catalog?.availableModelIds ?? [];
    const profile = hydrateProfile(
      {
        id: LEGACY_PROFILE_ID,
        name: "自有 API",
        baseUrl: connection.baseUrl,
        apiKey: connection.apiKey,
        apiFormat: connection.apiFormat,
        enabled: true,
        availableModelIds,
        manualModelModalities: catalog ? mergeRichModelModalities({}, catalog) : {},
      },
      catalog,
      cached?.storedAt ?? 0,
    );
    return { profiles: [profile], activeProfileId: profile.id, hiddenModelKeys: [] as string[] };
  } catch {
    return null;
  }
}

function writeInitialMigration(state: {
  profiles: CustomApiProfile[];
  activeProfileId: string | null;
  hiddenModelKeys: string[];
}) {
  try {
    localStorage.setItem(CUSTOM_API_STORAGE_KEY, JSON.stringify(serializeState(state)));
    writeCatalogCaches(state.profiles);
    return true;
  } catch {
    return false;
  }
}

function writePersistedState(
  state: Pick<CustomApiState, "profiles" | "activeProfileId" | "hiddenModelKeys">,
) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(CUSTOM_API_STORAGE_KEY, JSON.stringify(serializeState(state)));
  } catch {
    // An in-memory profile remains usable when browser storage is unavailable.
  }
}

function serializeState(
  state: Pick<CustomApiState, "profiles" | "activeProfileId" | "hiddenModelKeys">,
) {
  return {
    version: 2,
    activeProfileId: state.activeProfileId,
    hiddenModelKeys: uniqueStrings(state.hiddenModelKeys),
    profiles: state.profiles.map((profile): PersistedProfile => ({
      id: profile.id,
      name: profile.name,
      baseUrl: profile.connection.baseUrl,
      apiKey: profile.connection.apiKey,
      apiFormat: normalizeCustomApiFormat(profile.connection.apiFormat),
      enabled: profile.enabled,
      availableModelIds: profile.availableModelIds,
      manualModelModalities: profile.manualModelModalities,
    })),
  };
}

function readCatalogCaches() {
  const result: Record<
    string,
    {
      baseUrl: string;
      apiFormat?: CustomApiConnection["apiFormat"];
      storedAt: number;
      catalog: CustomApiCatalog;
    }
  > = {};
  try {
    const value = JSON.parse(localStorage.getItem(CUSTOM_API_CATALOG_STORAGE_KEY) || "null") as {
      version?: unknown;
      profiles?: unknown;
    } | null;
    if (value?.version !== 2 || !value.profiles || typeof value.profiles !== "object")
      return result;
    for (const [profileId, item] of Object.entries(value.profiles as Record<string, unknown>)) {
      if (!item || typeof item !== "object") continue;
      const record = item as {
        baseUrl?: unknown;
        apiFormat?: unknown;
        storedAt?: unknown;
        catalog?: unknown;
      };
      if (typeof record.baseUrl !== "string" || typeof record.storedAt !== "number") continue;
      const catalog = parseCachedCatalog(record.catalog);
      if (catalog)
        result[profileId] = {
          baseUrl: record.baseUrl,
          apiFormat: normalizeCustomApiFormat(record.apiFormat),
          storedAt: record.storedAt,
          catalog,
        };
    }
  } catch {
    // Invalid cache entries are ignored independently from credential state.
  }
  return result;
}

function writeCatalogCaches(profiles: CustomApiProfile[]) {
  if (typeof localStorage === "undefined") return;
  try {
    const entries = Object.fromEntries(
      profiles.flatMap((profile) =>
        profile.catalog
          ? [
              [
                profile.id,
                {
                  baseUrl: profile.connection.baseUrl,
                  apiFormat: normalizeCustomApiFormat(profile.connection.apiFormat),
                  storedAt: profile.loadedAt,
                  catalog: profile.catalog,
                },
              ],
            ]
          : [],
      ),
    );
    localStorage.setItem(
      CUSTOM_API_CATALOG_STORAGE_KEY,
      JSON.stringify({ version: 2, profiles: entries }),
    );
  } catch {
    // A full local-storage quota must not interrupt an otherwise valid pull.
  }
}

function readLegacyCatalogCache(origin: string) {
  try {
    const stored = JSON.parse(localStorage.getItem(LEGACY_CATALOG_STORAGE_KEY) || "null") as {
      origin?: unknown;
      storedAt?: unknown;
      catalog?: unknown;
    } | null;
    if (!stored || stored.origin !== origin || typeof stored.storedAt !== "number") return null;
    if (Date.now() - stored.storedAt > CATALOG_MAX_STALE_MS) return null;
    const catalog = parseCachedCatalog(stored.catalog);
    return catalog ? { catalog, storedAt: stored.storedAt } : null;
  } catch {
    return null;
  }
}

function parseCachedCatalog(value: unknown): CustomApiCatalog | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const publicCatalog = publicModelCatalogSchema.safeParse(value);
  if (!publicCatalog.success || !source.routes || typeof source.routes !== "object") return null;
  const routes: Record<string, CustomApiRoute> = {};
  for (const model of publicCatalog.data.models) {
    const route = parseCachedRoute((source.routes as Record<string, unknown>)[model.id]);
    if (!route || route.modality !== model.modality) return null;
    routes[model.id] = route;
  }
  const inferredIds = Object.values(routes).map((route) => route.sourceModelId);
  const availableModelIds = uniqueStrings(
    Array.isArray(source.availableModelIds) ? source.availableModelIds : inferredIds,
  );
  const capabilitySource = source.capabilitySource === "models-only" ? "models-only" : "rich";
  return {
    ...publicCatalog.data,
    apiFormat: normalizeCustomApiFormat(source.apiFormat),
    routes,
    availableModelIds,
    capabilitySource,
    catalogWarning: typeof source.catalogWarning === "string" ? source.catalogWarning : null,
  };
}

function parseCachedRoute(value: unknown): CustomApiRoute | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.sourceModelId !== "string" || !source.sourceModelId.trim()) return null;
  const modality = modelModalitySchema.safeParse(source.modality);
  if (!modality.success) return null;
  if (typeof source.endpointPath !== "string" || !source.endpointPath.startsWith("/")) return null;
  if (!Array.isArray(source.parameters)) return null;
  const parameters: CustomApiRouteParameter[] = [];
  for (const value of source.parameters) {
    if (!value || typeof value !== "object") return null;
    const parameter = value as Record<string, unknown>;
    if (typeof parameter.name !== "string" || !parameter.name) return null;
    if (typeof parameter.path !== "string" || !parameter.path) return null;
    const type = modelParameterTypeSchema.safeParse(parameter.type);
    if (!type.success) return null;
    if (parameter.format !== undefined && typeof parameter.format !== "string") return null;
    if (parameter.itemsFormat !== undefined && typeof parameter.itemsFormat !== "string")
      return null;
    parameters.push({
      name: parameter.name,
      path: parameter.path,
      type: type.data,
      ...(Object.hasOwn(parameter, "fixed") ? { fixed: parameter.fixed } : {}),
      ...(typeof parameter.format === "string" ? { format: parameter.format } : {}),
      ...(typeof parameter.itemsFormat === "string" ? { itemsFormat: parameter.itemsFormat } : {}),
    });
  }
  return {
    sourceModelId: source.sourceModelId,
    modality: modality.data,
    endpointPath: source.endpointPath,
    parameters,
  };
}

function parsePersistedProfile(value: unknown): PersistedProfile | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (typeof source.id !== "string" || !source.id.trim()) return null;
  if (typeof source.baseUrl !== "string" || typeof source.apiKey !== "string") return null;
  return {
    id: source.id,
    name: normalizedProfileName(typeof source.name === "string" ? source.name : "", "自有 API"),
    // Draft profiles may contain a partially typed URL. Pulling models is the
    // explicit validation boundary; keeping the draft avoids deleting an
    // entire profile after a reload midway through editing.
    baseUrl: source.baseUrl,
    apiKey: source.apiKey,
    apiFormat: normalizeCustomApiFormat(source.apiFormat),
    enabled: source.enabled !== false,
    availableModelIds: uniqueStrings(
      Array.isArray(source.availableModelIds) ? source.availableModelIds : [],
    ),
    manualModelModalities: parseManualModelModalities(source.manualModelModalities),
  };
}

function hydrateProfile(
  persisted: PersistedProfile,
  catalog: CustomApiCatalog | null,
  loadedAt: number,
): CustomApiProfile {
  return {
    id: persisted.id,
    name: persisted.name,
    connection: {
      baseUrl: persisted.baseUrl,
      apiKey: persisted.apiKey,
      apiFormat: normalizeCustomApiFormat(persisted.apiFormat),
    },
    enabled: persisted.enabled,
    status: catalog ? "ready" : "idle",
    connecting: false,
    refreshing: false,
    catalog,
    error: null,
    loadedAt: catalog ? loadedAt : 0,
    availableModelIds: persisted.availableModelIds.length
      ? persisted.availableModelIds
      : (catalog?.availableModelIds ?? []),
    manualModelModalities: catalog
      ? mergeRichModelModalities(persisted.manualModelModalities, catalog)
      : persisted.manualModelModalities,
  };
}

function createProfile(id: string, input: CustomApiProfileInput): CustomApiProfile {
  const apiFormat = normalizeCustomApiFormat(input.apiFormat);
  let baseUrl: string;
  try {
    baseUrl = normalizeCustomApiBaseUrl(
      input.baseUrl ??
        (apiFormat === "gemini" ? GEMINI_CUSTOM_API_BASE_URL : DEFAULT_CUSTOM_API_BASE_URL),
    );
  } catch {
    baseUrl = apiFormat === "gemini" ? GEMINI_CUSTOM_API_BASE_URL : DEFAULT_CUSTOM_API_BASE_URL;
  }
  return hydrateProfile(
    {
      id,
      name: normalizedProfileName(input.name ?? "", "新 API 配置"),
      baseUrl,
      apiKey: input.apiKey?.trim() ?? "",
      apiFormat,
      enabled: input.enabled !== false,
      availableModelIds: [],
      manualModelModalities: {},
    },
    null,
    0,
  );
}

function withCompatibilityAliases<T extends CustomApiState>(state: T): T {
  const active =
    state.profiles.find((profile) => profile.id === state.activeProfileId) ??
    state.profiles[0] ??
    null;
  return {
    ...state,
    activeProfileId: active?.id ?? null,
    connection: active?.connection ?? null,
    status: active?.status ?? "idle",
    connecting: active?.connecting ?? false,
    refreshing: active?.refreshing ?? false,
    catalog: active?.catalog ?? null,
    error: active?.error ?? null,
    loadedAt: active?.loadedAt ?? 0,
  };
}

function mergeRichModelModalities(
  current: Record<string, ModelModality[]>,
  catalog: CustomApiCatalog,
) {
  const next = Object.fromEntries(
    Object.entries(current).map(([id, modalities]) => [id, [...modalities]]),
  );
  for (const model of catalog.models) {
    const rawModelId = catalog.routes[model.id]?.sourceModelId;
    if (!rawModelId) continue;
    next[rawModelId] = uniqueModalities([...(next[rawModelId] ?? []), model.modality]);
  }
  return next;
}

function parseManualModelModalities(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([modelId, modalities]) => {
      if (!modelId.trim() || !Array.isArray(modalities)) return [];
      return [[modelId, uniqueModalities(modalities)]];
    }),
  );
}

function uniqueModalities(values: unknown[]) {
  return MODEL_MODALITIES.filter((modality) => values.includes(modality));
}

function normalizeConnection(value: CustomApiConnection): CustomApiConnection {
  const apiKey = value.apiKey.trim();
  if (!apiKey) throw new CustomApiError("请输入 API Key", "API_KEY_REQUIRED");
  return {
    baseUrl: normalizeCustomApiBaseUrl(value.baseUrl),
    apiKey,
    apiFormat: normalizeCustomApiFormat(value.apiFormat),
  };
}

function sameConnection(left: CustomApiConnection, right: CustomApiConnection) {
  return (
    left.baseUrl === right.baseUrl &&
    left.apiKey === right.apiKey &&
    normalizeCustomApiFormat(left.apiFormat) === normalizeCustomApiFormat(right.apiFormat)
  );
}

function connectionIdentity(connection: CustomApiConnection) {
  return `${connection.baseUrl}\u0000${connection.apiKey}\u0000${normalizeCustomApiFormat(connection.apiFormat)}`;
}

function patchProfile(
  profiles: CustomApiProfile[],
  profileId: string,
  patch: Partial<CustomApiProfile>,
) {
  return profiles.map((profile) => (profile.id === profileId ? { ...profile, ...patch } : profile));
}

function createProfileId(profiles: CustomApiProfile[]) {
  let id =
    globalThis.crypto?.randomUUID?.() ??
    `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  while (profiles.some((profile) => profile.id === id)) id = `${id}-2`;
  return id;
}

function normalizedProfileName(value: string, fallback: string) {
  return value.trim().slice(0, 80) || fallback;
}

function setVisibility(hiddenModelKeys: string[], modelKey: string, visible: boolean) {
  const key = modelKey.trim();
  if (!key) return hiddenModelKeys;
  return visible
    ? hiddenModelKeys.filter((item) => item !== key)
    : hiddenModelKeys.includes(key)
      ? hiddenModelKeys
      : [...hiddenModelKeys, key];
}

function uniqueStrings(values: unknown[]) {
  return [
    ...new Set(
      values.flatMap((value) => (typeof value === "string" && value.trim() ? [value.trim()] : [])),
    ),
  ];
}

function publicError(cause: unknown) {
  return cause instanceof Error ? cause.message : "生成请求没有完成";
}
