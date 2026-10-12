import {
  type CanvasConfigModality,
  type CanvasNodeData,
  type GenerationQuote,
  type ModelParameter,
  type PublicGenerationJob,
  type PublicModel,
  type ReferenceImagePurpose,
} from "@weftcanvas/contracts";
import {
  AlertCircle,
  Check,
  ChevronDown,
  History,
  LoaderCircle,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { nodeLabel } from "../lib/node-registry";
import { createPortal } from "react-dom";

import {
  CanvasApiError,
  createGenerationQuote,
  createRequestKey,
  submitGenerationJob,
} from "../lib/api-client";
import {
  beginBrowserSubmission,
  browserSubmissionIdentity,
  endBrowserSubmission,
  isBrowserSubmissionInFlight,
  releaseBrowserSubmissionIdentity,
} from "../lib/browser-generation-runtime";
import { formatCreditMicros, generationBillingText } from "../lib/generation-billing";
import { isCustomModelKey } from "../lib/custom-api";
import {
  autoPickGenerationSettings,
  canRecoverUnavailableModelSelection,
  canonicalPlatformModelId,
  composeModelParameters,
  defaultModelParameters,
  generationRequestQuantity,
  isModelBoundTextParameter,
  isModelCompatibilityParameterHidden,
  isModelInternalParameter,
  isModelMediaReferenceParameter,
  modalityForNodeKind,
  quoteTokenFields,
  reconcileModelParameters,
  removeModelParameter,
  requestPricedFixedOutputCount,
  setExclusiveParameter,
  supportsClientBatchGeneration,
} from "../lib/generation-config";
import {
  collectGenerationReferences,
  collectUpstreamTextContent,
  composeReferenceAwarePrompt,
  generationReferenceError,
  prepareGenerationInputs,
  REFERENCE_VIDEO_DURATIONS_PARAMETER,
  referenceCounts,
  referenceImageCapability,
  referenceImagePurposeFor,
  referenceImagePurposeLabel,
  referenceMediaKey,
  referenceVideoDurations,
  referenceVideoDurationsParameter,
  type GenerationReferences,
  type MediaReference,
} from "../lib/generation-inputs";
import { probeServerMediaDurationMs } from "../lib/server-media-duration";
import { partitionGenerationParameters } from "../lib/generation-parameter-groups";
import {
  findMjActionParameter,
  MJ_ACTION_DEPENDENT_NAMES,
  MJ_ACTION_PARAMETER_NAME,
  mjActionDependentParameters,
} from "../lib/generation-parameter-hints";
import { FollowUpActionSection } from "./mj-follow-up-action-section";
import { resolveGenerationPanelLock } from "../lib/generation-panel-lock";
import {
  findConfigurationSourceWithIndex,
  getSharedConfigurationIndex,
} from "../lib/node-configuration";
import { isMediaAspectRatioParameterName } from "../lib/node-size";
import {
  generationReferenceMentionNodeIds,
  stripReferenceMentionTokens,
} from "../lib/prompt-references";
import { useDismissOnOutsideClick } from "../hooks/use-dismiss-on-outside-click";
import { findCanvasGenerationNode, useCanvasStore } from "../state/canvas-store";
import {
  getMergedModels,
  resolveCustomModelChoice,
  useCustomApiStore,
} from "../state/custom-api-store";
import { useGenerationStore } from "../state/generation-store";
import { useIdentityStore } from "../state/identity-store";
import { useToastStore } from "../state/toast-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import {
  boundedDurationOptions,
  GenerationParameterField,
  generationParameterDisplayValue,
  generationParameterOptionLabel,
  generationParameterScalarOptions,
  generationParameterTextInputValue,
  isGenerationParameterLocked,
  normalizeBoundedDurationValue,
} from "./generation-parameter-field";
import { CategorizedModelSelect } from "./categorized-model-select";
import { pickDefaultModel, pricingUnitText } from "./generation-model-select";
import { CanvasSelect } from "./canvas-select";

type QuoteState = "idle" | "loading" | "ready" | "error";
// 单次最多连点出图/出片数量。上游对 n>1 的支持不可靠（曾出现扣费 N 次只回一张），
// 所以多条由浏览器逐次提交，而不是把 n=N 交给接口站。
const MAX_BATCH_COUNT = 4;
const modalityOptions: { value: CanvasConfigModality; label: string }[] = [
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
];

type NodeGenerationPanelProps = {
  nodeId: string;
  data: CanvasNodeData;
  onClose: () => void;
  presentation?: "dialog" | "embedded";
  submitButtonRef?: RefObject<HTMLButtonElement | null>;
  leadingControl?: ReactNode;
};

export function NodeGenerationPanel({
  nodeId,
  data,
  onClose,
  presentation = "dialog",
  submitButtonRef,
  leadingControl,
}: NodeGenerationPanelProps) {
  const embedded = presentation === "embedded";
  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const configurationIndex = useMemo(
    () => getSharedConfigurationIndex(nodes, edges),
    [edges, nodes],
  );
  const configurationSource = useMemo(
    () => findConfigurationSourceWithIndex(configurationIndex, nodeId),
    [configurationIndex, nodeId],
  );
  const settingsData = configurationSource?.data ?? data;
  const settingsNodeId = configurationSource?.id ?? nodeId;
  const isConfiguration = data.kind === "config";
  const linkedConfiguration = !isConfiguration && configurationSource !== null;
  const [configurationModality, setConfigurationModality] = useState<CanvasConfigModality>(
    data.kind === "config" ? (data.config?.modality ?? "image") : "image",
  );
  const modality = isConfiguration ? configurationModality : modalityForNodeKind(data.kind);
  const platformCatalog = useGenerationStore((state) => state.catalogs[modality]);
  const loadPlatformCatalog = useGenerationStore((state) => state.loadCatalog);
  const watchJob = useGenerationStore((state) => state.watchJob);
  const recoverProject = useGenerationStore((state) => state.recoverProject);
  const beginHostedSubmission = useGenerationStore((state) => state.beginHostedSubmission);
  const jobsById = useGenerationStore((state) => state.jobsById);
  const currentJob = useGenerationStore((state) => state.jobsByNode[nodeId]);
  const identityStatus = useIdentityStore((state) => state.status);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const projectId = useCanvasStore((state) => state.projectId);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const applyGenerationUpdate = useCanvasStore((state) => state.applyGenerationUpdate);
  const beginTransaction = useCanvasStore((state) => state.beginTransaction);
  const commitTransaction = useCanvasStore((state) => state.commitTransaction);
  const showToast = useToastStore((state) => state.show);
  const customProfiles = useCustomApiStore((state) => state.profiles);
  const customActiveProfileId = useCustomApiStore((state) => state.activeProfileId);
  const hiddenModelKeys = useCustomApiStore((state) => state.hiddenModelKeys);
  const pullAllCustomProfiles = useCustomApiStore((state) => state.pullAllProfiles);
  const runCustomGeneration = useCustomApiStore((state) => state.runGeneration);
  const [modelId, setModelId] = useState(settingsData.generation.modelId ?? "");
  const [parameters, setParameters] = useState<Record<string, unknown>>(
    settingsData.generation.parameters,
  );
  const [maxOutputTokens, setMaxOutputTokens] = useState<number | null>(
    settingsData.generation.maxOutputTokens,
  );
  const [invalidParameters, setInvalidParameters] = useState<Set<string>>(() => new Set());
  const [quote, setQuote] = useState<GenerationQuote | null>(null);
  const [quoteState, setQuoteState] = useState<QuoteState>("idle");
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [standaloneQuantity, setStandaloneQuantity] = useState(1);
  const [batchCount, setBatchCount] = useState(1);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [refreshingHistory, setRefreshingHistory] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [morePlacement, setMorePlacement] = useState<{ drop: boolean; maxHeight: number } | null>(
    null,
  );
  const [catalogLoadSettled, setCatalogLoadSettled] = useState(false);
  const moreSurfaceRef = useDismissOnOutsideClick<HTMLDivElement>(moreOpen, () =>
    setMoreOpen(false),
  );
  const quoteSequence = useRef(0);
  const reconciledCapability = useRef("");
  const configurationTargetCount = useMemo(() => {
    if (!isConfiguration) return 0;
    let count = 0;
    for (const edge of edges) {
      if (edge.source !== nodeId) continue;
      if (configurationIndex.nodeById.get(edge.target)?.data.kind !== configurationModality)
        continue;
      if (findConfigurationSourceWithIndex(configurationIndex, edge.target)?.id === nodeId)
        count += 1;
    }
    return count;
  }, [configurationIndex, configurationModality, edges, isConfiguration, nodeId]);

  useEffect(() => {
    let active = true;
    setCatalogLoadSettled(false);
    void loadPlatformCatalog(modality).finally(() => {
      if (active) setCatalogLoadSettled(true);
    });
    return () => {
      active = false;
    };
  }, [loadPlatformCatalog, modality]);

  useEffect(() => {
    if (customProfiles.length) void pullAllCustomProfiles();
  }, [customProfiles.length, pullAllCustomProfiles]);

  useEffect(() => {
    if (embedded) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector(".wc-account-backdrop")) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", closeOnEscape, true);
    return () => window.removeEventListener("keydown", closeOnEscape, true);
  }, [embedded, onClose]);

  const customState = useMemo(
    () => ({
      profiles: customProfiles,
      hiddenModelKeys,
      activeProfileId: customActiveProfileId,
    }),
    [customActiveProfileId, customProfiles, hiddenModelKeys],
  );
  const platformModels = platformCatalog.data?.models ?? [];
  const baseModels = useMemo(
    () => getMergedModels(platformModels, modality, customProfiles, hiddenModelKeys),
    [customProfiles, hiddenModelKeys, modality, platformModels],
  );
  const platformAliasModel = useMemo(() => {
    const canonicalId = canonicalPlatformModelId(modelId);
    return canonicalId === modelId
      ? null
      : (baseModels.find((item) => item.id === canonicalId) ?? null);
  }, [baseModels, modelId]);
  const legacyCustomChoice = useMemo(() => {
    if (
      !modelId ||
      platformAliasModel ||
      isCustomModelKey(modelId) ||
      platformModels.some((item) => item.id === modelId)
    )
      return null;
    return resolveCustomModelChoice(customState, modelId, modality);
  }, [customState, modality, modelId, platformAliasModel, platformModels]);
  const models = useMemo(
    () =>
      legacyCustomChoice && !baseModels.some((item) => item.id === modelId)
        ? [...baseModels, { ...legacyCustomChoice.model, id: modelId }]
        : baseModels,
    [baseModels, legacyCustomChoice, modelId],
  );
  const model = models.find((item) => item.id === modelId) ?? platformAliasModel;
  const selectedCustomChoice = useMemo(
    () =>
      model && (isCustomModelKey(model.id) || legacyCustomChoice)
        ? resolveCustomModelChoice(customState, model.id, modality)
        : null,
    [customState, legacyCustomChoice, modality, model],
  );
  const customSelected = Boolean(selectedCustomChoice);
  const customCatalogLoading = customProfiles.some(
    (profile) => profile.connecting || profile.refreshing || profile.status === "loading",
  );
  const catalogLoading =
    models.length === 0 &&
    (platformCatalog.status === "loading" ||
      customProfiles.some(
        (profile) => profile.connecting || profile.refreshing || profile.status === "loading",
      ));
  const catalogError = models.length
    ? null
    : (platformCatalog.error ?? customProfiles.find((profile) => profile.error)?.error ?? null);
  const unavailableModelError =
    modelId && !model
      ? "所选模型已停用或来源已移除，请重新选择"
      : selectedCustomChoice && !selectedCustomChoice.executable
        ? selectedCustomChoice.unsupportedReason
        : null;
  const outputCountParameter = useMemo(() => findOutputCountParameter(model), [model]);
  const outputCountRange = useMemo(
    () => resolveOutputCountRange(model, outputCountParameter),
    [model, outputCountParameter],
  );
  const outputQuantity = normalizeOutputQuantity(
    outputCountParameter ? parameters[outputCountParameter.name] : standaloneQuantity,
    outputCountRange,
  );
  const requestQuantity = generationRequestQuantity(
    model,
    Boolean(outputCountParameter),
    outputQuantity,
  );
  const showOutputCountControl =
    modality === "image" &&
    Boolean(outputCountParameter) &&
    (outputCountParameter?.fixed !== undefined || outputCountRange.max > outputCountRange.min);
  const requestFixedOutputCount = requestPricedFixedOutputCount(model);
  // 浏览器侧批量：模型自己一次只回一条（n 固定或压根没有 n）时，用连点多次的
  // 方式凑出用户要的张数/条数（图片与视频都适用）。Midjourney 这类「一次固定回
  // 多张」的模型不参与，它的张数由目录的输出契约决定。
  const batchEligible =
    !isConfiguration &&
    !customSelected &&
    supportsClientBatchGeneration(model, outputCountParameter);
  // 视频论「条」，图片论「张」——和价格单位的口径保持一致。
  const batchCountLabel = modality === "video" ? "生成条数" : "生成张数";
  const batchCountUnit = modality === "video" ? "条" : "张";
  const parameterGroups = useMemo(() => {
    if (!model) return { quickParameters: [], moreParameters: [] };
    const groups = partitionGenerationParameters(model);
    const isCount = (parameter: ModelParameter) => parameter.name === outputCountParameter?.name;
    return {
      quickParameters: groups.quickParameters.filter((parameter) => !isCount(parameter)),
      moreParameters: groups.moreParameters.filter((parameter) => !isCount(parameter)),
    };
  }, [model, outputCountParameter]);
  const editableParameters = useMemo(
    () =>
      model?.parameters.filter(
        (parameter) =>
          !isModelBoundTextParameter(model, parameter) &&
          !isModelInternalParameter(parameter) &&
          !isModelMediaReferenceParameter(model, parameter) &&
          !isModelCompatibilityParameterHidden(model, parameter) &&
          parameter.name !== outputCountParameter?.name,
      ) ?? [],
    [model, outputCountParameter],
  );
  // Midjourney 的「后续动作」及其配套参数（父任务 ID/序号/按钮 ID/方向/倍数/画幅）
  // 是单独计费的二次操作，不与普通生成参数平铺；由 FollowUpActionSection 分组呈现。
  const mjActionParameter = useMemo(() => (model ? findMjActionParameter(model) : null), [model]);
  const mjActionNames = useMemo(
    () =>
      new Set<string>(
        mjActionParameter ? [MJ_ACTION_PARAMETER_NAME, ...MJ_ACTION_DEPENDENT_NAMES] : [],
      ),
    [mjActionParameter],
  );
  const mjDependentParameters = useMemo(
    () => (model ? mjActionDependentParameters(model) : []),
    [model],
  );
  const popoverMoreParameters = useMemo(
    () => parameterGroups.moreParameters.filter((parameter) => !mjActionNames.has(parameter.name)),
    [mjActionNames, parameterGroups.moreParameters],
  );
  const editableNonActionParameters = useMemo(
    () => editableParameters.filter((parameter) => !mjActionNames.has(parameter.name)),
    [editableParameters, mjActionNames],
  );
  // 文本模型的 token 上限需要单独给输入框；视频 token 模型（Seedance）按帧数/
  // 分辨率计费，token 数由上游决定，给「最大输出」只会误导用户。
  const hasStandaloneTokenMaximum = Boolean(
    model?.pricing.mode === "token" &&
    model.modality !== "video" &&
    !hasModelMaximumTokenParameter(model),
  );
  const tokenMaximumIsQuick =
    hasStandaloneTokenMaximum && parameterGroups.quickParameters.length < 2;
  const moreSettingCount =
    popoverMoreParameters.length +
    (mjActionParameter ? 1 : 0) +
    (hasStandaloneTokenMaximum && !tokenMaximumIsQuick ? 1 : 0);

  useEffect(() => {
    if (!platformAliasModel || modelId === platformAliasModel.id) return;
    const nextParameters = reconcileModelParameters(platformAliasModel, parameters);
    setModelId(platformAliasModel.id);
    setParameters(nextParameters);
    setInvalidParameters(new Set());
    persistConfig(settingsNodeId, platformAliasModel.id, nextParameters, maxOutputTokens, {
      resize: true,
      recordResize: false,
    });
  }, [maxOutputTokens, modelId, parameters, platformAliasModel, settingsNodeId]);

  useEffect(() => {
    if (!model || outputCountParameter) return;
    setStandaloneQuantity((current) => normalizeOutputQuantity(current, outputCountRange));
  }, [model, outputCountParameter, outputCountRange]);

  // 换模型就回到一张：不同模型的可生成张数与单价都不同，沿用上一次的批量
  // 张数会凭空抬高提交量。
  useEffect(() => {
    setBatchCount(1);
  }, [modelId]);

  // 更多参数弹层从触发按钮上方展开，必须按按钮到视口边缘的实际空间限高：
  // 参数多的模型（Midjourney）最下面几项会被视口裁掉，用户会以为那些输入框
  // 根本不存在。上方空间不够时改为向下展开。
  useEffect(() => {
    if (!moreOpen) {
      setMorePlacement(null);
      return;
    }
    const measure = () => {
      const rect = moreSurfaceRef.current?.getBoundingClientRect();
      if (!rect) return;
      const spaceAbove = rect.top - 21;
      const spaceBelow = window.innerHeight - rect.bottom - 21;
      const drop = spaceBelow > spaceAbove;
      setMorePlacement({
        drop,
        maxHeight: Math.round(Math.max(200, Math.min(680, drop ? spaceBelow : spaceAbove))),
      });
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [moreOpen, moreSurfaceRef]);

  useEffect(() => {
    if (!model || !outputCountParameter || outputCountParameter.fixed !== undefined) return;
    const next = normalizeOutputQuantity(parameters[outputCountParameter.name], outputCountRange);
    if (parameters[outputCountParameter.name] === next) return;
    const nextParameters = setExclusiveParameter(
      model,
      parameters,
      outputCountParameter.name,
      next,
    );
    setParameters(nextParameters);
    persistConfig(settingsNodeId, model.id, nextParameters, maxOutputTokens);
  }, [maxOutputTokens, model, outputCountParameter, outputCountRange, parameters, settingsNodeId]);

  useEffect(() => {
    if (!models.length) return;
    const recoverUnavailable = canRecoverUnavailableModelSelection({
      modelId,
      modelAvailable: Boolean(model),
      customModelKey: isCustomModelKey(modelId),
      catalogLoadSettled,
      catalogReady: platformCatalog.status === "ready",
      catalogRefreshing: platformCatalog.refreshing,
      catalogError: platformCatalog.error,
      platformModelCount: platformModels.length,
      customCatalogLoading,
    });
    if (modelId && !recoverUnavailable) return;
    // 新建节点优先恢复创建者上一次使用的模型；默认画幅在播种时覆盖模型
    // 出厂默认比例，保证默认画幅设置对新建节点真正生效。
    const remembered = useUiPreferencesStore.getState().lastMediaGeneration[modality] ?? null;
    const preferred =
      models.find((item) => item.id === remembered?.modelId) ?? pickDefaultModel(models)!;
    const nextParameters =
      preferred.id === settingsData.generation.modelId
        ? { ...defaultModelParameters(preferred), ...settingsData.generation.parameters }
        : autoPickGenerationSettings({
            model: preferred,
            remembered,
            defaultAspectRatio: useUiPreferencesStore.getState().defaultNodeAspectRatio,
          });
    const nextMaximum =
      preferred.pricing.mode === "token" && !hasModelMaximumTokenParameter(preferred)
        ? (settingsData.generation.maxOutputTokens ?? 1_024)
        : null;
    setModelId(preferred.id);
    setParameters(nextParameters);
    setMaxOutputTokens(nextMaximum);
    setInvalidParameters(new Set());
    persistConfig(settingsNodeId, preferred.id, nextParameters, nextMaximum, {
      // Only sync node geometry when a stale selection is being recovered. For a
      // fresh node (no model chosen yet) the creator's default aspect ratio must
      // win; auto-picking a model must not silently rewrite the media geometry.
      resize: recoverUnavailable,
      recordResize: false,
    });
  }, [
    catalogLoadSettled,
    customCatalogLoading,
    model,
    modelId,
    models,
    platformCatalog.error,
    platformCatalog.refreshing,
    platformCatalog.status,
    platformModels.length,
    settingsData.generation.maxOutputTokens,
    settingsData.generation.modelId,
    settingsData.generation.parameters,
    settingsNodeId,
  ]);

  useEffect(() => {
    if (!model) return;
    const capabilityVersion = selectedCustomChoice
      ? (customProfiles.find((profile) => profile.id === selectedCustomChoice.profileId)?.catalog
          ?.capabilityVersion ?? "custom")
      : (platformCatalog.data?.capabilityVersion ?? "platform");
    const key = `${capabilityVersion}:${model.id}`;
    if (reconciledCapability.current === key) return;
    reconciledCapability.current = key;
    const next = reconcileModelParameters(model, parameters);
    if (JSON.stringify(next) === JSON.stringify(parameters)) return;
    setParameters(next);
    persistConfig(settingsNodeId, model.id, next, maxOutputTokens, {
      resize: true,
      recordResize: false,
    });
  }, [
    customProfiles,
    maxOutputTokens,
    model,
    parameters,
    platformCatalog.data?.capabilityVersion,
    selectedCustomChoice,
    settingsNodeId,
  ]);

  const references = useMemo(
    () =>
      !isConfiguration && model
        ? collectGenerationReferences(
            nodeId,
            model,
            nodes,
            edges,
            data.generation.referenceNodeIds,
            data.generation.referenceMode,
            data.generation.referenceImagePurposes,
          )
        : null,
    [
      data.generation.referenceImagePurposes,
      data.generation.referenceMode,
      data.generation.referenceNodeIds,
      edges,
      isConfiguration,
      model,
      nodeId,
      nodes,
    ],
  );
  const counts = useMemo(
    () =>
      references
        ? referenceCounts(references)
        : { images: 0, styleImages: 0, elementImages: 0, videos: 0, audios: 0 },
    [references],
  );
  const videoDurations = useMemo(
    () => (references ? referenceVideoDurations(references) : null),
    [references],
  );
  // 报价依赖参考视频的总秒数：换一条等长的参考视频不会改变计数，但会改变按秒
  // 计费的参考素材量，必须让报价重算。
  const videoDurationSeconds =
    videoDurations?.reduce((total, seconds) => total + seconds, 0) ?? null;
  const referenceError = useMemo(
    () => (model && references ? generationReferenceError(references, model) : null),
    [model, references],
  );
  // 画布上新生成的视频工件不带时长（服务端只在播放后回写，且不会回流到本地
  // 节点）。这里对缺时长的已连接视频按需探测一次，把时长补回上游节点素材，
  // 参考视频时长参数与按秒计费的预估随即在本地成立。探测失败不阻塞任何流程，
  // 提交时由服务端从素材记录/任务工件兜底推导。
  const probedDurationNodeIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!references || !model || !referenceVideoDurationsParameter(model)) return;
    for (const reference of references.videos) {
      if (reference.media.durationMs || reference.media.source !== "server") continue;
      if (probedDurationNodeIds.current.has(reference.nodeId)) continue;
      probedDurationNodeIds.current.add(reference.nodeId);
      void probeServerMediaDurationMs(reference.media).then((durationMs) => {
        if (!durationMs) {
          probedDurationNodeIds.current.delete(reference.nodeId);
          return;
        }
        const state = useCanvasStore.getState();
        const target = state.nodes.find((item) => item.id === reference.nodeId);
        if (!target?.data.media || target.data.media.durationMs) return;
        state.setNodeMedia(reference.nodeId, { ...target.data.media, durationMs }, false);
      });
    }
  }, [references, model]);
  const mentionNodeIds = useMemo(
    () => generationReferenceMentionNodeIds(nodeId, data.generation.referenceNodeIds, nodes),
    [data.generation.referenceNodeIds, nodeId, nodes],
  );
  const upstreamTextContent = useMemo(
    () => (!isConfiguration ? collectUpstreamTextContent(nodeId, nodes, edges) : []),
    [edges, isConfiguration, nodeId, nodes],
  );
  const localPromptBody = useMemo(
    () => stripReferenceMentionTokens(data.body, mentionNodeIds, nodes).trim(),
    [data.body, mentionNodeIds, nodes],
  );
  const promptBody = useMemo(
    () =>
      composeReferenceAwarePrompt(
        [localPromptBody, ...upstreamTextContent.filter((body) => body !== localPromptBody)]
          .filter(Boolean)
          .join("\n\n"),
        references,
      ),
    [localPromptBody, references, upstreamTextContent],
  );
  const promptMissing = Boolean(model?.input.textRequired && !promptBody.trim());
  const jobHistory = useMemo(
    () =>
      Object.values(jobsById)
        .filter((job) => job.nodeId === nodeId && job.projectId === projectId)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [jobsById, nodeId, projectId],
  );
  const embeddedMoreAvailable = moreSettingCount > 0 || jobHistory.length > 0;
  useEffect(() => {
    const sequence = ++quoteSequence.current;
    setQuote(null);
    setQuoteError(null);
    if (isConfiguration) {
      setQuoteState("idle");
      return;
    }
    if (!model) {
      setQuoteState("idle");
      return;
    }
    if (invalidParameters.size) {
      setQuoteState("error");
      setQuoteError("有参数尚未填写完整");
      return;
    }
    if (referenceError) {
      setQuoteState("error");
      setQuoteError(referenceError);
      return;
    }
    if (promptMissing) {
      setQuoteState("idle");
      return;
    }
    if (selectedCustomChoice && !selectedCustomChoice.executable) {
      setQuoteState("error");
      setQuoteError(selectedCustomChoice.unsupportedReason ?? "当前模型暂不支持直接生成");
      return;
    }
    if (customSelected) {
      setQuoteState("ready");
      return;
    }
    setQuoteState("loading");
    const timer = window.setTimeout(() => {
      const tokenFields = quoteTokenFields(model, promptBody, parameters, maxOutputTokens);
      const requestParameters = composeGenerationParameters(
        model,
        promptBody,
        parameters,
        outputCountParameter,
        outputQuantity,
        videoDurations,
      );
      void createGenerationQuote({
        modelId: model.id,
        modality,
        parameters: requestParameters,
        inputs: counts,
        quantity: requestQuantity,
        ...tokenFields,
      })
        .then((next) => {
          if (quoteSequence.current !== sequence) return;
          setQuote(next);
          setQuoteState("ready");
        })
        .catch((cause) => {
          if (quoteSequence.current !== sequence) return;
          setQuoteState("error");
          setQuoteError(cause instanceof CanvasApiError ? cause.message : "暂时无法确认本次价格");
        });
    }, 280);
    return () => window.clearTimeout(timer);
  }, [
    counts.audios,
    counts.elementImages,
    counts.images,
    counts.styleImages,
    counts.videos,
    customSelected,
    invalidParameters,
    isConfiguration,
    maxOutputTokens,
    modality,
    model,
    outputCountParameter,
    outputQuantity,
    parameters,
    promptBody,
    promptMissing,
    quoteRevision,
    referenceError,
    requestQuantity,
    selectedCustomChoice,
    videoDurations,
    videoDurationSeconds,
  ]);

  const nodeJobs = useMemo(
    () =>
      Object.values(jobsById)
        .filter((job) => job.nodeId === nodeId && job.projectId === projectId)
        .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt)),
    [jobsById, nodeId, projectId],
  );
  const newestNodeJob = nodeJobs[0] ?? currentJob ?? null;
  const pendingAmbiguousIdentity =
    !isConfiguration && browserSubmissionIdentity(projectId, nodeId) !== null;
  const { activeJob, awaitingConfirmation, generationLocked } = resolveGenerationPanelLock({
    isConfiguration,
    nodeJobs,
    newestNodeJob,
    nodeStatus: data.status,
    nodeJobStatus: data.generation.jobStatus,
    pendingAmbiguousIdentity,
    browserSubmissionInFlight: isBrowserSubmissionInFlight(nodeId),
  });
  // Each node is single-flight, while jobs attached to other nodes remain
  // independent and can be submitted concurrently.
  // Keep the busy signal in the submit affordance. The composer should not
  // compete with the prompt by replacing it with transient status copy.
  const generationBusy =
    !isConfiguration &&
    (submitting || generationLocked || quoteState === "loading" || catalogLoading);
  const embeddedStatus = (() => {
    if (awaitingConfirmation) {
      return {
        tone: "pending",
        text: pendingAmbiguousIdentity
          ? "刷新前的提交可能已被受理，暂无法核对；请勿重复生成"
          : "正在确认任务提交，请勿重复生成",
      } as const;
    }
    if (data.generation.error) return { tone: "error", text: data.generation.error } as const;
    if (unavailableModelError) return { tone: "error", text: unavailableModelError } as const;
    if (catalogError) return { tone: "error", text: catalogError } as const;
    if (quoteError) return { tone: "error", text: quoteError } as const;
    if (upstreamTextContent.length)
      return {
        tone: "linked",
        text: `已连接 ${upstreamTextContent.length} 条文本，生成时自动使用`,
      } as const;
    return null;
  })();

  const chooseModel = (nextId: string) => {
    const nextModel = models.find((item) => item.id === nextId);
    if (!nextModel) return;
    // 创建者显式选模型：出厂默认比例让位于默认画幅设置，其余参数用模型默认。
    const nextParameters = autoPickGenerationSettings({
      model: nextModel,
      remembered: null,
      defaultAspectRatio: useUiPreferencesStore.getState().defaultNodeAspectRatio,
    });
    const nextMaximum =
      nextModel.pricing.mode === "token" && !hasModelMaximumTokenParameter(nextModel)
        ? 1_024
        : null;
    setModelId(nextId);
    setParameters(nextParameters);
    setMaxOutputTokens(nextMaximum);
    setInvalidParameters(new Set());
    persistConfig(settingsNodeId, nextId, nextParameters, nextMaximum, {
      resize: true,
      userInitiated: true,
      rememberModel: nextModel,
    });
  };

  const updateParameter = (name: string, value: unknown) => {
    if (!model) return;
    const next =
      value === undefined
        ? removeModelParameter(model, parameters, name)
        : setExclusiveParameter(model, parameters, name, value);
    setParameters(next);
    persistConfig(settingsNodeId, model.id, next, maxOutputTokens, {
      resize: isMediaAspectRatioParameterName(name),
      preferredParameter: name,
      userInitiated: true,
      rememberModel: model,
    });
  };

  const updateOutputQuantity = (value: number) => {
    const next = normalizeOutputQuantity(value, outputCountRange);
    if (outputCountParameter) {
      if (outputCountParameter.fixed !== undefined) return;
      updateParameter(outputCountParameter.name, next);
      return;
    }
    setStandaloneQuantity(next);
  };

  const updateParameterValidity = (name: string, valid: boolean) => {
    setInvalidParameters((current) => {
      const next = new Set(current);
      if (valid) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const updateMaximumTokens = (value: number) => {
    if (!model) return;
    const next = Math.max(1, Math.min(1_000_000, value || 1));
    setMaxOutputTokens(next);
    persistConfig(settingsNodeId, model.id, parameters, next, {
      userInitiated: true,
      rememberModel: model,
    });
  };

  const chooseConfigurationModality = (nextModality: CanvasConfigModality) => {
    if (!isConfiguration || nextModality === configurationModality) return;
    const state = useCanvasStore.getState();
    const node = state.nodes.find((item) => item.id === settingsNodeId);
    if (!node) return;
    const generation = {
      ...node.data.generation,
      modelId: null,
      parameters: {},
      maxOutputTokens: null,
      error: null,
    };
    setConfigurationModality(nextModality);
    setModelId("");
    setParameters({});
    setMaxOutputTokens(null);
    setInvalidParameters(new Set());
    reconciledCapability.current = "";
    state.updateNodeData(settingsNodeId, { config: { modality: nextModality }, generation }, false);
  };

  const retryGeneration = () => {
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    releaseBrowserSubmissionIdentity(projectId, nodeId);
    updateNodeData(
      nodeId,
      {
        status: node?.data.media ? "success" : "idle",
        progress: null,
        generation: {
          ...(node?.data.generation ?? data.generation),
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: null,
        },
      },
      false,
    );
    setQuoteRevision((value) => value + 1);
  };

  // Explicitly abandons a still-unconfirmed submission so the node becomes
  // actionable again. The durable idempotency identity is released too, so the
  // next submission is a genuinely new request.
  const abandonAmbiguousSubmission = () => {
    const node = findCanvasGenerationNode(useCanvasStore.getState(), nodeId);
    releaseBrowserSubmissionIdentity(projectId, nodeId);
    updateNodeData(
      nodeId,
      {
        status: node?.data.media ? "success" : "idle",
        progress: null,
        generation: {
          ...(node?.data.generation ?? data.generation),
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: "已放弃未确认的提交，请重新提交",
        },
      },
      false,
    );
    setQuoteRevision((value) => value + 1);
  };

  const refreshHistory = async () => {
    if (refreshingHistory || identityStatus !== "authenticated") return;
    setRefreshingHistory(true);
    try {
      await recoverProject(projectId);
    } finally {
      setRefreshingHistory(false);
    }
  };

  const submit = async () => {
    if (
      !model ||
      !references ||
      referenceError ||
      submitting ||
      generationLocked ||
      unavailableModelError ||
      (!customSelected && !quote)
    )
      return;
    if (customSelected) {
      setSubmitting(true);
      try {
        runCustomGeneration({ nodeId, model, modality, body: promptBody, parameters, references });
        onClose();
      } catch (cause) {
        showToast(cause instanceof Error ? cause.message : "生成任务没有提交成功", "error");
      } finally {
        setSubmitting(false);
      }
      return;
    }
    if (!quote) return;
    if (identityStatus !== "authenticated") {
      openAccount("login");
      return;
    }
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      setQuote(null);
      setQuoteState("loading");
      setQuoteError(null);
      setQuoteRevision((value) => value + 1);
      return;
    }
    setSubmitting(true);
    const markSubmissionFailure = (targetId: string, message: string) => {
      const current = findCanvasGenerationNode(useCanvasStore.getState(), targetId);
      if (!current || current.data.generation.jobStatus !== "submitting") return;
      applyGenerationUpdate(targetId, {
        status: current.data.media ? "success" : "error",
        progress: null,
        generation: {
          ...current.data.generation,
          jobStatus: "failed",
          error: message,
        },
      });
    };
    const markAmbiguousSubmissionFailure = (targetId: string) => {
      const current = findCanvasGenerationNode(useCanvasStore.getState(), targetId);
      if (!current || current.data.generation.jobStatus !== "submitting") return;
      applyGenerationUpdate(targetId, {
        status: "running",
        progress: null,
        generation: {
          ...current.data.generation,
          jobStatus: "submission_unknown",
          error: null,
        },
      });
    };
    // 多条出图/出片先把占位节点按一列排在源节点右侧，再逐个节点提交一次。每个
    // 节点都是独立任务、独立计费，也各自把结果落回自己身上。
    const createBatchTargets = (extra: number): string[] => {
      if (!model) return [];
      const queuedGeneration = {
        ...data.generation,
        modelId: model.id,
        parameters,
        maxOutputTokens,
        jobId: null,
        jobVersion: null,
        jobCreatedAt: null,
        jobStatus: null,
        artifactId: undefined,
        error: null,
      };
      return useCanvasStore.getState().addGenerationBatchNodes(nodeId, data.kind, extra, {
        body: data.body,
        generation: queuedGeneration,
      });
    };
    const submitTarget = async (
      targetId: string,
      payload: {
        inputs: Awaited<ReturnType<typeof prepareGenerationInputs>>;
        tokenFields: ReturnType<typeof quoteTokenFields>;
        requestParameters: Record<string, unknown>;
      },
    ): Promise<"ok" | "failed" | "ambiguous" | "quote-changed"> => {
      // Resolve the durable idempotency identity and start the visual hand-off
      // BEFORE the optimistic submitting stage flips the node. Inside a
      // pre-existing ambiguous window (submitting/submission_unknown) the one
      // durable identity is reused so a refresh-before-confirmation cannot mint a
      // second logical request or a fresh key; a genuinely new action on an
      // otherwise settled node releases any stale identity and mints a fresh key.
      const identity = beginHostedSubmission(targetId, () => createRequestKey("job"));
      beginBrowserSubmission(targetId);
      let generationPostAttempted = false;
      try {
        generationPostAttempted = true;
        const job = await submitGenerationJob({
          projectId: useCanvasStore.getState().projectId,
          nodeId: targetId,
          modelId: model.id,
          modality,
          parameters: payload.requestParameters,
          inputs: payload.inputs,
          quantity: requestQuantity,
          ...payload.tokenFields,
          expectedQuote: {
            id: quote.id,
            modelId: quote.modelId,
            creditMicros: quote.creditMicros,
            pricingVersion: quote.pricingVersion,
            expiresAt: quote.expiresAt,
          },
          idempotencyKey: identity.key,
        });
        releaseBrowserSubmissionIdentity(projectId, targetId);
        watchJob(job);
        return "ok";
      } catch (cause) {
        if (cause instanceof CanvasApiError && cause.status === 401)
          useIdentityStore.getState().expire();
        if (cause instanceof CanvasApiError && cause.code === "INSUFFICIENT_CREDITS") {
          // Keep the recovery path inside the account surface so the creator can
          // recharge and return to this node without losing its configured prompt.
          openAccount("login");
        }
        const quoteChanged = cause instanceof CanvasApiError && cause.code === "QUOTE_CHANGED";
        if (quoteChanged) {
          setQuote(null);
          setQuoteState("loading");
          setQuoteError(null);
          await loadPlatformCatalog(modality, true);
          setQuoteRevision((value) => value + 1);
        }
        const message = cause instanceof Error ? cause.message : "生成任务没有提交成功";
        if (!generationPostAttempted) {
          // The generation POST never left the browser: reference reading, the
          // upload intent, the upload, or input preparation failed before any
          // request could be accepted. This is a definitive local failure, not an
          // ambiguous submission: release the durable identity, surface the
          // specific error, and make the submit button actionable again.
          releaseBrowserSubmissionIdentity(projectId, targetId);
          markSubmissionFailure(targetId, message);
          showToast(message, "error");
          return "failed";
        }
        if (isAmbiguousSubmissionFailure(cause)) {
          // The response was lost or the transport gave up; the server may still
          // have accepted the request. Keep the durable identity and lock the node
          // as unknown so a repeated action cannot create a second paid task.
          markAmbiguousSubmissionFailure(targetId);
          showToast("提交结果待确认，请稍后在任务记录中确认", "info");
          return "ambiguous";
        }
        releaseBrowserSubmissionIdentity(projectId, targetId);
        markSubmissionFailure(targetId, message);
        showToast(message, "error");
        return quoteChanged ? "quote-changed" : "failed";
      } finally {
        endBrowserSubmission(targetId);
      }
    };

    const deferBatch = batchEligible && batchCount > 1;
    const batchTargets = deferBatch ? [nodeId, ...createBatchTargets(batchCount - 1)] : [nodeId];
    let succeeded = 0;
    let failedTargets = 0;
    try {
      const inputs = await prepareGenerationInputs(references);
      const tokenFields = quoteTokenFields(model, promptBody, parameters, maxOutputTokens);
      const requestParameters = composeGenerationParameters(
        model,
        promptBody,
        parameters,
        outputCountParameter,
        outputQuantity,
        videoDurations,
      );
      for (const targetId of batchTargets) {
        const outcome = await submitTarget(targetId, { inputs, tokenFields, requestParameters });
        if (outcome === "ok") succeeded += 1;
        else failedTargets += 1;
        // 价格/参数已经变了：后续几张必然同样被拒，停下来让用户重新确认。
        if (outcome === "quote-changed") break;
      }
    } catch (cause) {
      // 参考素材准备失败，POST 一张都没发出去。
      const message = cause instanceof Error ? cause.message : "生成任务没有提交成功";
      failedTargets = batchTargets.length;
      for (const targetId of batchTargets) markSubmissionFailure(targetId, message);
      showToast(message, "error");
    } finally {
      setSubmitting(false);
    }
    // 至少提交成功一条就收起面板；失败的节点会把错误留在画布上。
    if (succeeded > 0) {
      if (failedTargets > 0)
        showToast(
          `已提交 ${succeeded} ${batchCountUnit}，${failedTargets} ${batchCountUnit}未提交成功`,
          "info",
        );
      onClose();
    }
  };

  // 统一的「数量」控件：Midjourney 这类一次固定回多张的模型显示一次出图张数
  // （只读），一次只回一条的模型显示可选的连点数量，目录自带 n 范围的模型沿用
  // 原来的数量下拉。三种情况都不再出现「调用次数」这种让人误以为贵的措辞。
  const effectiveBatchCount = batchEligible ? batchCount : 1;
  const outputCountControl = !model
    ? null
    : requestFixedOutputCount !== null
      ? {
          value: requestFixedOutputCount,
          min: requestFixedOutputCount,
          max: requestFixedOutputCount,
          step: 1,
          label: "出图张数",
          unit: "张",
          disabled: true,
          onChange: updateOutputQuantity,
        }
      : batchEligible
        ? {
            value: batchCount,
            min: 1,
            max: MAX_BATCH_COUNT,
            step: 1,
            label: batchCountLabel,
            unit: batchCountUnit,
            disabled: generationLocked,
            onChange: setBatchCount,
          }
        : showOutputCountControl && outputCountParameter
          ? {
              value: outputQuantity,
              min: outputCountRange.min,
              max: outputCountRange.max,
              step: outputCountRange.step,
              label: "生成张数",
              unit: "张",
              disabled:
                generationLocked ||
                outputCountParameter.fixed !== undefined ||
                outputCountRange.max === outputCountRange.min,
              onChange: updateOutputQuantity,
            }
          : null;
  // 批量提交按次计费，报价要按数量折算，否则用户看到的是单条价、扣的是 N 条。
  const quoteCredits = quote ? formatCreditMicros(quote.creditMicros * effectiveBatchCount) : null;
  const quoteBatchNote =
    quote && effectiveBatchCount > 1
      ? `${formatCreditMicros(quote.creditMicros)} 积分 × ${effectiveBatchCount} ${batchCountUnit}`
      : null;

  if (embedded && isConfiguration) {
    return (
      <section
        className="wc-config-composer"
        aria-label="配置节点参数"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header className="wc-config-composer-header">
          <span className="wc-generation-symbol is-config">
            <SlidersHorizontal aria-hidden="true" />
          </span>
          <div>
            <strong>生成配置</strong>
            <small>修改后自动同步到连接的同类型节点</small>
          </div>
          <output aria-live="polite">
            {configurationTargetCount
              ? `已同步 ${configurationTargetCount} 个节点`
              : "等待连接节点"}
          </output>
        </header>

        <div className="wc-config-composer-body">
          <div className="wc-config-modality" role="group" aria-label="配置类型">
            {modalityOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={configurationModality === option.value ? "is-active" : undefined}
                aria-pressed={configurationModality === option.value}
                onClick={() => chooseConfigurationModality(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          <label className="wc-config-composer-model">
            <span>模型</span>
            <CategorizedModelSelect
              value={modelId}
              models={models}
              disabled={catalogLoading || !models.length}
              onChange={chooseModel}
              ariaLabel="模型"
            />
          </label>

          {outputCountControl ? <OutputCountField {...outputCountControl} /> : null}

          {model ? (
            <div className="wc-config-composer-parameters">
              {editableParameters.map((parameter) => (
                <GenerationParameterField
                  key={`${model.id}:${parameter.name}`}
                  parameter={parameter}
                  value={parameters[parameter.name]}
                  disabled={false}
                  boundedDuration={modality === "video" || modality === "audio"}
                  onChange={(value) => updateParameter(parameter.name, value)}
                  onValidityChange={(valid) => updateParameterValidity(parameter.name, valid)}
                />
              ))}
              {hasStandaloneTokenMaximum ? (
                <label className="wc-generation-field">
                  <span>最大输出</span>
                  <input
                    type="number"
                    min={1}
                    max={1_000_000}
                    step={128}
                    value={maxOutputTokens ?? 1_024}
                    onChange={(event) => updateMaximumTokens(Number(event.target.value))}
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          {unavailableModelError ? (
            <div className="wc-generation-error" role="alert">
              <AlertCircle aria-hidden="true" />
              {unavailableModelError}
            </div>
          ) : null}
          {!unavailableModelError && catalogError ? (
            <div className="wc-generation-error" role="alert">
              <AlertCircle aria-hidden="true" />
              {catalogError}
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  if (embedded) {
    const submitDisabled =
      !model ||
      invalidParameters.size > 0 ||
      Boolean(referenceError) ||
      quoteState !== "ready" ||
      submitting ||
      generationLocked ||
      Boolean(unavailableModelError) ||
      (!customSelected && !quote);
    const submitText = "生成";
    const retryAvailable =
      !activeJob &&
      !awaitingConfirmation &&
      Boolean(data.generation.error || (quoteState === "error" && model && !referenceError));

    return (
      <section
        className="wc-generation-panel wc-generation-panel--embedded"
        data-generation-modality={modality}
        data-has-reference-roles={
          references && references.imagePurposes.length > 1 && references.connectedImages.length > 0
            ? "true"
            : undefined
        }
        aria-label={`${nodeLabel(data.kind)}创作设置`}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <div className="wc-generation-compact-bar">
          {leadingControl ? (
            <div className="wc-generation-leading-control">{leadingControl}</div>
          ) : null}

          <div
            className="wc-generation-compact-control wc-generation-model-control"
            onClick={clickNestedCanvasSelect}
          >
            <Sparkles aria-hidden="true" />
            <span>
              <small>{linkedConfiguration ? "模型 · 由配置节点同步" : "模型"}</small>
              <CategorizedModelSelect
                value={modelId}
                models={models}
                disabled={catalogLoading || !models.length || generationLocked}
                onChange={chooseModel}
                ariaLabel="模型"
              />
            </span>
          </div>

          <div className="wc-generation-quick-controls" aria-label="常用参数">
            {outputCountControl ? <CompactOutputCount {...outputCountControl} /> : null}
            {parameterGroups.quickParameters.map((parameter) => (
              <CompactGenerationParameter
                key={`${model?.id ?? "model"}:${parameter.name}`}
                parameter={parameter}
                value={parameters[parameter.name]}
                disabled={generationLocked}
                boundedDuration={modality === "video" || modality === "audio"}
                onChange={(value) => updateParameter(parameter.name, value)}
              />
            ))}
            {tokenMaximumIsQuick ? (
              <CompactMaximumTokens
                value={maxOutputTokens ?? 1_024}
                disabled={generationLocked}
                onChange={updateMaximumTokens}
              />
            ) : null}
          </div>

          {embeddedMoreAvailable ? (
            <div ref={moreSurfaceRef} className="wc-generation-more-wrap">
              <button
                type="button"
                className={`wc-generation-more-trigger ${moreOpen ? "is-active" : ""}`}
                aria-label={moreSettingCount ? `更多参数，${moreSettingCount} 项` : "最近任务"}
                title={moreSettingCount ? "更多参数" : "最近任务"}
                aria-haspopup="dialog"
                aria-expanded={moreOpen}
                onClick={() => setMoreOpen((open) => !open)}
              >
                <SlidersHorizontal aria-hidden="true" />
                <span>{moreSettingCount ? "参数" : "任务"}</span>
                <small>{moreSettingCount || jobHistory.length}</small>
              </button>
              {moreOpen ? (
                <div
                  className={`wc-generation-more-popover ${morePlacement?.drop ? "is-dropping" : ""}`}
                  style={morePlacement ? { maxHeight: morePlacement.maxHeight } : undefined}
                  role="dialog"
                  aria-label="更多生成参数"
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    setMoreOpen(false);
                  }}
                >
                  <header>
                    <div>
                      <strong>{moreSettingCount ? "更多参数" : "最近任务"}</strong>
                      {model?.description ? <small>{model.description}</small> : null}
                    </div>
                    <button
                      type="button"
                      aria-label="关闭更多参数"
                      title="关闭"
                      onClick={() => setMoreOpen(false)}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </header>
                  {moreSettingCount ? (
                    <div className="wc-generation-more-fields">
                      {mjActionParameter && model ? (
                        <FollowUpActionSection
                          model={model}
                          actionParameter={mjActionParameter}
                          dependentParameters={mjDependentParameters}
                          values={parameters}
                          disabled={generationLocked}
                          referenceImageCount={counts.images}
                          onChange={updateParameter}
                          onValidityChange={updateParameterValidity}
                        />
                      ) : null}
                      {popoverMoreParameters.map((parameter) => (
                        <GenerationParameterField
                          key={`${model?.id ?? "model"}:${parameter.name}`}
                          parameter={parameter}
                          value={parameters[parameter.name]}
                          disabled={generationLocked}
                          boundedDuration={modality === "video" || modality === "audio"}
                          showHint
                          onChange={(value) => updateParameter(parameter.name, value)}
                          onValidityChange={(valid) =>
                            updateParameterValidity(parameter.name, valid)
                          }
                        />
                      ))}
                      {hasStandaloneTokenMaximum && !tokenMaximumIsQuick ? (
                        <label className="wc-generation-field">
                          <span>最大输出</span>
                          <input
                            type="number"
                            min={1}
                            max={1_000_000}
                            step={128}
                            value={maxOutputTokens ?? 1_024}
                            disabled={generationLocked}
                            onChange={(event) => updateMaximumTokens(Number(event.target.value))}
                          />
                        </label>
                      ) : null}
                    </div>
                  ) : null}
                  {jobHistory.length ? (
                    <section className="wc-generation-compact-history" aria-label="最近任务">
                      <header>
                        <strong>最近任务</strong>
                        <button
                          type="button"
                          aria-label="刷新任务记录"
                          title="刷新任务记录"
                          disabled={refreshingHistory || identityStatus !== "authenticated"}
                          onClick={() => void refreshHistory()}
                        >
                          <RotateCcw
                            className={refreshingHistory ? "is-spinning" : ""}
                            aria-hidden="true"
                          />
                        </button>
                      </header>
                      <div>
                        {jobHistory.slice(0, 8).map((job) => {
                          const status = generationHistoryStatus(job);
                          const billing = generationBillingText(job);
                          return (
                            <div
                              key={job.id}
                              className={`wc-generation-history-row is-${status.tone}`}
                            >
                              <i aria-hidden="true" />
                              <span>
                                <strong>{job.modelLabel}</strong>
                                <small>
                                  {formatGenerationTime(job.createdAt)} · {job.quote.credits} 积分 ·{" "}
                                  {pricingUnitText(job.quote.pricingUnit)}
                                  {billing ? ` · ${billing}` : ""}
                                </small>
                                {job.error?.message ? <em>{job.error.message}</em> : null}
                              </span>
                              <b>{status.label}</b>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          <div className="wc-generation-submit-area">
            <div className="wc-generation-submit-line">
              {quote && !customSelected && quoteCredits !== null ? (
                <span
                  className="wc-generation-compact-credit"
                  title={`${quote.estimated ? "预计需要" : "需要"} ${quoteCredits} 积分，${pricingUnitText(quote.pricingUnit)}${quoteBatchNote ? `（${quoteBatchNote}）` : ""}${model?.pricing.estimateNote ? `（${model.pricing.estimateNote}）` : ""}`}
                  aria-label={`${quote.estimated ? "预计需要" : "需要"} ${quoteCredits} 积分，${pricingUnitText(quote.pricingUnit)}`}
                >
                  {quote.estimated ? "约 " : ""}需 {quoteCredits} 积分 ·{" "}
                  {pricingUnitText(quote.pricingUnit)}
                </span>
              ) : null}

              <button
                ref={submitButtonRef}
                type="button"
                className="wc-generation-submit wc-generation-submit--compact"
                aria-label={submitText}
                aria-busy={generationBusy}
                disabled={submitDisabled}
                onClick={() => void submit()}
              >
                {generationBusy ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : (
                  <Sparkles aria-hidden="true" />
                )}
                <span>{submitText}</span>
              </button>
            </div>

            {embeddedStatus &&
            (embeddedStatus.tone === "error" || embeddedStatus.tone === "linked") ? (
              <div
                className={`wc-generation-compact-status is-${embeddedStatus.tone}`}
                role={embeddedStatus.tone === "error" ? "alert" : "status"}
                aria-live="polite"
                title={embeddedStatus.text}
              >
                {embeddedStatus.tone === "error" ? <AlertCircle aria-hidden="true" /> : null}
                <span>{embeddedStatus.text}</span>
                {retryAvailable ? (
                  <button
                    type="button"
                    aria-label="重试"
                    title="重试"
                    onClick={() =>
                      data.generation.error
                        ? retryGeneration()
                        : setQuoteRevision((value) => value + 1)
                    }
                  >
                    <RotateCcw aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            ) : null}
            {embeddedStatus && embeddedStatus.tone === "pending" && pendingAmbiguousIdentity ? (
              <div
                className="wc-generation-compact-status is-pending"
                role="status"
                aria-live="polite"
                title={embeddedStatus.text}
              >
                <AlertCircle aria-hidden="true" />
                <span>{embeddedStatus.text}</span>
                <button
                  type="button"
                  aria-label="放弃未确认的提交"
                  title="放弃未确认的提交，之后可重新提交"
                  onClick={abandonAmbiguousSubmission}
                >
                  <RotateCcw aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
        {model && references ? (
          <ReferenceImagePurposeControls
            model={model}
            references={references}
            assignments={data.generation.referenceImagePurposes}
            disabled={generationLocked}
            embedded
            onChange={(reference, purpose) =>
              updateReferenceImagePurpose(nodeId, reference, purpose)
            }
          />
        ) : null}
      </section>
    );
  }

  const panel = (
    <section className="wc-generation-panel" onPointerDown={(event) => event.stopPropagation()}>
      <header className="wc-generation-header">
        <div>
          <span className={`wc-generation-symbol ${isConfiguration ? "is-config" : ""}`}>
            {isConfiguration ? (
              <SlidersHorizontal aria-hidden="true" />
            ) : (
              <Sparkles aria-hidden="true" />
            )}
          </span>
          <strong>
            {isConfiguration ? "配置生成参数" : `生成${nodeLabel(data.kind).replace("节点", "")}`}
          </strong>
        </div>
        <button
          type="button"
          className="wc-dialog-close"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </button>
      </header>

      <div className="wc-generation-scroll">
        {isConfiguration ? (
          <div className="wc-config-modality" role="group" aria-label="配置类型">
            {modalityOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={configurationModality === option.value ? "is-active" : undefined}
                aria-pressed={configurationModality === option.value}
                onClick={() => chooseConfigurationModality(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : !embedded ? (
          <label className="wc-generation-field wc-generation-prompt">
            <span>提示内容</span>
            <textarea
              value={data.body}
              rows={4}
              placeholder="输入创作内容"
              onFocus={beginTransaction}
              onBlur={commitTransaction}
              onPaste={blockFilePaste}
              onChange={(event) => updateNodeData(nodeId, { body: event.target.value }, false)}
            />
          </label>
        ) : null}

        {linkedConfiguration ? (
          <div className="wc-config-linked" role="status">
            <SlidersHorizontal aria-hidden="true" />
            <span>参数由已连接的配置节点统一管理</span>
          </div>
        ) : null}

        <div className="wc-generation-primary">
          <label className="wc-generation-field">
            <span>模型</span>
            <CategorizedModelSelect
              value={modelId}
              models={models}
              disabled={catalogLoading || !models.length || generationLocked}
              onChange={chooseModel}
              ariaLabel="模型"
            />
          </label>
          {model?.description ? (
            <p className="wc-generation-description">{model.description}</p>
          ) : null}
        </div>

        {model ? (
          <div className="wc-generation-parameters">
            {outputCountControl ? <OutputCountField {...outputCountControl} /> : null}
            {editableNonActionParameters.map((parameter) => (
              <GenerationParameterField
                key={`${model.id}:${parameter.name}`}
                parameter={parameter}
                value={parameters[parameter.name]}
                disabled={generationLocked}
                boundedDuration={modality === "video" || modality === "audio"}
                showHint
                onChange={(value) => updateParameter(parameter.name, value)}
                onValidityChange={(valid) => updateParameterValidity(parameter.name, valid)}
              />
            ))}
            {mjActionParameter ? (
              <FollowUpActionSection
                model={model}
                actionParameter={mjActionParameter}
                dependentParameters={mjDependentParameters}
                values={parameters}
                disabled={generationLocked}
                referenceImageCount={counts.images}
                onChange={updateParameter}
                onValidityChange={updateParameterValidity}
              />
            ) : null}
            {model.pricing.mode === "token" && !hasModelMaximumTokenParameter(model) ? (
              <label className="wc-generation-field">
                <span>最大输出</span>
                <input
                  type="number"
                  min={1}
                  max={1_000_000}
                  step={128}
                  value={maxOutputTokens ?? 1_024}
                  disabled={generationLocked}
                  onChange={(event) => updateMaximumTokens(Number(event.target.value))}
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {model &&
        references &&
        counts.images + counts.styleImages + counts.elementImages + counts.videos + counts.audios >
          0 ? (
          <div className="wc-generation-references" aria-label="参考素材">
            {counts.images ? (
              <span>
                {referenceImagePurposeLabel(model, "images")} {counts.images}
              </span>
            ) : null}
            {counts.styleImages ? (
              <span>
                {referenceImagePurposeLabel(model, "styleImages")} {counts.styleImages}
              </span>
            ) : null}
            {counts.elementImages ? (
              <span>
                {referenceImagePurposeLabel(model, "elementImages")} {counts.elementImages}
              </span>
            ) : null}
            {counts.videos ? <span>视频 {counts.videos}</span> : null}
            {counts.audios ? <span>音频 {counts.audios}</span> : null}
          </div>
        ) : null}

        {model && references ? (
          <ReferenceImagePurposeControls
            model={model}
            references={references}
            assignments={data.generation.referenceImagePurposes}
            disabled={generationLocked}
            onChange={(reference, purpose) =>
              updateReferenceImagePurpose(nodeId, reference, purpose)
            }
          />
        ) : null}

        {!isConfiguration && !activeJob && !awaitingConfirmation && data.generation.error ? (
          <div className="wc-generation-error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>{data.generation.error}</span>
            <button type="button" onClick={retryGeneration}>
              重试
            </button>
          </div>
        ) : null}
        {!isConfiguration && awaitingConfirmation && pendingAmbiguousIdentity ? (
          <div className="wc-generation-error" role="status">
            <AlertCircle aria-hidden="true" />
            <span>
              刷新前的提交可能已被受理，当前无法核对；确认任务记录后可以手动放弃再重新提交。
            </span>
            <button type="button" onClick={abandonAmbiguousSubmission}>
              放弃并重新提交
            </button>
          </div>
        ) : null}
        {unavailableModelError ? (
          <div className="wc-generation-error" role="alert">
            <AlertCircle aria-hidden="true" />
            {unavailableModelError}
          </div>
        ) : null}
        {!unavailableModelError && catalogError ? (
          <div className="wc-generation-error" role="alert">
            <AlertCircle aria-hidden="true" />
            {catalogError}
          </div>
        ) : null}
        {!isConfiguration && quoteError ? (
          <div className="wc-generation-error" role="alert">
            <AlertCircle aria-hidden="true" />
            {quoteError}
          </div>
        ) : null}

        {!isConfiguration && jobHistory.length ? (
          <section
            className={`wc-generation-history ${historyOpen ? "is-open" : ""}`}
            aria-label="最近任务"
          >
            <div className="wc-generation-history-header">
              <button
                type="button"
                aria-expanded={historyOpen}
                onClick={() => setHistoryOpen((value) => !value)}
              >
                <History aria-hidden="true" />
                <span>最近任务</span>
                <small>{jobHistory.length}</small>
                <ChevronDown className="wc-generation-history-chevron" aria-hidden="true" />
              </button>
              {historyOpen ? (
                <button
                  type="button"
                  className="wc-generation-history-refresh"
                  aria-label="刷新任务记录"
                  title="刷新任务记录"
                  disabled={refreshingHistory || identityStatus !== "authenticated"}
                  onClick={() => void refreshHistory()}
                >
                  <RotateCcw
                    className={refreshingHistory ? "is-spinning" : ""}
                    aria-hidden="true"
                  />
                </button>
              ) : null}
            </div>
            {historyOpen ? (
              <div className="wc-generation-history-list">
                {jobHistory.slice(0, 12).map((job) => {
                  const status = generationHistoryStatus(job);
                  const billing = generationBillingText(job);
                  return (
                    <div key={job.id} className={`wc-generation-history-row is-${status.tone}`}>
                      <i aria-hidden="true" />
                      <span>
                        <strong>{job.modelLabel}</strong>
                        <small>
                          {formatGenerationTime(job.createdAt)} · {job.quote.credits} 积分 ·{" "}
                          {pricingUnitText(job.quote.pricingUnit)}
                          {billing ? ` · ${billing}` : ""}
                        </small>
                        {job.error?.message ? <em>{job.error.message}</em> : null}
                      </span>
                      <b>{status.label}</b>
                    </div>
                  );
                })}
              </div>
            ) : null}
          </section>
        ) : null}
      </div>

      <footer className={`wc-generation-footer ${isConfiguration ? "is-config" : ""}`}>
        {isConfiguration ? (
          <div className="wc-config-target-count">
            <span>
              {configurationTargetCount
                ? `已同步 ${configurationTargetCount} 个${modalityOptions.find((item) => item.value === configurationModality)?.label ?? ""}节点`
                : "连接同类型节点后自动同步"}
            </span>
          </div>
        ) : (
          <div className="wc-generation-quote">
            {customSelected ? (
              <>
                <Check aria-hidden="true" />
                <span>可以生成</span>
              </>
            ) : null}
            {!customSelected && quote && quoteCredits !== null ? (
              <>
                <Check aria-hidden="true" />
                <span>
                  {quote.estimated ? "预计 " : ""}
                  {quoteCredits} 积分 · {pricingUnitText(quote.pricingUnit)}
                </span>
              </>
            ) : null}
            {!customSelected && quoteState === "error" && model && !referenceError ? (
              <button
                type="button"
                className="wc-generation-quote-retry"
                onClick={() => setQuoteRevision((value) => value + 1)}
              >
                <RotateCcw aria-hidden="true" />
                重新确认
              </button>
            ) : null}
          </div>
        )}
        <button
          ref={submitButtonRef}
          type="button"
          className="wc-generation-submit"
          disabled={
            isConfiguration
              ? !model || invalidParameters.size > 0
              : !model ||
                invalidParameters.size > 0 ||
                Boolean(referenceError) ||
                quoteState !== "ready" ||
                submitting ||
                generationLocked ||
                Boolean(unavailableModelError) ||
                (!customSelected && !quote)
          }
          onClick={() => (isConfiguration ? onClose() : void submit())}
        >
          {isConfiguration ? (
            <Check aria-hidden="true" />
          ) : generationBusy ? (
            <LoaderCircle className="is-spinning" aria-hidden="true" />
          ) : (
            <Sparkles aria-hidden="true" />
          )}
          {isConfiguration ? "完成配置" : "生成"}
        </button>
      </footer>
    </section>
  );

  return createPortal(
    <div
      className="wc-generation-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={isConfiguration ? "配置节点设置" : `${nodeLabel(data.kind)}生成设置`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {panel}
    </div>,
    document.body,
  );
}

function ReferenceImagePurposeControls({
  model,
  references,
  assignments,
  disabled,
  embedded = false,
  onChange,
}: {
  model: PublicModel;
  references: GenerationReferences;
  assignments: Readonly<Record<string, ReferenceImagePurpose>>;
  disabled: boolean;
  embedded?: boolean;
  onChange: (reference: MediaReference, purpose: ReferenceImagePurpose | "") => void;
}) {
  if (references.imagePurposes.length <= 1 || references.connectedImages.length === 0) return null;
  const options = [
    { value: "__unassigned__", label: "选择用途" },
    ...references.imagePurposes.map((purpose) => ({
      value: purpose,
      label: referenceImagePurposeLabel(model, purpose),
      meta: `${references[purpose].length}/${referenceImageMaximum(model, purpose)}`,
    })),
  ];
  return (
    <section
      className={`wc-generation-reference-roles ${embedded ? "is-embedded" : ""}`}
      aria-label="图片参考用途"
    >
      <span>图片用途</span>
      <div>
        {references.connectedImages.map((reference, index) => {
          const selected = referenceImagePurposeFor(assignments, reference);
          const value =
            selected && references.imagePurposes.includes(selected) ? selected : "__unassigned__";
          const label = reference.media.name || `参考图片 ${index + 1}`;
          return (
            <div className="wc-generation-reference-role" key={referenceMediaKey(reference)}>
              <span title={label}>{label}</span>
              <CanvasSelect
                value={value}
                options={options}
                ariaLabel={`${label}的参考用途`}
                disabled={disabled}
                variant="compact"
                menuMinWidth={150}
                onChange={(next) =>
                  onChange(
                    reference,
                    references.imagePurposes.includes(next as ReferenceImagePurpose)
                      ? (next as ReferenceImagePurpose)
                      : "",
                  )
                }
              />
            </div>
          );
        })}
      </div>
    </section>
  );
}

function CompactGenerationParameter({
  parameter,
  value,
  disabled,
  boundedDuration,
  onChange,
}: {
  parameter: ModelParameter;
  value: unknown;
  disabled: boolean;
  boundedDuration: boolean;
  onChange: (value: unknown) => void;
}) {
  const fieldDisabled = disabled || isGenerationParameterLocked(parameter);
  const displayValue = generationParameterDisplayValue(parameter, value);
  const durationOptions = boundedDuration ? boundedDurationOptions(parameter) : null;
  const selected = durationOptions
    ? normalizeBoundedDurationValue(parameter, displayValue)
    : displayValue;
  if (durationOptions) {
    return (
      <div
        className="wc-generation-compact-control wc-generation-parameter-control"
        title={parameter.label}
        onClick={clickNestedCanvasSelect}
      >
        <span>
          <small>{parameter.label}</small>
          <CanvasSelect
            ariaLabel={parameter.label}
            value={selected === undefined ? "__unset__" : JSON.stringify(selected)}
            options={[
              ...(selected === undefined ? [{ value: "__unset__", label: "请选择" }] : []),
              ...durationOptions.map((option) => ({
                value: JSON.stringify(option),
                label: `${option} 秒`,
              })),
            ]}
            disabled={fieldDisabled || durationOptions.length === 0}
            variant="compact"
            onChange={(next) => onChange(next === "__unset__" ? undefined : JSON.parse(next))}
          />
        </span>
      </div>
    );
  }
  const scalarOptions = generationParameterScalarOptions(parameter, selected);
  if (scalarOptions) {
    return (
      <div
        className="wc-generation-compact-control wc-generation-parameter-control"
        title={parameter.label}
        onClick={clickNestedCanvasSelect}
      >
        <span>
          <small>{parameter.label}</small>
          <CanvasSelect
            ariaLabel={parameter.label}
            value={selected === undefined ? "__unset__" : JSON.stringify(selected)}
            options={[
              ...(selected === undefined ? [{ value: "__unset__", label: "请选择" }] : []),
              ...scalarOptions.map((option) => ({
                value: JSON.stringify(option),
                label: generationParameterOptionLabel(parameter, option),
              })),
            ]}
            disabled={fieldDisabled}
            variant="compact"
            onChange={(next) => onChange(next === "__unset__" ? undefined : JSON.parse(next))}
          />
        </span>
      </div>
    );
  }
  if (parameter.type === "boolean") {
    return (
      <label className="wc-generation-compact-toggle" title={parameter.label}>
        <span>{parameter.label}</span>
        <input
          type="checkbox"
          aria-label={parameter.label}
          checked={Boolean(selected)}
          disabled={fieldDisabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <i aria-hidden="true" />
      </label>
    );
  }
  if (parameter.type === "integer" || parameter.type === "number") {
    return (
      <label
        className="wc-generation-compact-control wc-generation-parameter-control"
        title={parameter.label}
      >
        <span>
          <small>{parameter.label}</small>
          <input
            type="number"
            aria-label={parameter.label}
            value={typeof selected === "number" ? selected : ""}
            min={parameter.min}
            max={parameter.max}
            step={parameter.step ?? (parameter.type === "integer" ? 1 : "any")}
            required={parameter.required}
            disabled={fieldDisabled}
            onChange={(event) =>
              onChange(event.target.value === "" ? undefined : Number(event.target.value))
            }
          />
        </span>
      </label>
    );
  }
  return (
    <label
      className="wc-generation-compact-control wc-generation-parameter-control"
      title={parameter.label}
    >
      <span>
        <small>{parameter.label}</small>
        <input
          type="text"
          aria-label={parameter.label}
          value={generationParameterTextInputValue(parameter, selected)}
          minLength={parameter.minLength}
          maxLength={parameter.maxLength}
          required={parameter.required}
          disabled={fieldDisabled}
          onChange={(event) => onChange(event.target.value || undefined)}
        />
      </span>
    </label>
  );
}

function CompactMaximumTokens({
  value,
  disabled,
  onChange,
}: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label
      className="wc-generation-compact-control wc-generation-parameter-control"
      title="最大输出"
    >
      <span>
        <small>最大输出</small>
        <input
          type="number"
          aria-label="最大输出"
          min={1}
          max={1_000_000}
          step={128}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
      </span>
    </label>
  );
}

function OutputCountField({
  value,
  min,
  max,
  step,
  label,
  unit,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  unit: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const options = outputCountOptions(min, max, step, unit);
  return (
    <div className="wc-generation-field wc-generation-output-count" data-output-count-control>
      <span>{label}</span>
      <CanvasSelect
        value={String(value)}
        options={options}
        ariaLabel={label}
        disabled={disabled}
        onChange={(next) => onChange(Number(next))}
        menuMinWidth={120}
      />
    </div>
  );
}

function CompactOutputCount({
  value,
  min,
  max,
  step,
  label,
  unit,
  disabled,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  unit: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const options = outputCountOptions(min, max, step, unit);
  return (
    <div
      className="wc-generation-compact-control wc-generation-parameter-control wc-generation-output-count"
      title={label}
      data-output-count-control
    >
      <span>
        <small>{label}</small>
        <CanvasSelect
          value={String(value)}
          options={options}
          ariaLabel={label}
          variant="compact"
          disabled={disabled}
          onChange={(next) => onChange(Number(next))}
          menuMinWidth={120}
        />
      </span>
    </div>
  );
}

function outputCountOptions(min: number, max: number, step: number, unit: string) {
  const values: number[] = [];
  for (let value = min; value <= max; value += step) values.push(value);
  return values.map((value) => ({ value: String(value), label: `${value} ${unit}` }));
}

function findOutputCountParameter(model: PublicModel | null) {
  if (!model || model.modality !== "image") return null;
  return (
    model.parameters.find(
      (parameter) =>
        (parameter.type === "integer" || parameter.type === "number") &&
        /^(?:n|count)$/i.test(parameter.name),
    ) ?? null
  );
}

function resolveOutputCountRange(model: PublicModel | null, parameter: ModelParameter | null) {
  const fixedValue = parameter?.fixed === undefined ? null : Number(parameter.fixed);
  if (fixedValue !== null && Number.isFinite(fixedValue) && fixedValue >= 1) {
    const fixed = Math.max(1, Math.min(8, Math.round(fixedValue)));
    return { min: fixed, max: fixed, step: 1 };
  }
  const modelMin = model?.modality === "image" ? model.output.minCount : 1;
  const modelMax = model?.modality === "image" ? model.output.maxCount : 1;
  const min = Math.max(1, modelMin, parameter?.min ?? 1);
  const max = Math.max(min, Math.min(8, modelMax, parameter?.max ?? modelMax));
  const step = parameter?.step && parameter.step > 0 ? Math.max(1, Math.round(parameter.step)) : 1;
  return { min: Math.min(min, max), max, step };
}

function normalizeOutputQuantity(
  value: unknown,
  range: { min: number; max: number; step: number },
) {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.round(value) : range.min;
  const stepped = range.min + Math.round((numeric - range.min) / range.step) * range.step;
  return Math.max(range.min, Math.min(range.max, stepped));
}

function composeGenerationParameters(
  model: PublicModel,
  body: string,
  configured: Record<string, unknown>,
  outputCountParameter: ModelParameter | null,
  outputQuantity: number,
  videoDurations: number[] | null = null,
) {
  const parameters = composeModelParameters(model, body, configured);
  if (outputCountParameter && outputCountParameter.fixed === undefined) {
    parameters[outputCountParameter.name] = outputQuantity;
  }
  // 参考视频时长是随请求提交的目录参数（H3 要求它与参考视频成对出现），顺序
  // 与 inputs.videos 一致；模型没发布这个参数或没有参考视频时保持原样。
  if (videoDurations?.length) parameters[REFERENCE_VIDEO_DURATIONS_PARAMETER] = videoDurations;
  return parameters;
}

/**
 * A submission outcome the server may have accepted even though the browser
 * never received the confirmation. Such a request must stay locked with its
 * original identity instead of becoming a fresh failed task.
 */
function isAmbiguousSubmissionFailure(error: unknown) {
  if (error instanceof CanvasApiError) {
    return (
      error.code === "NETWORK_UNAVAILABLE" ||
      error.status === 408 ||
      error.status === 425 ||
      error.status >= 500
    );
  }
  return true;
}

function persistConfig(
  nodeId: string,
  modelId: string,
  parameters: Record<string, unknown>,
  maxOutputTokens: number | null,
  options: {
    resize?: boolean;
    recordResize?: boolean;
    preferredParameter?: string;
    userInitiated?: boolean;
    rememberModel?: PublicModel | null;
  } = {},
) {
  const state = useCanvasStore.getState();
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  if (options.resize) {
    state.resizeMediaNodeForGenerationParameters(nodeId, parameters, {
      record: options.recordResize,
      preferredParameter: options.preferredParameter,
      force: options.userInitiated,
    });
  }
  state.updateNodeData(
    nodeId,
    {
      generation: {
        ...node.data.generation,
        modelId,
        parameters,
        maxOutputTokens,
        // 只有创建者显式改动（选模型/改画幅参数）才把画幅标记为已配置；
        // 自动写入的模型默认值不得宣称这一点，否则刷新恢复会用它改写几何。
        ...(options.userInitiated && options.resize ? { aspectExplicit: true } : {}),
        error: null,
      },
    },
    false,
  );
  if (options.userInitiated && options.rememberModel) {
    useUiPreferencesStore.getState().setLastMediaGeneration(options.rememberModel.modality, {
      modelId,
      parameters,
      maxOutputTokens,
    });
  }
}

function updateReferenceImagePurpose(
  nodeId: string,
  reference: MediaReference,
  purpose: ReferenceImagePurpose | "",
) {
  const state = useCanvasStore.getState();
  const node = state.nodes.find((item) => item.id === nodeId);
  if (!node) return;
  const next = { ...node.data.generation.referenceImagePurposes };
  delete next[reference.media.id];
  if (reference.media.serverId) delete next[reference.media.serverId];
  if (purpose) next[referenceMediaKey(reference)] = purpose;
  state.updateNodeData(
    nodeId,
    {
      generation: {
        ...node.data.generation,
        referenceImagePurposes: next,
        error: null,
      },
    },
    false,
  );
}

function referenceImageMaximum(model: PublicModel, purpose: ReferenceImagePurpose) {
  const capability = referenceImageCapability(model, purpose);
  if (!capability) return 0;
  return capability.multiple ? (capability.max ?? 32) : Math.min(1, capability.max ?? 1);
}

function blockFilePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
  if (Array.from(event.clipboardData.items).some((item) => item.kind === "file"))
    event.preventDefault();
}

function jobStatusLabel(status: string) {
  if (status === "reserved" || status === "submitting") return "正在提交";
  if (status === "queued") return "正在排队";
  if (status === "validating") return "正在整理结果";
  if (status === "submission_unknown") return "正在确认任务";
  return "正在生成";
}

function clickNestedCanvasSelect(event: MouseEvent<HTMLElement>) {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".wc-canvas-select-trigger")) return;
  event.currentTarget
    .querySelector<HTMLButtonElement>(".wc-canvas-select-trigger:not(:disabled)")
    ?.click();
}

function generationHistoryStatus(job: PublicGenerationJob) {
  if (job.status === "completed") return { label: "已完成", tone: "success" } as const;
  if (job.status === "failed") return { label: "失败", tone: "error" } as const;
  if (job.status === "submission_unknown") return { label: "待确认", tone: "pending" } as const;
  return { label: jobStatusLabel(job.status), tone: "running" } as const;
}

function formatGenerationTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "时间未知";
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    "zh-CN",
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" },
  ).format(date);
}

function hasModelMaximumTokenParameter(model: PublicModel) {
  return model.parameters.some(
    (parameter) => parameter.name === "max_tokens" || parameter.name === "max_output_tokens",
  );
}
