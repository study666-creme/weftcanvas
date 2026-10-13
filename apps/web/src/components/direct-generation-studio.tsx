import type {
  CanvasMedia,
  GenerationArtifact,
  GenerationQuote,
  MediaKind,
  ModelInputCount,
  ModelParameter,
  PublicGenerationJob,
  PublicModel,
  ReferenceImagePurpose,
} from "@weftcanvas/contracts";
import {
  AlertCircle,
  ArrowDownToLine,
  ArrowRight,
  AtSign,
  Check,
  FileImage,
  FileVideo,
  Image as ImageIcon,
  ImagePlus,
  LoaderCircle,
  Maximize2,
  Music2,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trash2,
  Upload,
  Video,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useBoundedImage } from "../hooks/use-bounded-image";
import { useMediaUrl, useMediaThumbUrl } from "../hooks/use-media-url";
import {
  CanvasApiError,
  createGenerationQuote,
  createMediaUpload,
  createRequestKey,
  fetchMediaMetadata,
  listGenerationJobs,
  mediaContentPath,
  subscribeGenerationJob,
  submitGenerationJob,
  uploadMediaBlob,
} from "../lib/api-client";
import { ensureMediaAsset } from "../lib/asset-library-store";
import { downloadUrl } from "../lib/download";
import {
  DIRECT_GENERATION_NODE_IDS,
  DIRECT_GENERATION_PROJECT_ID,
  directGenerationArtifactKey,
  mergeDirectGenerationJobs,
  readDirectGenerationHiddenArtifacts,
  readDirectGenerationHistory,
  writeDirectGenerationHiddenArtifacts,
  writeDirectGenerationHistory,
} from "../lib/direct-generation-history";
import {
  composeModelParameters,
  defaultModelParameters,
  generationRequestQuantity,
  isModelBoundTextParameter,
  isModelCompatibilityParameterHidden,
  isModelInternalParameter,
  isModelMediaReferenceParameter,
  isUserFacingParameter,
  quoteTokenFields,
  reconcileModelParameters,
  removeModelParameter,
  requestPricedFixedOutputCount,
  setExclusiveParameter,
} from "../lib/generation-config";
import { validateImageBlob, validateMediaBlob } from "../lib/media-validation";
import { inferMaterialKind } from "../lib/media-kind";
import { cacheServerMedia } from "../lib/media-store";
import { requestConfirmation } from "../lib/confirmation";
import { planMaterialBatch } from "../lib/direct-generation-materials";
import { directMaterialControls, directMaterialMaximum } from "../lib/direct-material-controls";
import {
  directMentionCandidates,
  insertDirectMention,
  mentionQueryAtCursor,
  reconcileDirectMentions,
  type DirectMentionCandidate,
} from "../lib/direct-generation-mentions";
import {
  MAX_REFERENCE_VIDEO_TOTAL_SECONDS,
  REFERENCE_VIDEO_DURATIONS_PARAMETER,
  getReferenceImagePurposes,
  referenceImageCapability,
  referenceImagePurposeLabel,
  referenceVideoDurationsFromMedia,
  referenceVideoDurationsParameter,
} from "../lib/generation-inputs";
import {
  initialDirectDraftSession,
  persistDirectDraft,
  writeDirectDraftSession,
  type PersistedDirectDraft,
} from "../lib/direct-reference-session";
import { useDirectReferenceStore } from "../state/direct-reference-store";
import { useGenerationStore } from "../state/generation-store";
import { useIdentityStore } from "../state/identity-store";
import { useWalletStore } from "../state/wallet-store";
import { CategorizedModelSelect } from "./categorized-model-select";
import { pickDefaultModel, pricingUnitText } from "./generation-model-select";
import {
  GenerationParameterField,
  boundedDurationOptions,
  generationParameterDisplayValue,
  generationParameterScalarOptions,
  isGenerationParameterLocked,
  normalizeBoundedDurationValue,
} from "./generation-parameter-field";
import { ParameterChips } from "./parameter-chips";
import { CanvasSelect } from "./canvas-select";
import { MiniAudioPlayer } from "./mini-audio-player";
import { ResultLightbox, type ResultLightboxItem } from "./result-lightbox";

export type DirectModality = "image" | "video" | "audio";
type QuoteState = "idle" | "loading" | "ready" | "error";

type DirectReference = {
  id: string;
  kind: MediaKind;
  name: string;
  previewUrl: string | null;
  serverId: string | null;
  status: "uploading" | "ready" | "error";
  error: string | null;
  uploadKey: string;
  imagePurpose: ReferenceImagePurpose | null;
  // 视频/音频素材的时长（毫秒）：H3 要求参考视频成对声明时长，上传回包与补查
  // 都会填这里。与 useDirectReferenceStore 的类型保持一致。
  durationMs: number | null;
};

type DirectDraft = {
  prompt: string;
  modelId: string;
  parameters: Record<string, unknown>;
  maxOutputTokens: number | null;
  invalidParameters: Set<string>;
  quote: GenerationQuote | null;
  quoteState: QuoteState;
  quoteError: string | null;
  quoteRevision: number;
  quantity: number;
  submitting: boolean;
  submitLabel: string;
  jobs: PublicGenerationJob[];
  submissionUnknown: boolean;
  submissionError: string | null;
  references: DirectReference[];
  referenceError: string | null;
};

const MODALITIES: {
  value: DirectModality;
  label: string;
  description: string;
  icon: typeof ImageIcon;
}[] = [
  {
    value: "image",
    label: "图片生成",
    description: "用一句话得到可直接使用的画面",
    icon: ImageIcon,
  },
  {
    value: "video",
    label: "视频生成",
    description: "把想法变成一段有镜头感的动态片段",
    icon: Video,
  },
  {
    value: "audio",
    label: "音频生成",
    description: "一句话得到一段音乐或一条语音",
    icon: Music2,
  },
];

export function DirectGenerationStudio({
  modality,
  onModalityChange,
}: {
  modality: DirectModality;
  onModalityChange: (modality: DirectModality) => void;
}) {
  const [drafts, setDrafts] = useState<Record<DirectModality, DirectDraft>>(() => {
    const shared = useDirectReferenceStore.getState().references;
    const draftSession = initialDirectDraftSession();
    return {
      image: { ...createDraft(draftSession?.image), references: [...shared.image] },
      video: { ...createDraft(draftSession?.video), references: [...shared.video] },
      audio: { ...createDraft(draftSession?.audio), references: [...shared.audio] },
    };
  });
  const imageCatalog = useGenerationStore((state) => state.catalogs.image);
  const videoCatalog = useGenerationStore((state) => state.catalogs.video);
  const audioCatalog = useGenerationStore((state) => state.catalogs.audio);
  const loadCatalog = useGenerationStore((state) => state.loadCatalog);
  const identityStatus = useIdentityStore((state) => state.status);
  const identityUserId = useIdentityStore((state) => state.session?.user.id ?? null);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const expireIdentity = useIdentityStore((state) => state.expire);
  const loadWalletSummary = useWalletStore((state) => state.loadSummary);
  const draft = drafts[modality];
  const catalogState =
    modality === "image" ? imageCatalog : modality === "video" ? videoCatalog : audioCatalog;
  const previewUrls = useRef(new Set<string>());
  // 最新引用快照：effect 在每次提交后同步；addMaterials 提交时也同步追加，
  // 保证同一事件里并发添加也能看到彼此占用的容量。
  const referencesRef = useRef<DirectReference[]>(draft.references);
  const [historyUserId, setHistoryUserId] = useState<string | null>(null);
  const [hiddenArtifactKeys, setHiddenArtifactKeys] = useState<Set<string>>(() => new Set());
  const [materialDropActive, setMaterialDropActive] = useState(false);
  const [materialInputFeedback, setMaterialInputFeedback] = useState<string | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const [mentionRange, setMentionRange] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  // 放大查看的结果序号；null 表示关闭。存序号而非 id，便于左右切换。
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const updateDraft = (target: DirectModality, patch: Partial<DirectDraft>) => {
    setDrafts((current) => ({ ...current, [target]: { ...current[target], ...patch } }));
  };

  // Keep the shared reference store (home gate ↔ studio) in sync with the draft.
  useEffect(() => {
    useDirectReferenceStore.getState().setReferences("image", drafts.image.references);
  }, [drafts.image.references]);
  useEffect(() => {
    useDirectReferenceStore.getState().setReferences("video", drafts.video.references);
  }, [drafts.video.references]);
  useEffect(() => {
    useDirectReferenceStore.getState().setReferences("audio", drafts.audio.references);
  }, [drafts.audio.references]);

  // 草稿写穿：提示词/模型/参数/数量一变化就写入标签页会话，刷新与提交后保留。
  // 每次 setDrafts 都产生新对象，这里只在可持久化字段变化时重算，避免把
  // 任务轮询/报价等高频状态变更刷进 sessionStorage。
  const persistedDrafts = useMemo(
    () => ({
      image: persistDirectDraft(drafts.image),
      video: persistDirectDraft(drafts.video),
      audio: persistDirectDraft(drafts.audio),
    }),
    [
      drafts.image.prompt,
      drafts.image.modelId,
      drafts.image.parameters,
      drafts.image.quantity,
      drafts.image.maxOutputTokens,
      drafts.video.prompt,
      drafts.video.modelId,
      drafts.video.parameters,
      drafts.video.quantity,
      drafts.video.maxOutputTokens,
      drafts.audio.prompt,
      drafts.audio.modelId,
      drafts.audio.parameters,
      drafts.audio.quantity,
      drafts.audio.maxOutputTokens,
    ],
  );
  const persistedDraftsKey = JSON.stringify(persistedDrafts);
  useEffect(() => {
    writeDirectDraftSession(persistedDrafts);
  }, [persistedDraftsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 首页跳转参数是一次性的：首次进入据此建立草稿并写入会话后，即从地址栏移除
  // prompt/model/p_*，否则刷新页面时旧参数会覆盖用户在工作室里修改过的新草稿。
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      let changed = false;
      if (url.searchParams.has("prompt") || url.searchParams.has("model")) {
        url.searchParams.delete("prompt");
        url.searchParams.delete("model");
        changed = true;
      }
      for (const key of Array.from(url.searchParams.keys())) {
        if (key.startsWith("p_")) {
          url.searchParams.delete(key);
          changed = true;
        }
      }
      if (changed) {
        window.history.replaceState(
          null,
          "",
          url.pathname + (url.search ? `?${url.searchParams.toString()}` : ""),
        );
      }
    } catch {
      // 地址栏不可写时忽略：仅影响刷新恢复来源，不破坏本次页面状态。
    }
  }, []);

  useEffect(() => {
    referencesRef.current = draft.references;
  }, [draft.references]);

  useEffect(
    () => () => {
      for (const url of previewUrls.current) URL.revokeObjectURL(url);
      previewUrls.current.clear();
    },
    [],
  );

  useEffect(() => {
    void Promise.all([loadCatalog("image"), loadCatalog("video")]);
  }, [loadCatalog]);

  const models = useMemo(() => {
    return (catalogState.data?.models ?? []).filter((model) => model.modality === modality);
  }, [catalogState.data?.models, modality]);
  const model = models.find((item) => item.id === draft.modelId) ?? null;
  const imagePurposes = useMemo(() => (model ? getReferenceImagePurposes(model) : []), [model]);

  useEffect(() => {
    setMaterialDropActive(false);
    setMaterialInputFeedback(null);
  }, [modality, model?.id]);

  const referenceInputs = useMemo(
    () => directReferenceInputs(draft.references, model),
    [draft.references, model],
  );
  // H3 系列要求参考视频与时长成对提交（目录里的 required_with）。顺序与
  // directReferenceInputs 的就绪视频一致；量不出时长的素材不阻塞提交，由服务端
  // 从素材元数据兜底推导，但报价会因此不含参考视频秒数，所以下面会补查。
  const videoDurations = useMemo(() => {
    if (!model || !referenceVideoDurationsParameter(model)) return null;
    const readyVideos = draft.references.filter(
      (reference) =>
        reference.kind === "video" && reference.status === "ready" && reference.serverId,
    );
    return referenceVideoDurationsFromMedia(readyVideos.map((reference) => reference.durationMs));
  }, [draft.references, model]);
  const mentionCandidates = useMemo(
    () => directMentionCandidates(draft.references),
    [draft.references],
  );
  const visibleMentionCandidates = useMemo(() => {
    if (!mentionRange) return [];
    const query = mentionRange.query.toLocaleLowerCase("zh-CN");
    return mentionCandidates.filter((candidate) =>
      `${candidate.label} ${candidate.name}`.toLocaleLowerCase("zh-CN").includes(query),
    );
  }, [mentionCandidates, mentionRange]);
  const referenceCounts = useMemo(
    () => ({
      images: referenceInputs.images.length,
      styleImages: referenceInputs.styleImages.length,
      elementImages: referenceInputs.elementImages.length,
      videos: referenceInputs.videos.length,
      audios: referenceInputs.audios.length,
    }),
    [referenceInputs],
  );
  const referenceIssue = model ? directReferenceIssue(model, draft.references) : null;
  const materialControls = useMemo(
    () => directMaterialControls(model, draft.references),
    [model, draft.references],
  );
  const imagePurposeOptions = model
    ? [
        { value: "__unassigned__", label: "选择用途" },
        ...imagePurposes.map((purpose) => ({
          value: purpose,
          label: referenceImagePurposeLabel(model, purpose),
          meta: `${referenceInputs[purpose].length}/${directReferenceMaximum(referenceImageCapability(model, purpose), "image")}`,
        })),
      ]
    : [];
  const acceptedMaterialLabels = materialControls
    .filter((control) => control.max > 0)
    .map((control) => control.label)
    .join("、");
  const promptRequired = Boolean(
    model &&
    (model.input.textRequired ||
      model.parameters.some(
        (parameter) => isModelBoundTextParameter(model, parameter) && parameter.required,
      )),
  );
  const editableParameters = useMemo(
    () =>
      model?.parameters.filter(
        (parameter) =>
          !isModelBoundTextParameter(model, parameter) &&
          !isModelInternalParameter(parameter) &&
          !isModelMediaReferenceParameter(model, parameter) &&
          !isModelCompatibilityParameterHidden(model, parameter) &&
          // 工作台面向需要精确控制出图规格的用户，分辨率与尺寸参数要可选；
          // 节点画布的简化入口仍然隐藏它们。
          isUserFacingParameter(parameter, { exposeDimensions: true }) &&
          !(modality === "image" && isOutputParameter(parameter)),
      ) ?? [],
    [model, modality],
  );
  // 视频 token 模型（Seedance）的 token 用量由上游按帧数/分辨率决定，
  // 「最大输出」输入框对视频没有意义，只在文本模态给出。
  const hasStandaloneTokenMaximum = Boolean(
    model?.pricing.mode === "token" &&
    modality !== "video" &&
    !model.parameters.some(
      (parameter) => parameter.name === "max_output_tokens" || parameter.name === "max_tokens",
    ),
  );
  const requiredParameterMissing = Boolean(
    model &&
    editableParameters.some(
      (parameter) =>
        parameter.required &&
        !hasParameterValue(draft.parameters[parameter.name] ?? parameter.default),
    ),
  );
  const promptMissing = promptRequired && !draft.prompt.trim();
  const inputInvalid =
    draft.invalidParameters.size > 0 ||
    requiredParameterMissing ||
    promptMissing ||
    Boolean(referenceIssue);
  const outputParameter = modality === "image" ? findOutputParameter(model) : null;
  const outputRange =
    outputParameter && model
      ? outputCountRange(model, outputParameter)
      : modelOutputCountRange(modality === "image" ? model : null);
  const selectedQuantity =
    modality === "image"
      ? outputParameter
        ? clampInteger(
            Number(
              draft.parameters[outputParameter.name] ?? outputParameter.default ?? outputRange.min,
            ),
            outputRange.min,
            outputRange.max,
          )
        : clampInteger(draft.quantity, outputRange.min, outputRange.max)
      : 1;
  const requestFixedOutputCount = requestPricedFixedOutputCount(model);
  const requestQuantity =
    modality === "image"
      ? generationRequestQuantity(model, Boolean(outputParameter), selectedQuantity)
      : 1;
  const activeJobs = draft.jobs.filter((job) => !isTerminalJob(job));
  const latestJob = draft.jobs[0] ?? null;
  const latestCompletedJob = useMemo(
    () => draft.jobs.find((job) => job.status === "completed") ?? null,
    [draft.jobs],
  );
  const completedArtifacts = useMemo(
    () =>
      draft.jobs
        .filter((job) => job.status === "completed")
        .flatMap((job) =>
          job.artifacts
            .filter((artifact) => artifact.kind === modality && "mediaId" in artifact)
            .filter(
              (artifact) =>
                !hiddenArtifactKeys.has(directGenerationArtifactKey(job.id, artifact.id)),
            )
            .map((artifact) => ({ job, artifact })),
        ),
    [draft.jobs, hiddenArtifactKeys, modality],
  );
  const locked = Boolean(draft.submitting);

  useEffect(() => {
    if (!models.length) {
      if (draft.modelId)
        updateDraft(modality, { modelId: "", parameters: {}, quote: null, quoteState: "idle" });
      return;
    }
    setDrafts((current) => {
      const target = current[modality];
      const selected =
        models.find((item) => item.id === target.modelId) ?? pickDefaultModel(models)!;
      const nextParameters =
        selected.id === target.modelId
          ? reconcileModelParameters(selected, target.parameters)
          : defaultModelParameters(selected);
      const nextMaximum =
        selected.pricing.mode === "token" &&
        modality !== "video" &&
        !selected.parameters.some(
          (parameter) => parameter.name === "max_output_tokens" || parameter.name === "max_tokens",
        )
          ? selected.id === target.modelId
            ? (target.maxOutputTokens ?? 1_024)
            : 1_024
          : null;
      if (
        selected.id === target.modelId &&
        JSON.stringify(nextParameters) === JSON.stringify(target.parameters) &&
        nextMaximum === target.maxOutputTokens
      ) {
        return current;
      }
      return {
        ...current,
        [modality]: {
          ...target,
          modelId: selected.id,
          parameters: nextParameters,
          maxOutputTokens: nextMaximum,
          invalidParameters: new Set(),
          quote: null,
          quoteState: "idle",
          quoteError: null,
          quoteRevision: target.quoteRevision + 1,
        },
      };
    });
  }, [modality, models]);

  const quoteSequence = useRef(0);
  useEffect(() => {
    const sequence = ++quoteSequence.current;
    if (!model || !catalogState.data) {
      updateDraft(modality, { quote: null, quoteState: "idle", quoteError: null });
      return;
    }
    if (draft.submitting) return;
    if (!catalogState.data.quoteAvailable) {
      updateDraft(modality, {
        quote: null,
        quoteState: "error",
        quoteError: "当前模型价格暂不可用，请稍后重试",
      });
      return;
    }
    if (inputInvalid) {
      updateDraft(modality, {
        quote: null,
        quoteState: promptMissing ? "idle" : "error",
        quoteError: promptMissing ? null : (referenceIssue ?? "有参数尚未填写完整"),
      });
      return;
    }
    updateDraft(modality, { quoteState: "loading", quoteError: null });
    const timer = window.setTimeout(() => {
      const parameters = composeModelParameters(model, draft.prompt, draft.parameters);
      // 参考视频时长跟着报价一起发：服务端按同一份参数重建报价，少发这一项会
      // 让参考素材的秒数掉出预扣，实扣随之超过预扣。
      if (videoDurations?.length) parameters[REFERENCE_VIDEO_DURATIONS_PARAMETER] = videoDurations;
      const tokenFields = quoteTokenFields(
        model,
        draft.prompt,
        draft.parameters,
        draft.maxOutputTokens,
      );
      void createGenerationQuote({
        modelId: model.id,
        modality,
        parameters,
        inputs: referenceCounts,
        quantity: requestQuantity,
        ...tokenFields,
      })
        .then((quote) => {
          if (quoteSequence.current !== sequence) return;
          updateDraft(modality, { quote, quoteState: "ready", quoteError: null });
        })
        .catch((cause) => {
          if (quoteSequence.current !== sequence) return;
          updateDraft(modality, {
            quote: null,
            quoteState: "error",
            quoteError: cause instanceof CanvasApiError ? cause.message : "暂时无法确认本次价格",
          });
        });
    }, 240);
    return () => window.clearTimeout(timer);
  }, [
    catalogState.data,
    draft.maxOutputTokens,
    draft.parameters,
    draft.prompt,
    draft.quantity,
    draft.quoteRevision,
    inputInvalid,
    modality,
    model,
    outputParameter,
    promptMissing,
    referenceCounts.audios,
    referenceCounts.elementImages,
    referenceCounts.images,
    referenceCounts.styleImages,
    referenceCounts.videos,
    referenceIssue,
    requestQuantity,
    selectedQuantity,
    videoDurations,
  ]);

  const watcherRef = useRef<Map<string, () => void>>(new Map());
  useEffect(
    () => () => {
      for (const stop of watcherRef.current.values()) stop();
      watcherRef.current.clear();
    },
    [identityUserId],
  );

  // Auto-submit once when arriving from the home gate with a composed prompt.
  // Waits for the quote to be ready, then triggers the same submit path the
  // button uses, so materials and @mentions the user set on the gate carry over.
  const autoSubmittedRef = useRef(false);
  useEffect(() => {
    if (autoSubmittedRef.current) return;
    let wants = false;
    try {
      wants = new URLSearchParams(window.location.search).get("autosubmit") === "1";
    } catch {
      /* ignore */
    }
    if (!wants) return;
    if (!model || !draft.quote || draft.quoteState !== "ready" || inputInvalid || locked) return;
    if (!draft.prompt.trim()) return;
    autoSubmittedRef.current = true;
    // Clean the flag from the URL so a manual refresh doesn't re-submit.
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("autosubmit");
      window.history.replaceState(
        null,
        "",
        url.pathname + (url.search ? `?${url.searchParams.toString()}` : ""),
      );
    } catch {
      /* ignore */
    }
    void submit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, draft.quote, draft.quoteState, draft.prompt, inputInvalid, locked]);

  const updateJob = useCallback(
    (target: DirectModality, job: PublicGenerationJob) => {
      persistGeneratedJobArtifacts(job);
      setDrafts((current) => {
        const draftState = current[target];
        const existing = draftState.jobs.find((item) => item.id === job.id);
        if (existing && existing.version >= job.version) return current;
        const jobs = [job, ...draftState.jobs.filter((item) => item.id !== job.id)].slice(0, 40);
        return {
          ...current,
          [target]: {
            ...draftState,
            jobs,
            submissionUnknown: draftState.submissionUnknown || job.status === "submission_unknown",
            submissionError: null,
            submitting: false,
            submitLabel: "生成",
          },
        };
      });
      if (isTerminalJob(job)) {
        watcherRef.current.get(job.id)?.();
        watcherRef.current.delete(job.id);
        void loadWalletSummary(true);
      }
    },
    [loadWalletSummary],
  );

  const watch = useCallback(
    (target: DirectModality, job: PublicGenerationJob) => {
      if (isTerminalJob(job) || watcherRef.current.has(job.id)) return;
      const stop = subscribeGenerationJob(job.id, {
        onJob: (next) => updateJob(target, next),
        onSessionExpired: () => expireIdentity(),
      });
      watcherRef.current.set(job.id, stop);
    },
    [expireIdentity, updateJob],
  );

  useEffect(() => {
    if (identityStatus !== "authenticated" || !identityUserId) {
      setHistoryUserId(null);
      setHiddenArtifactKeys(new Set());
      setDrafts((current) => ({
        image: { ...current.image, jobs: [], submissionUnknown: false, submissionError: null },
        video: { ...current.video, jobs: [], submissionUnknown: false, submissionError: null },
        audio: { ...current.audio, jobs: [], submissionUnknown: false, submissionError: null },
      }));
      return;
    }

    let active = true;
    const stored = readDirectGenerationHistory(identityUserId);
    setHiddenArtifactKeys(readDirectGenerationHiddenArtifacts(identityUserId));
    for (const job of [...stored.image, ...stored.video, ...stored.audio]) {
      persistGeneratedJobArtifacts(job);
      watch(job.modality as DirectModality, job);
    }
    setDrafts((current) => ({
      image: { ...current.image, jobs: stored.image },
      video: { ...current.video, jobs: stored.video },
      audio: { ...current.audio, jobs: stored.audio },
    }));
    setHistoryUserId(identityUserId);

    void listGenerationJobs(DIRECT_GENERATION_PROJECT_ID, 100)
      .then((jobs) => {
        if (!active || useIdentityStore.getState().session?.user.id !== identityUserId) return;
        for (const job of jobs) {
          persistGeneratedJobArtifacts(job);
          if (job.modality === "image" || job.modality === "video" || job.modality === "audio")
            watch(job.modality, job);
        }
        setDrafts((current) => {
          const merged = mergeDirectGenerationJobs(
            {
              image: current.image.jobs,
              video: current.video.jobs,
              audio: current.audio.jobs,
            },
            jobs,
          );
          return {
            image: { ...current.image, jobs: merged.image },
            video: { ...current.video, jobs: merged.video },
            audio: { ...current.audio, jobs: merged.audio },
          };
        });
      })
      .catch((cause) => {
        if (active && cause instanceof CanvasApiError && cause.status === 401) expireIdentity();
      });

    return () => {
      active = false;
    };
  }, [expireIdentity, identityStatus, identityUserId, watch]);

  useEffect(() => {
    if (!identityUserId || historyUserId !== identityUserId) return;
    writeDirectGenerationHistory(identityUserId, {
      image: drafts.image.jobs,
      video: drafts.video.jobs,
      audio: drafts.audio.jobs,
    });
  }, [drafts.image.jobs, drafts.video.jobs, drafts.audio.jobs, historyUserId, identityUserId]);

  const removeGeneratedArtifact = (jobId: string, artifactId: string) => {
    if (!identityUserId) return;
    const key = directGenerationArtifactKey(jobId, artifactId);
    setHiddenArtifactKeys((current) => {
      if (current.has(key)) return current;
      const next = new Set(current);
      next.add(key);
      writeDirectGenerationHiddenArtifacts(identityUserId, next);
      return next;
    });
  };

  const chooseModel = (nextId: string) => {
    const nextModel = models.find((item) => item.id === nextId);
    if (!nextModel || locked) return;
    const nextOutputParameter = modality === "image" ? findOutputParameter(nextModel) : null;
    const nextRange = nextOutputParameter
      ? outputCountRange(nextModel, nextOutputParameter)
      : modelOutputCountRange(modality === "image" ? nextModel : null);
    updateDraft(modality, {
      modelId: nextId,
      parameters: defaultModelParameters(nextModel),
      maxOutputTokens:
        nextModel.pricing.mode === "token" &&
        modality !== "video" &&
        !nextModel.parameters.some(
          (parameter) => parameter.name === "max_output_tokens" || parameter.name === "max_tokens",
        )
          ? 1_024
          : null,
      invalidParameters: new Set(),
      quote: null,
      quoteState: "idle",
      quoteError: null,
      quoteRevision: draft.quoteRevision + 1,
      quantity: nextRange.min,
      jobs: draft.jobs,
      submissionUnknown: false,
      submissionError: null,
    });
  };

  const updateParameter = (name: string, value: unknown) => {
    if (!model || locked) return;
    const parameters =
      value === undefined
        ? removeModelParameter(model, draft.parameters, name)
        : setExclusiveParameter(model, draft.parameters, name, value);
    updateDraft(modality, {
      parameters,
      quote: null,
      quoteState: "idle",
      quoteRevision: draft.quoteRevision + 1,
    });
  };

  const updatePrompt = (value: string, cursor: number) => {
    updateDraft(modality, {
      prompt: value,
      quote: null,
      quoteState: "idle",
      quoteRevision: draft.quoteRevision + 1,
    });
    const nextRange = mentionQueryAtCursor(value, cursor);
    setMentionRange(nextRange);
    setMentionIndex(0);
  };

  const reusePromptFromJob = (job: PublicGenerationJob) => {
    const prompt = typeof job.parameters?.prompt === "string" ? job.parameters.prompt : "";
    if (!prompt) return;
    updatePrompt(prompt, prompt.length);
    requestAnimationFrame(() => {
      const textarea = promptRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(prompt.length, prompt.length);
    });
  };

  // 把任务提交时的图片参考素材一键放回素材区（去重后按原用途归桶，
  // 模型不支持某用途时回落到该模型的第一个可用用途）。全部来自用户
  // 自己的媒体，直接以 serverId 引用，无需重新上传。
  const reuseReferencesFromJob = (job: PublicGenerationJob) => {
    const inputs = job.inputs;
    if (!inputs) return;
    const buckets: Array<[ReferenceImagePurpose, string[] | undefined]> = [
      ["images", inputs.images],
      ["styleImages", inputs.styleImages],
      ["elementImages", inputs.elementImages],
    ];
    const supported = model ? getReferenceImagePurposes(model) : [];
    const existing = new Set(
      referencesRef.current
        .filter((reference) => reference.kind === "image" && reference.serverId)
        .map((reference) => reference.serverId),
    );
    const additions: DirectReference[] = [];
    for (const [bucket, mediaIds] of buckets) {
      for (const serverId of mediaIds ?? []) {
        if (!serverId || existing.has(serverId)) continue;
        existing.add(serverId);
        const purpose = supported.includes(bucket) ? bucket : (supported[0] ?? null);
        additions.push({
          id: crypto.randomUUID(),
          kind: "image",
          name: `参考图 ${serverId.slice(0, 10)}`,
          previewUrl: mediaContentPath(serverId),
          serverId,
          status: "ready",
          error: null,
          uploadKey: createRequestKey("direct-reference-reuse"),
          imagePurpose: purpose,
          durationMs: null,
        });
      }
    }
    if (!additions.length) return;
    setDrafts((current) => {
      const nextDraft = current[modality];
      return {
        ...current,
        [modality]: {
          ...nextDraft,
          references: [...nextDraft.references, ...additions],
          quote: null,
          quoteState: "idle",
          quoteError: null,
          quoteRevision: nextDraft.quoteRevision + 1,
        },
      };
    });
    referencesRef.current = [...referencesRef.current, ...additions];
  };

  // 放大查看列表与画廊同序，索引可以直接映射回 job/artifact，无需解析 key。
  const lightboxItems = useMemo<ResultLightboxItem[]>(
    () =>
      completedArtifacts.flatMap(({ job, artifact }) => {
        if (artifact.kind !== "image" && artifact.kind !== "video") return [];
        return [
          {
            key: `${job.id}:${artifact.id}`,
            kind: artifact.kind,
            media: mediaFromArtifact(artifact),
            name: artifact.name,
            prompt: typeof job.parameters?.prompt === "string" ? job.parameters.prompt : "",
            modelLabel: job.modelLabel,
          },
        ];
      }),
    [completedArtifacts],
  );

  const openLightbox = (key: string) => {
    const index = lightboxItems.findIndex((item) => item.key === key);
    if (index >= 0) setLightboxIndex(index);
  };

  const removeLightboxItem = (item: ResultLightboxItem) => {
    const index = lightboxItems.findIndex((entry) => entry.key === item.key);
    const target = completedArtifacts[index];
    if (!target) return;
    removeGeneratedArtifact(target.job.id, target.artifact.id);
    // 删掉当前项后列表变短，序号回退一格；删完后由渲染处的长度判断负责关闭。
    setLightboxIndex((current) =>
      current === null ? null : Math.max(0, current - (index < current ? 1 : 0)),
    );
  };

  const reuseLightboxPrompt = (item: ResultLightboxItem) => {
    const index = lightboxItems.findIndex((entry) => entry.key === item.key);
    const target = completedArtifacts[index];
    if (target) reusePromptFromJob(target.job);
    setLightboxIndex(null);
  };

  const chooseMention = (candidate: DirectMentionCandidate) => {
    if (!mentionRange) return;
    const next = insertDirectMention(draft.prompt, mentionRange, candidate);
    updatePrompt(next.value, next.cursor);
    requestAnimationFrame(() => {
      const textarea = promptRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const mentionReference = (reference: DirectReference) => {
    if (reference.status !== "ready") return;
    const candidate = mentionCandidates.find((item) => item.id === reference.id);
    if (!candidate) return;
    const textarea = promptRef.current;
    const cursor = textarea?.selectionStart ?? draft.prompt.length;
    const next = insertDirectMention(draft.prompt, { start: cursor, end: cursor }, candidate);
    updatePrompt(next.value, next.cursor);
    setMentionRange(null);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(next.cursor, next.cursor);
    });
  };

  const updateQuantity = (value: number) => {
    if (!model || locked || modality !== "image") return;
    const next = clampInteger(value, outputRange.min, outputRange.max);
    if (outputParameter && outputParameter.fixed === undefined) {
      updateParameter(outputParameter.name, next);
      return;
    }
    if (outputParameter) return;
    updateDraft(modality, {
      quantity: next,
      quote: null,
      quoteState: "idle",
      quoteRevision: draft.quoteRevision + 1,
    });
  };

  const updateReference = (target: DirectModality, id: string, patch: Partial<DirectReference>) => {
    setDrafts((current) => {
      const targetDraft = current[target];
      if (!targetDraft.references.some((reference) => reference.id === id)) return current;
      return {
        ...current,
        [target]: {
          ...targetDraft,
          references: targetDraft.references.map((reference) =>
            reference.id === id ? { ...reference, ...patch } : reference,
          ),
          quote: null,
          quoteState: "idle",
          quoteError: null,
          quoteRevision: targetDraft.quoteRevision + 1,
        },
      };
    });
  };

  // 会话恢复的旧素材（v1 会话、升级前上传的素材）没有带出时长，而 H3 要求参考
  // 视频成对声明时长。这里按需补查一次素材元数据：查到就回填，报价与提交随即
  // 带上 referenceVideoDurations；查不到也不阻塞，服务端仍会自己推导。
  const durationBackfillRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!model || !referenceVideoDurationsParameter(model)) return;
    const missing = draft.references.filter(
      (reference) =>
        reference.kind === "video" &&
        reference.status === "ready" &&
        reference.serverId &&
        reference.durationMs === null &&
        !durationBackfillRef.current.has(reference.id),
    );
    for (const reference of missing) {
      durationBackfillRef.current.add(reference.id);
      const mediaId = reference.serverId!;
      void fetchMediaMetadata(mediaId)
        .then((media) => {
          if (media.kind !== "video") return;
          updateReference(modality, reference.id, { durationMs: media.durationMs ?? null });
        })
        .catch(() => {
          // 失败允许下次重试：清掉标记，下一个引用变更或重新挂载会再查。
          durationBackfillRef.current.delete(reference.id);
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.references, model, modality]);

  const requireAuthenticatedIdentity = async () => {
    const identity = useIdentityStore.getState();
    if (identity.status === "idle" || identity.status === "loading") await identity.hydrate();
    if (useIdentityStore.getState().status === "authenticated") return true;
    openAccount("login");
    return false;
  };

  const addMaterials = async (kind: MediaKind, files: File[]) => {
    if (!model || locked || !files.length) return;
    if (!(await requireAuthenticatedIdentity())) return;

    // 容量检查用「最新引用」ref：每次提交后由 effect 同步，本函数提交时
    // 同步追加，保证同一次事件里并发调用也能看到彼此占用的名额。
    const max = directMaterialMaximum(model, kind);
    const existing = referencesRef.current.filter((reference) => reference.kind === kind).length;
    const plan = planMaterialBatch(existing, max, files.length);
    if (plan.full) {
      updateDraft(modality, { referenceError: `当前模型不能再添加${materialKindLabel(kind)}素材` });
      return;
    }
    const acceptedFiles = files.slice(0, plan.accepted);
    // 计划在更新函数之外预生成：React 的 state 更新函数在渲染期执行（开发
    // 模式 StrictMode 下还会执行两次），不能在更新函数里生成 id 或收集副作用。
    const pending = acceptedFiles.map<DirectReference>((file) => ({
      id: crypto.randomUUID(),
      kind,
      name: (file.name || `${materialKindLabel(kind)}素材`).slice(0, 255),
      previewUrl: null,
      serverId: null,
      status: "uploading",
      error: null,
      uploadKey: createRequestKey("direct-material"),
      imagePurpose: kind === "image" && imagePurposes.length === 1 ? imagePurposes[0]! : null,
      durationMs: null,
    }));
    setDrafts((current) => {
      const targetDraft = current[modality];
      return {
        ...current,
        [modality]: {
          ...targetDraft,
          references: [...targetDraft.references, ...pending],
          referenceError:
            plan.overflow > 0 ? `当前模型最多支持 ${max} 个${materialKindLabel(kind)}素材` : null,
          quote: null,
          quoteState: "idle",
          quoteError: null,
          quoteRevision: targetDraft.quoteRevision + 1,
        },
      };
    });
    referencesRef.current = [...referencesRef.current, ...pending];

    // 每个文件独立并行上传：验证、拿上传意图、上传、回填结果互不阻塞，
    // 单个失败只标记自己，不影响同批其他素材。
    void Promise.all(
      pending.map(async (reference, index) => {
        try {
          const validated =
            kind === "image"
              ? await validateImageBlob(acceptedFiles[index]!)
              : await validateMediaBlob(acceptedFiles[index]!, kind);
          if (validated.mimeType === "image/svg+xml")
            throw new Error("暂不支持 SVG 图片，请上传 PNG、JPEG 或 WebP");
          const previewUrl = URL.createObjectURL(validated.blob);
          previewUrls.current.add(previewUrl);
          updateReference(modality, reference.id, { previewUrl });
          const intent = await createMediaUpload({
            kind,
            name: (acceptedFiles[index]!.name || `${materialKindLabel(kind)}素材`).slice(0, 255),
            mimeType: validated.mimeType,
            size: validated.blob.size,
            idempotencyKey: reference.uploadKey,
          });
          const ready = intent.upload
            ? await uploadMediaBlob(intent.media, intent.upload, validated.blob)
            : intent.media;
          if (ready.status !== "ready")
            throw new Error(ready.error?.message ?? `${materialKindLabel(kind)}素材处理失败`);
          updateReference(modality, reference.id, {
            serverId: ready.id,
            status: "ready",
            error: null,
            // 上传回包里就带探测出的时长（视频/音频才有）：H3 的参考视频必须成对
            // 声明时长，拿到就不必再查一次素材元数据。
            durationMs: kind === "image" ? null : (ready.durationMs ?? null),
          });
        } catch (cause) {
          if (cause instanceof CanvasApiError && cause.status === 401) expireIdentity();
          updateReference(modality, reference.id, {
            status: "error",
            error:
              cause instanceof Error ? cause.message : `${materialKindLabel(kind)}素材上传失败`,
          });
        }
      }),
    );
  };

  const addInferredMaterials = async (files: File[]) => {
    if (!model || locked || !files.length) return;
    const allowedKinds = new Set(
      materialControls.filter((control) => control.max > 0).map((control) => control.kind),
    );
    const grouped = new Map<MediaKind, File[]>();
    const rejected: string[] = [];

    for (const file of files) {
      const kind = await inferMaterialKind(file);
      if (!kind) {
        rejected.push(file.name || "未识别文件");
        continue;
      }
      if (!allowedKinds.has(kind)) {
        rejected.push(`${file.name || materialKindLabel(kind)}（${materialKindLabel(kind)}素材）`);
        continue;
      }
      const matching = grouped.get(kind) ?? [];
      matching.push(file);
      grouped.set(kind, matching);
    }

    if (!grouped.size) {
      setMaterialInputFeedback(
        rejected.length ? `当前模型不支持或无法识别：${rejected.join("、")}` : "没有可上传的素材",
      );
      return;
    }

    setMaterialInputFeedback(rejected.length ? `已忽略不支持的素材：${rejected.join("、")}` : null);
    await Promise.all(
      [...grouped.entries()].map(([kind, groupedFiles]) => addMaterials(kind, groupedFiles)),
    );
  };

  const removeMaterial = (reference: DirectReference) => {
    if (locked || reference.status === "uploading") return;
    if (reference.previewUrl) {
      URL.revokeObjectURL(reference.previewUrl);
      previewUrls.current.delete(reference.previewUrl);
    }
    setDrafts((current) => {
      const targetDraft = current[modality];
      const nextReferences = targetDraft.references.filter((item) => item.id !== reference.id);
      return {
        ...current,
        [modality]: {
          ...targetDraft,
          references: nextReferences,
          prompt: reconcileDirectMentions(
            targetDraft.prompt,
            targetDraft.references,
            nextReferences,
          ),
          referenceError: null,
          quote: null,
          quoteState: "idle",
          quoteError: null,
          quoteRevision: targetDraft.quoteRevision + 1,
        },
      };
    });
  };

  const clearAllMaterials = async () => {
    if (locked || !draft.references.length) return;
    const readyCount = draft.references.filter((reference) => reference.status === "ready").length;
    const accepted = await requestConfirmation({
      title: "清空上传素材",
      description: `将移除当前${modality === "image" ? "图片" : "视频"}生成的全部 ${draft.references.length} 个素材${readyCount ? `（其中 ${readyCount} 个已上传）` : ""}，清空后需要重新上传。`,
      confirmLabel: "清空",
      tone: "danger",
    });
    if (!accepted) return;
    for (const reference of draft.references) {
      if (reference.previewUrl) {
        URL.revokeObjectURL(reference.previewUrl);
        previewUrls.current.delete(reference.previewUrl);
      }
    }
    setDrafts((current) => {
      const targetDraft = current[modality];
      return {
        ...current,
        [modality]: {
          ...targetDraft,
          references: [],
          prompt: reconcileDirectMentions(targetDraft.prompt, targetDraft.references, []),
          referenceError: null,
          quote: null,
          quoteState: "idle",
          quoteError: null,
          quoteRevision: targetDraft.quoteRevision + 1,
        },
      };
    });
  };

  const submit = async () => {
    if (!model || !draft.quote || inputInvalid || locked) return;
    if (!(await requireAuthenticatedIdentity())) return;
    if (Date.parse(draft.quote.expiresAt) <= Date.now()) {
      updateDraft(modality, {
        quote: null,
        quoteState: "loading",
        quoteError: "价格已更新，正在重新确认",
        quoteRevision: draft.quoteRevision + 1,
      });
      return;
    }
    updateDraft(modality, {
      submitting: true,
      submitLabel: "正在提交",
      submissionError: null,
      quoteError: null,
    });
    try {
      const parameters = composeModelParameters(model, draft.prompt, draft.parameters);
      // 与报价请求保持同一份参数：参考视频时长缺失会让服务端重建的报价对不上，
      // 触发 QUOTE_CHANGED 反而打断提交。
      if (videoDurations?.length) parameters[REFERENCE_VIDEO_DURATIONS_PARAMETER] = videoDurations;
      const tokenFields = quoteTokenFields(
        model,
        draft.prompt,
        draft.parameters,
        draft.maxOutputTokens,
      );
      if (typeof window !== "undefined") {
        // eslint-disable-next-line no-console
        console.warn(
          "[direct-submit] references:",
          JSON.stringify(
            draft.references.map((r) => ({
              kind: r.kind,
              status: r.status,
              serverId: r.serverId,
              imagePurpose: r.imagePurpose,
            })),
          ),
          "inputs:",
          JSON.stringify(referenceInputs),
        );
      }
      const job = await submitGenerationJob({
        projectId: DIRECT_GENERATION_PROJECT_ID,
        nodeId: DIRECT_GENERATION_NODE_IDS[modality],
        modelId: model.id,
        modality,
        parameters,
        inputs: referenceInputs,
        quantity: requestQuantity,
        ...tokenFields,
        expectedQuote: {
          id: draft.quote.id,
          modelId: draft.quote.modelId,
          creditMicros: draft.quote.creditMicros,
          pricingVersion: draft.quote.pricingVersion,
          expiresAt: draft.quote.expiresAt,
        },
        idempotencyKey: createRequestKey(`home-${modality}`),
      });
      updateJob(modality, job);
      watch(modality, job);
    } catch (cause) {
      if (cause instanceof CanvasApiError && cause.status === 401) expireIdentity();
      if (cause instanceof CanvasApiError && cause.code === "INSUFFICIENT_CREDITS")
        openAccount("login");
      if (cause instanceof CanvasApiError && cause.code === "QUOTE_CHANGED") {
        await loadCatalog(modality, true);
        updateDraft(modality, {
          quote: null,
          quoteState: "loading",
          quoteRevision: draft.quoteRevision + 1,
        });
      }
      const unknown =
        cause instanceof CanvasApiError &&
        (cause.status === 0 || cause.code === "NETWORK_UNAVAILABLE");
      updateDraft(modality, {
        submitting: false,
        submitLabel: "生成",
        submissionUnknown: draft.submissionUnknown || unknown,
        submissionError: unknown
          ? "提交结果待确认；再次点击会创建新的请求并正常扣费"
          : cause instanceof Error
            ? cause.message
            : "生成任务没有提交成功",
        quoteError: unknown
          ? "提交结果待确认；再次点击会创建新的请求并正常扣费"
          : cause instanceof Error
            ? cause.message
            : "生成任务没有提交成功",
      });
    }
  };

  const retry = () => {
    if (locked) return;
    if (catalogState.status === "error" || catalogState.data?.quoteAvailable === false) {
      void loadCatalog(modality, true);
    }
    updateDraft(modality, {
      quote: null,
      quoteState: "loading",
      quoteError: null,
      quoteRevision: draft.quoteRevision + 1,
      submissionUnknown: false,
      submissionError: null,
    });
  };

  const status = directStatus({
    draft,
    catalogStateStatus: catalogState.status,
    model,
    promptMissing,
    inputInvalid,
    activeJobs,
    latestJob,
  });
  const activeOption = MODALITIES.find((option) => option.value === modality)!;

  return (
    <section
      id="wc-entry-generate"
      className="wc-entry-section wc-entry-section--generate"
      aria-label="快速生成"
    >
      <div className="wc-entry-section-heading wc-entry-section-heading--generate">
        <div>
          <span className="wc-entry-kicker">不打开画布也能开始</span>
          <h2>把一个想法，直接变成画面。</h2>
        </div>
        <p>
          选择图片或视频模型，写下提示词，确认价格后立即生成。完成结果会留在这里，也可以下载后继续进入画布。
        </p>
      </div>

      <div className="wc-direct-studio" data-direct-generation data-direct-modality={modality}>
        <div className="wc-direct-studio-tabs" role="tablist" aria-label="生成类型">
          {MODALITIES.map(({ value, label, description, icon: Icon }) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={modality === value}
              className={modality === value ? "is-active" : undefined}
              onClick={() => onModalityChange(value)}
            >
              <Icon aria-hidden="true" />
              <span>
                <strong>{label}</strong>
                <small>{description}</small>
              </span>
              {modality === value ? <Check aria-hidden="true" /> : null}
            </button>
          ))}
        </div>

        <div className="wc-direct-studio-body">
          <form
            className="wc-direct-composer"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
            onPaste={(event) => {
              const files = filesFromDataTransfer(event.clipboardData);
              if (!files.length) return;
              event.preventDefault();
              void addInferredMaterials(files);
            }}
          >
            <header className="wc-direct-composer-header">
              <div>
                <span className="wc-direct-index">
                  01 / {modality === "image" ? "STILL" : "MOTION"}
                </span>
                <h3>{activeOption.label}</h3>
              </div>
              <span className="wc-direct-live-dot">
                <i aria-hidden="true" />
                直连模型
              </span>
            </header>

            <label className="wc-direct-prompt-field">
              <span>提示词{promptRequired ? " · 必填" : ""}</span>
              <textarea
                data-direct-prompt
                ref={promptRef}
                value={draft.prompt}
                disabled={locked}
                placeholder={
                  modality === "image"
                    ? "描述主体、环境、光线和画面气质……"
                    : "描述镜头、动作、节奏和时长感……"
                }
                rows={6}
                maxLength={4_000}
                onChange={(event) =>
                  updatePrompt(
                    event.target.value,
                    event.target.selectionStart ?? event.target.value.length,
                  )
                }
                onKeyDown={(event) => {
                  if (!mentionRange || !visibleMentionCandidates.length) return;
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setMentionIndex((current) => (current + 1) % visibleMentionCandidates.length);
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setMentionIndex(
                      (current) =>
                        (current - 1 + visibleMentionCandidates.length) %
                        visibleMentionCandidates.length,
                    );
                  } else if (event.key === "Enter" || event.key === "Tab") {
                    event.preventDefault();
                    chooseMention(
                      visibleMentionCandidates[mentionIndex] ?? visibleMentionCandidates[0]!,
                    );
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setMentionRange(null);
                  }
                }}
              />
              {mentionRange && visibleMentionCandidates.length ? (
                <div className="wc-direct-mention-menu" role="listbox" aria-label="引用素材">
                  {visibleMentionCandidates.map((candidate, index) => (
                    <button
                      key={candidate.id}
                      type="button"
                      role="option"
                      aria-selected={index === mentionIndex}
                      className={index === mentionIndex ? "is-active" : undefined}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        chooseMention(candidate);
                      }}
                    >
                      <span className="wc-direct-mention-label">@{candidate.label}</span>
                      <span>{candidate.name}</span>
                    </button>
                  ))}
                </div>
              ) : null}
              <small>{draft.prompt.length.toLocaleString("zh-CN")} / 4,000</small>
            </label>

            <div className="wc-direct-field-group">
              <label className="wc-direct-field-label">
                <span>模型</span>
                <small>{models.length ? `${models.length} 个可用模型` : "正在读取目录"}</small>
              </label>
              <CategorizedModelSelect
                value={draft.modelId}
                models={models}
                disabled={locked || catalogState.status === "loading" || !models.length}
                onChange={chooseModel}
                ariaLabel="模型"
              />
              {model?.description ? (
                <p className="wc-direct-model-description">{model.description}</p>
              ) : null}
            </div>

            {materialControls.length ? (
              <div
                className={`wc-direct-materials${materialDropActive ? " is-drag-active" : ""}`}
                role="group"
                aria-label="上传素材"
                data-direct-material-dropzone
                tabIndex={0}
                onDragEnter={(event) => {
                  if (!hasFiles(event.dataTransfer)) return;
                  event.preventDefault();
                  if (!locked) setMaterialDropActive(true);
                }}
                onDragOver={(event) => {
                  if (!hasFiles(event.dataTransfer)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDragLeave={(event) => {
                  if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                  setMaterialDropActive(false);
                }}
                onDrop={(event) => {
                  const files = filesFromDataTransfer(event.dataTransfer);
                  if (!files.length) return;
                  event.preventDefault();
                  setMaterialDropActive(false);
                  void addInferredMaterials(files);
                }}
              >
                <div className="wc-direct-field-label">
                  <span>上传素材</span>
                  <div className="wc-direct-field-label-actions">
                    <small>
                      {draft.references.filter((reference) => reference.status === "ready").length}{" "}
                      个已就绪
                    </small>
                    {draft.references.length ? (
                      <button
                        type="button"
                        className="wc-direct-clear-materials"
                        disabled={locked}
                        onClick={() => void clearAllMaterials()}
                      >
                        <Trash2 aria-hidden="true" />
                        清空上传素材
                      </button>
                    ) : null}
                  </div>
                </div>
                <div className="wc-direct-material-actions">
                  {materialControls.map((control) => {
                    const selected = draft.references.filter(
                      (reference) => reference.kind === control.kind,
                    ).length;
                    const disabled = locked || control.max <= selected;
                    return (
                      <label key={control.kind} className={disabled ? "is-disabled" : undefined}>
                        <input
                          data-direct-material-input={control.kind}
                          type="file"
                          accept={control.accept}
                          multiple={control.multiple}
                          disabled={disabled}
                          onChange={(event) => {
                            const files = Array.from(event.currentTarget.files ?? []);
                            event.currentTarget.value = "";
                            setMaterialInputFeedback(null);
                            void addMaterials(control.kind, files);
                          }}
                        />
                        <Upload aria-hidden="true" />
                        <span>{control.label}</span>
                        <small>{control.max ? `${selected}/${control.max}` : "不支持"}</small>
                      </label>
                    );
                  })}
                </div>
                <p className="wc-direct-material-drop-hint" aria-live="polite">
                  {materialDropActive
                    ? "松开即可上传当前模型支持的素材"
                    : `可拖入${acceptedMaterialLabels || "素材"}，也可复制文件后粘贴`}
                </p>
                {draft.references.length ? (
                  <div className="wc-direct-material-list">
                    {draft.references.map((reference) => (
                      <div
                        key={reference.id}
                        className={`wc-direct-material-item is-${reference.status}${reference.kind === "image" && imagePurposes.length > 1 ? " has-purpose-select" : ""}`}
                      >
                        <span className="wc-direct-material-preview">
                          {reference.kind === "image" && reference.previewUrl ? (
                            <img src={reference.previewUrl} alt="" />
                          ) : (
                            <MaterialKindIcon kind={reference.kind} />
                          )}
                        </span>
                        <span className="wc-direct-material-copy">
                          <strong title={reference.name}>{reference.name}</strong>
                          <small>
                            {reference.status === "uploading"
                              ? "正在上传"
                              : reference.status === "ready"
                                ? "已上传"
                                : (reference.error ?? "上传失败")}
                          </small>
                        </span>
                        {reference.kind === "image" && imagePurposes.length > 1 ? (
                          <CanvasSelect
                            value={
                              reference.imagePurpose &&
                              imagePurposes.includes(reference.imagePurpose)
                                ? reference.imagePurpose
                                : "__unassigned__"
                            }
                            options={imagePurposeOptions}
                            ariaLabel={`${reference.name}的参考用途`}
                            disabled={locked}
                            variant="compact"
                            menuMinWidth={150}
                            onChange={(value) =>
                              updateReference(modality, reference.id, {
                                imagePurpose: imagePurposes.includes(value as ReferenceImagePurpose)
                                  ? (value as ReferenceImagePurpose)
                                  : null,
                              })
                            }
                          />
                        ) : null}
                        {reference.status === "ready" ? (
                          <button
                            type="button"
                            className="wc-direct-material-mention"
                            aria-label={`引用${reference.name}到提示词`}
                            title="引用到提示词"
                            onClick={() => mentionReference(reference)}
                          >
                            <AtSign aria-hidden="true" />
                          </button>
                        ) : null}
                        {reference.status === "uploading" ? (
                          <LoaderCircle className="is-spinning" aria-hidden="true" />
                        ) : (
                          <button
                            type="button"
                            aria-label={`移除${reference.name}`}
                            title="移除素材"
                            onClick={() => removeMaterial(reference)}
                          >
                            <X aria-hidden="true" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : null}
                {materialInputFeedback ? (
                  <p className="wc-direct-material-error" role="alert">
                    <AlertCircle aria-hidden="true" />
                    {materialInputFeedback}
                  </p>
                ) : null}
                {draft.referenceError ? (
                  <p className="wc-direct-material-error" role="status">
                    <AlertCircle aria-hidden="true" />
                    {draft.referenceError}
                  </p>
                ) : null}
              </div>
            ) : null}

            {editableParameters.length ||
            hasStandaloneTokenMaximum ||
            (modality === "image" &&
              (requestFixedOutputCount !== null ||
                outputParameter?.fixed !== undefined ||
                outputRange.max > outputRange.min)) ? (
              <div className="wc-direct-parameters" aria-label="生成参数">
                {modality === "image" && requestFixedOutputCount !== null ? (
                  <div className="wc-generation-field wc-direct-count-field">
                    <span>本次产出</span>
                    <output>每次调用生成 {requestFixedOutputCount} 张图片</output>
                    <small>按次计费，单次调用返回全部图片</small>
                  </div>
                ) : modality === "image" &&
                  (outputParameter?.fixed !== undefined || outputRange.max > outputRange.min) ? (
                  <div className="wc-param-chips" role="group" aria-label="生成张数">
                    <span className="wc-param-chips-label">生成张数</span>
                    <div className="wc-param-chips-row">
                      {Array.from(
                        { length: outputRange.max - outputRange.min + 1 },
                        (_, index) => outputRange.min + index,
                      ).map((count) => (
                        <button
                          key={count}
                          type="button"
                          role="radio"
                          aria-checked={selectedQuantity === count}
                          disabled={
                            locked ||
                            outputParameter?.fixed !== undefined ||
                            outputRange.max === outputRange.min
                          }
                          className={selectedQuantity === count ? "is-active" : undefined}
                          onClick={() => updateQuantity(count)}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
                {editableParameters.map((parameter) => {
                  const chipOptions = generationParameterScalarOptions(
                    parameter,
                    generationParameterDisplayValue(parameter, draft.parameters[parameter.name]),
                  );
                  if (chipOptions) {
                    return (
                      <ParameterChips
                        key={`${model?.id ?? "model"}:${parameter.name}`}
                        parameter={parameter}
                        value={draft.parameters[parameter.name]}
                        disabled={locked}
                        onChange={(value) => updateParameter(parameter.name, value)}
                      />
                    );
                  }
                  if (modality === "video" && boundedDurationOptions(parameter)?.length) {
                    return (
                      <DurationChips
                        key={`${model?.id ?? "model"}:${parameter.name}`}
                        parameter={parameter}
                        value={draft.parameters[parameter.name]}
                        disabled={locked}
                        onChange={(value) => updateParameter(parameter.name, value)}
                      />
                    );
                  }
                  return (
                    <GenerationParameterField
                      key={`${model?.id ?? "model"}:${parameter.name}`}
                      parameter={parameter}
                      value={draft.parameters[parameter.name]}
                      disabled={locked}
                      boundedDuration={modality === "video"}
                      onChange={(value) => updateParameter(parameter.name, value)}
                      onValidityChange={(valid) =>
                        updateDraft(modality, {
                          invalidParameters: new Set(
                            valid
                              ? [...draft.invalidParameters].filter(
                                  (name) => name !== parameter.name,
                                )
                              : [...draft.invalidParameters, parameter.name],
                          ),
                          quote: null,
                          quoteState: "idle",
                          quoteRevision: draft.quoteRevision + 1,
                        })
                      }
                    />
                  );
                })}
                {hasStandaloneTokenMaximum ? (
                  <label className="wc-generation-field">
                    <span>最大输出</span>
                    <input
                      type="number"
                      min={1}
                      max={1_000_000}
                      step={128}
                      value={draft.maxOutputTokens ?? 1_024}
                      disabled={locked}
                      onChange={(event) =>
                        updateDraft(modality, {
                          maxOutputTokens: Math.max(1, Number(event.target.value) || 1),
                          quote: null,
                          quoteState: "idle",
                          quoteRevision: draft.quoteRevision + 1,
                        })
                      }
                    />
                  </label>
                ) : null}
              </div>
            ) : null}

            <div className="wc-direct-submit-row">
              <div className="wc-direct-price" aria-live="polite">
                <span>本次预计</span>
                <strong>
                  {draft.quote
                    ? `${draft.quote.estimated ? "约 " : ""}${draft.quote.credits} 积分`
                    : "--"}
                </strong>
                {draft.quote ? (
                  <small>
                    {draft.quote.yuan} 元 · {pricingUnitText(draft.quote.pricingUnit)}
                  </small>
                ) : null}
              </div>
              <button
                className="wc-direct-submit"
                type="submit"
                disabled={
                  !model || inputInvalid || !draft.quote || draft.quoteState !== "ready" || locked
                }
              >
                {draft.submitting ? (
                  <LoaderCircle className="is-spinning" aria-hidden="true" />
                ) : (
                  <Sparkles aria-hidden="true" />
                )}
                <span>{draft.submitting ? draft.submitLabel : "生成"}</span>
                {!draft.submitting ? <ArrowRight aria-hidden="true" /> : null}
              </button>
            </div>
          </form>

          <aside className="wc-direct-result" aria-label={`${activeOption.label}结果`}>
            <div className="wc-direct-result-topline">
              <span>02 / RESULT</span>
              <span>
                {status.tone === "ready" ? <Check aria-hidden="true" /> : null}
                {status.text}
              </span>
            </div>
            <div
              className={`wc-direct-result-stage ${completedArtifacts.length ? "has-media" : ""}`}
            >
              {completedArtifacts.length ? (
                <div className="wc-direct-result-gallery">
                  {activeJobs.map((job) => (
                    <GeneratingTile
                      key={job.id}
                      job={job}
                      compact
                      onReusePrompt={() => reusePromptFromJob(job)}
                      onReuseReferences={() => reuseReferencesFromJob(job)}
                    />
                  ))}
                  {completedArtifacts.map(({ job, artifact }, index) => (
                    <DirectResultMedia
                      key={`${job.id}:${artifact.id}`}
                      job={job}
                      artifact={artifact}
                      modality={modality}
                      decodePriority={index < 8 ? "high" : "low"}
                      onRemove={() => removeGeneratedArtifact(job.id, artifact.id)}
                      onReusePrompt={() => reusePromptFromJob(job)}
                      onReuseReferences={() => reuseReferencesFromJob(job)}
                      onOpen={() => openLightbox(`${job.id}:${artifact.id}`)}
                    />
                  ))}
                </div>
              ) : activeJobs.length ? (
                <div className="wc-direct-progress-list" role="status">
                  {activeJobs.map((job) => (
                    <GeneratingTile key={job.id} job={job} />
                  ))}
                </div>
              ) : (
                <div className="wc-direct-result-gallery" aria-label="示例结果">
                  <p className="wc-direct-sample-note">
                    示例预览 · 生成完成后这里换成你的真实成品，每张可放大 / 复用 / 下载 / 加入画布
                  </p>
                  {(modality === "image"
                    ? [
                        {
                          img: "docking",
                          model: "GPT Image 2.5 · 1:1",
                          prompt: "赛博朋克城市夜景，霓虹与雨雾",
                        },
                        {
                          img: "ocean",
                          model: "Gemini 3 Pro Image · 16:9",
                          prompt: "清晨海面薄雾，金色晨光",
                        },
                        {
                          img: "blackhole",
                          model: "Seedream 4.0 · 1:1",
                          prompt: "黑洞吸积盘，电影级科幻",
                        },
                        {
                          img: "wormhole",
                          model: "Midjourney V7 · 21:9",
                          prompt: "穿越虫洞的星舰长镜头",
                        },
                        {
                          img: "docking",
                          model: "FLUX.2 [pro] · 3:4",
                          prompt: "空间站对接舱特写，金属质感",
                        },
                        {
                          img: "ocean",
                          model: "GPT Image 2.5 · 16:9",
                          prompt: "极简产品海报，大量留白",
                        },
                      ]
                    : [
                        {
                          img: "docking",
                          model: "Veo 3.1 · 8 秒",
                          prompt: "星舰缓缓接近空间站，环绕运镜",
                        },
                        {
                          img: "ocean",
                          model: "可灵 Kling 2.5 · 5 秒",
                          prompt: "海浪拍打礁石，慢镜头",
                        },
                        {
                          img: "blackhole",
                          model: "Seedance 1.1 · 10 秒",
                          prompt: "黑洞潮汐撕裂，多镜头叙事",
                        },
                        { img: "wormhole", model: "Wan 2.5 · 5 秒", prompt: "虫洞坍缩，粒子飞散" },
                        {
                          img: "docking",
                          model: "Sora 2 · 12 秒",
                          prompt: "对接舱机械臂对接，一镜到底",
                        },
                        {
                          img: "ocean",
                          model: "Veo 3.1 · 6 秒",
                          prompt: "日出海面光斑，无人机拉升",
                        },
                      ]
                  ).map((tile, index) => (
                    <figure className="wc-direct-result-tile" key={index}>
                      <header className="wc-direct-result-head">
                        <span className="wc-direct-result-model" title={tile.model}>
                          {tile.model}
                        </span>
                      </header>
                      <div className="wc-direct-result-media">
                        <img
                          src={`/film/auth-film-poster-${tile.img}.webp`}
                          alt="示例结果"
                          draggable={false}
                          loading="lazy"
                        />
                        <span className="wc-direct-sample-badge">示例</span>
                      </div>
                      <div className="wc-direct-result-body">
                        <span className="wc-direct-result-caption" title={tile.prompt}>
                          {tile.prompt}
                        </span>
                        <div className="wc-direct-result-controls" aria-hidden="true">
                          <button type="button" tabIndex={-1} title="复用提示词">
                            <RotateCcw aria-hidden="true" />
                          </button>
                          <button type="button" tabIndex={-1} title="加入画布">
                            <ImagePlus aria-hidden="true" />
                          </button>
                          <button type="button" tabIndex={-1} title="下载">
                            <ArrowDownToLine aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                    </figure>
                  ))}
                </div>
              )}
            </div>
            {completedArtifacts.length ? (
              <div className="wc-direct-result-actions">
                <span>
                  <Check aria-hidden="true" />
                  已完成 {completedArtifacts.length} 个结果
                </span>
                {latestCompletedJob ? <small>{latestCompletedJob.modelLabel}</small> : null}
              </div>
            ) : null}
            {status.tone === "error" ? (
              <div className="wc-direct-status-error" role="alert">
                <AlertCircle aria-hidden="true" />
                <span>{status.text}</span>
                <button type="button" onClick={retry} disabled={draft.submitting}>
                  <RefreshCw aria-hidden="true" />
                  重新报价
                </button>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
      {lightboxIndex !== null && lightboxItems.length ? (
        <ResultLightbox
          items={lightboxItems}
          // 结果被删除后列表变短，夹住序号避免指向空位。
          index={Math.min(lightboxIndex, lightboxItems.length - 1)}
          onClose={() => setLightboxIndex(null)}
          onNavigate={setLightboxIndex}
          onRemove={removeLightboxItem}
          onReusePrompt={reuseLightboxPrompt}
        />
      ) : null}
    </section>
  );
}

/**
 * 视频时长一律平铺为秒数按钮（与画面比例同款），不再折叠进下拉；
 * 可选值来自目录声明的 options 或 min/max/step 展开（boundedDurationOptions）。
 */
function DurationChips({
  parameter,
  value,
  disabled,
  onChange,
}: {
  parameter: ModelParameter;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const options = boundedDurationOptions(parameter);
  if (!options?.length) return null;
  const selected = normalizeBoundedDurationValue(
    parameter,
    generationParameterDisplayValue(parameter, value),
  );
  const locked = disabled || isGenerationParameterLocked(parameter);

  return (
    <div className="wc-param-chips" role="group" aria-label={parameter.label}>
      <span className="wc-param-chips-label">{parameter.label}</span>
      <div className="wc-param-chips-row">
        {options.map((option) => {
          const active = selected !== undefined && Object.is(selected, option);
          return (
            <button
              key={JSON.stringify(option)}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={locked}
              className={active ? "is-active" : undefined}
              onClick={() => onChange(option)}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 生成中占位卡片。compact 模式嵌在结果画廊顶部，与结果卡片完全同构
 * （模型名 + 进度视觉 + 提示词 + 操作），进度再久也能看到并复用提示词/参考图；
 * 完整模式用于空结果时的进度列表。
 */
function GeneratingTile({
  job,
  compact = false,
  onReusePrompt,
  onReuseReferences,
}: {
  job: PublicGenerationJob;
  compact?: boolean;
  onReusePrompt?: () => void;
  onReuseReferences?: () => void;
}) {
  const prompt = typeof job.parameters?.prompt === "string" ? job.parameters.prompt : "";
  if (!compact) {
    return (
      <div className="wc-direct-generating" role="status" aria-label={`生成中 ${job.progress}%`}>
        <span className="wc-direct-generating-aura" aria-hidden="true" />
        <span className="wc-direct-generating-shine" aria-hidden="true" />
        <span className="wc-direct-generating-particles" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <div className="wc-direct-generating-copy">
          <Sparkles aria-hidden="true" className="wc-direct-generating-spark" />
          <strong>{job.progress}%</strong>
          <small>{jobStatusLabel(job.status)}</small>
          <i className="wc-direct-generating-bar">
            <span style={{ width: `${job.progress}%` }} />
          </i>
        </div>
      </div>
    );
  }
  return (
    <figure
      className="wc-direct-result-tile is-generating"
      role="status"
      aria-label={`生成中 ${job.progress}%`}
    >
      <header className="wc-direct-result-head">
        <span className="wc-direct-result-model" title={job.modelLabel}>
          {job.modelLabel}
        </span>
      </header>
      <div className="wc-direct-result-media wc-direct-result-media--generating">
        <div className="wc-direct-generating is-embedded" aria-hidden="true">
          <span className="wc-direct-generating-aura" />
          <span className="wc-direct-generating-shine" />
          <span className="wc-direct-generating-particles">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <div className="wc-direct-generating-copy">
            <Sparkles aria-hidden="true" className="wc-direct-generating-spark" />
            <strong>{job.progress}%</strong>
            <small>{jobStatusLabel(job.status)}</small>
            <i className="wc-direct-generating-bar">
              <span style={{ width: `${job.progress}%` }} />
            </i>
          </div>
        </div>
      </div>
      <div className="wc-direct-result-body">
        <span
          className="wc-direct-result-caption"
          title={prompt || job.modelLabel}
          aria-label={`生成提示词：${prompt || job.modelLabel}`}
        >
          {prompt || job.modelLabel}
        </span>
        <div className="wc-direct-result-controls">
          {onReusePrompt ? (
            <button
              type="button"
              aria-label="复用提示词"
              title="复用提示词"
              onClick={onReusePrompt}
            >
              <RotateCcw aria-hidden="true" />
            </button>
          ) : null}
          {onReuseReferences && jobReferenceImageCount(job) > 0 ? (
            <button
              type="button"
              aria-label="复用参考图"
              title={`复用本次使用的 ${jobReferenceImageCount(job)} 张参考图`}
              onClick={onReuseReferences}
            >
              <ImagePlus aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </figure>
  );
}

const DirectResultMedia = memo(function DirectResultMedia({
  job,
  artifact,
  modality,
  decodePriority = "normal",
  onRemove,
  onReusePrompt,
  onReuseReferences,
  onOpen,
}: {
  job: PublicGenerationJob;
  artifact: GenerationArtifact;
  modality: DirectModality;
  decodePriority?: "high" | "normal" | "low";
  onRemove: () => void;
  onReusePrompt: () => void;
  onReuseReferences: () => void;
  onOpen: () => void;
}) {
  const media = useMemo(
    () => (artifact.kind === "text" ? null : mediaFromArtifact(artifact)),
    [artifact],
  );
  // 画廊瓦片只有 ~200px 见方：图片请求 512px 缩略变体（与画布节点同一语义），
  // 一进页面的整页原图下载/解码是工作台加载卡顿的主因。放大查看走独立的
  // useMediaUrl 原图，画质不受影响。本地 IndexedDB 命中时 thumb 与原图同字节。
  const { url } = useMediaUrl(media);
  const { url: thumbUrl } = useMediaThumbUrl(media);
  if (!media) return null;

  if (modality === "audio") {
    return (
      <DirectAudioResult
        key={media.id}
        job={job}
        media={media}
        url={url}
        onRemove={onRemove}
        onReusePrompt={onReusePrompt}
      />
    );
  }
  return modality === "image" ? (
    <DirectImageResult
      key={media.id}
      job={job}
      media={media}
      url={url}
      displayUrl={thumbUrl ?? url}
      decodePriority={decodePriority}
      onRemove={onRemove}
      onReusePrompt={onReusePrompt}
      onReuseReferences={onReuseReferences}
      onOpen={onOpen}
    />
  ) : (
    <DirectVideoResult
      key={media.id}
      job={job}
      media={media}
      url={url}
      onRemove={onRemove}
      onReusePrompt={onReusePrompt}
      onReuseReferences={onReuseReferences}
      onOpen={onOpen}
    />
  );
});

/**
 * 独立生图/视频页的结果与画布节点使用同一套原子显示语义：
 * 服务端结果必须先完整 fetch + decode 才能一次性替换固定尺寸占位，避免浏览器
 * 逐块显示、黑框或破图图标；本地 blob 已经是原子资源，直接渲染。
 */

/**
 * MJ 四图画廊在上游任务完成后还要短暂归档，个别图可能瞬时 404/503。失败后
 * 按递增间隔自动重试有限的几次，画廊稳定后瓦片会自动恢复，不必等用户手点。
 */
const RESULT_IMAGE_AUTO_RETRY_DELAYS_MS = [3_000, 10_000, 30_000, 60_000] as const;

function DirectImageResult({
  job,
  media,
  url,
  displayUrl,
  decodePriority = "normal",
  onRemove,
  onReusePrompt,
  onReuseReferences,
  onOpen,
}: {
  job: PublicGenerationJob;
  media: CanvasMedia;
  url: string | null;
  /** 画廊展示地址（服务器图片为 512px 缩略变体）；下载/放大仍走 url 原图。 */
  displayUrl: string | null;
  decodePriority?: "high" | "normal" | "low";
  onRemove: () => void;
  onReusePrompt: () => void;
  onReuseReferences: () => void;
  onOpen: () => void;
}) {
  const [retryTick, setRetryTick] = useState(0);
  const autoAttempts = useRef(0);
  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearAutoTimer = useCallback(() => {
    if (autoTimer.current !== null) {
      clearTimeout(autoTimer.current);
      autoTimer.current = null;
    }
  }, []);

  useEffect(() => clearAutoTimer, [clearAutoTimer]);

  const retry = useCallback(() => {
    clearAutoTimer();
    autoAttempts.current = 0;
    setRetryTick((value) => value + 1);
  }, [clearAutoTimer]);

  const scheduleAutoRetry = useCallback(() => {
    if (autoAttempts.current >= RESULT_IMAGE_AUTO_RETRY_DELAYS_MS.length) return;
    const delay = RESULT_IMAGE_AUTO_RETRY_DELAYS_MS[autoAttempts.current]!;
    autoAttempts.current += 1;
    clearAutoTimer();
    autoTimer.current = setTimeout(() => {
      autoTimer.current = null;
      setRetryTick((value) => value + 1);
    }, delay);
  }, [clearAutoTimer]);

  const reportReady = useCallback(() => {
    autoAttempts.current = 0;
    clearAutoTimer();
  }, [clearAutoTimer]);

  return (
    <DirectImageResultContent
      key={retryTick}
      job={job}
      media={media}
      url={url}
      displayUrl={displayUrl}
      decodePriority={decodePriority}
      onRemove={onRemove}
      onReusePrompt={onReusePrompt}
      onReuseReferences={onReuseReferences}
      onOpen={onOpen}
      onRetry={retry}
      onAutoRetry={scheduleAutoRetry}
      onReady={reportReady}
    />
  );
}

function DirectImageResultContent({
  job,
  media,
  url,
  displayUrl,
  decodePriority = "normal",
  onRemove,
  onReusePrompt,
  onReuseReferences,
  onOpen,
  onRetry,
  onAutoRetry,
  onReady,
}: {
  job: PublicGenerationJob;
  media: CanvasMedia;
  url: string | null;
  /** 画廊展示地址（缩略变体）；与 url 不同时只用于 <img> 显示。 */
  displayUrl: string | null;
  decodePriority?: "high" | "normal" | "low";
  onRemove: () => void;
  onReusePrompt: () => void;
  onReuseReferences: () => void;
  onOpen: () => void;
  onRetry: () => void;
  onAutoRetry: () => void;
  onReady: () => void;
}) {
  // 显示走缩略地址；url 原图仅在本地缓存命中（objectURL，两者一致）时直接显示。
  const imageSourceUrl = displayUrl ?? url;
  const remote = imageSourceUrl !== null && !isLocalDecodedUrl(imageSourceUrl);
  const { asset: decoded, error } = useBoundedImage(remote ? imageSourceUrl : null, {
    priority: decodePriority,
    credentials: "include",
  });

  // 注意：不再把缩略 blob 落盘——本地缓存必须保持原图语义，画布侧的
  // 原图缓存管道由节点自己负责；工作台画廊只负责显示。

  const readyUrl = remote ? (decoded?.url ?? null) : imageSourceUrl;
  const loading = !readyUrl && !error;
  const failed = Boolean(error) && !decoded;

  // 成功即重置自动重试计数；失败则按退避间隔安排下一次自动重试。
  useEffect(() => {
    if (readyUrl) onReady();
  }, [readyUrl, onReady]);

  useEffect(() => {
    if (failed) onAutoRetry();
  }, [failed, onAutoRetry]);

  // 卡片里优先展示提示词，便于一眼区分同批结果；没有提示词时退回模型名。
  const prompt = typeof job.parameters?.prompt === "string" ? job.parameters.prompt : "";

  return (
    <figure
      className={`wc-direct-result-tile ${failed ? "is-error" : ""}`}
      aria-busy={loading ? "true" : undefined}
    >
      <header className="wc-direct-result-head">
        <span className="wc-direct-result-model" title={job.modelLabel}>
          {job.modelLabel}
        </span>
      </header>
      <div className="wc-direct-result-media" onDoubleClick={onOpen}>
        {readyUrl ? (
          <img
            src={readyUrl}
            alt="生成的图片结果"
            draggable={false}
            decoding="async"
            loading="lazy"
          />
        ) : null}
        {readyUrl ? (
          <>
            <button
              type="button"
              className="wc-direct-result-corner wc-direct-result-corner--zoom"
              aria-label="放大查看"
              title="放大查看"
              onClick={onOpen}
            >
              <Maximize2 aria-hidden="true" />
            </button>
            <button
              type="button"
              className="wc-direct-result-corner wc-direct-result-corner--remove"
              aria-label="删除图片结果"
              title="从工作台移除"
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </>
        ) : null}
        {/* 加载/失败态必须留在媒体方块内部（与视频卡一致）：媒体容器始终
            保持 aspect-ratio:1 的稳定高度；若作为 figure 的直接子节点，
            loading 的高度会与卡片高度互相引用，把媒体区挤压塌缩成 0，
            整行卡片退化为只剩文字。 */}
        {loading ? (
          <div className="wc-direct-result-loading" role="status">
            <LoaderCircle className="is-spinning" aria-hidden="true" />
            <span>正在读取结果</span>
          </div>
        ) : null}
        {failed ? (
          <div className="wc-direct-result-loading is-error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>结果加载失败</span>
            <button type="button" onClick={onRetry}>
              <RefreshCw aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : null}
      </div>
      <div className="wc-direct-result-body">
        <span
          className="wc-direct-result-caption"
          title={prompt || job.modelLabel}
          aria-label={`生成提示词：${prompt || job.modelLabel}`}
        >
          {prompt || job.modelLabel}
        </span>
        <div className="wc-direct-result-controls">
          <button type="button" aria-label="复用提示词" title="复用提示词" onClick={onReusePrompt}>
            <RotateCcw aria-hidden="true" />
          </button>
          {jobReferenceImageCount(job) > 0 ? (
            <button
              type="button"
              aria-label="复用参考图"
              title={`复用本次使用的 ${jobReferenceImageCount(job)} 张参考图`}
              onClick={onReuseReferences}
            >
              <ImagePlus aria-hidden="true" />
            </button>
          ) : null}
          <a href={readyUrl ?? undefined} download={media.name} aria-label="下载图片" title="下载">
            <ArrowDownToLine aria-hidden="true" />
          </a>
        </div>
      </div>
    </figure>
  );
}

/**
 * 视频结果使用固定比例占位：视频元素常驻以持续加载（窗口隐藏/移动端解码暂停不会
 * 被当成失败），首帧就绪（loadeddata）后才切换显示；失败保持显式可重试状态。
 * 恢复可见后若仍未就绪则继续加载。
 */
function DirectVideoResult({
  job,
  media,
  url,
  onRemove,
  onReusePrompt,
  onReuseReferences,
  onOpen,
}: {
  job: PublicGenerationJob;
  media: CanvasMedia;
  url: string | null;
  onRemove: () => void;
  onReusePrompt: () => void;
  onReuseReferences: () => void;
  onOpen: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    setPhase("loading");
  }, [url]);

  const resumeLoading = useCallback(() => {
    const video = videoRef.current;
    if (!video || !url || phase === "ready" || video.error) return;
    if (document.visibilityState !== "visible") return;
    if (video.readyState > 0 || video.networkState === HTMLMediaElement.NETWORK_LOADING) return;
    video.load();
  }, [phase, url]);

  useEffect(() => {
    const onVisible = () => resumeLoading();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [resumeLoading]);

  const retry = () => {
    setPhase("loading");
    videoRef.current?.load();
  };

  const handleDownload = async () => {
    if (!url || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadUrl(url, media.name);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "视频下载失败，请稍后重试");
    } finally {
      setDownloading(false);
    }
  };

  // 与图片卡片保持一致：优先展示提示词，便于区分同批结果。
  const prompt = typeof job.parameters?.prompt === "string" ? job.parameters.prompt : "";

  return (
    <figure className="wc-direct-result-tile is-video">
      <header className="wc-direct-result-head">
        <span className="wc-direct-result-model" title={job.modelLabel}>
          {job.modelLabel}
        </span>
      </header>
      <div
        className={`wc-direct-result-media wc-direct-result-media--video ${phase === "ready" ? "is-ready" : ""}`}
        aria-busy={phase === "loading" ? "true" : undefined}
        onDoubleClick={onOpen}
      >
        {/* 卡片里只留静音首帧占位，完整播放交给放大层，避免每个视频都常驻解码。 */}
        <video
          ref={videoRef}
          src={url ?? undefined}
          aria-label="生成的视频结果"
          muted
          playsInline
          preload="metadata"
          onLoadedData={() => setPhase("ready")}
          onError={() => setPhase("error")}
        />
        {phase === "ready" ? (
          <>
            <button
              type="button"
              className="wc-direct-result-corner wc-direct-result-corner--zoom"
              aria-label="放大查看"
              title="放大查看"
              onClick={onOpen}
            >
              <Maximize2 aria-hidden="true" />
            </button>
            <button
              type="button"
              className="wc-direct-result-corner wc-direct-result-corner--remove"
              aria-label="删除视频结果"
              title="从工作台移除"
              onClick={onRemove}
            >
              <Trash2 aria-hidden="true" />
            </button>
          </>
        ) : null}
        {phase === "loading" ? (
          <div className="wc-direct-result-loading is-video" role="status">
            <LoaderCircle className="is-spinning" aria-hidden="true" />
            <span>正在读取结果</span>
          </div>
        ) : null}
        {phase === "error" ? (
          <div className="wc-direct-result-loading is-error" role="alert">
            <AlertCircle aria-hidden="true" />
            <span>结果加载失败</span>
            <button type="button" onClick={retry}>
              <RefreshCw aria-hidden="true" />
              重新加载
            </button>
          </div>
        ) : null}
      </div>
      <div className="wc-direct-result-body">
        <span
          className="wc-direct-result-caption"
          title={prompt || job.modelLabel}
          aria-label={`生成提示词：${prompt || job.modelLabel}`}
        >
          {prompt || job.modelLabel}
        </span>
        <div className="wc-direct-result-controls">
          <button type="button" aria-label="复用提示词" title="复用提示词" onClick={onReusePrompt}>
            <RotateCcw aria-hidden="true" />
          </button>
          {jobReferenceImageCount(job) > 0 ? (
            <button
              type="button"
              aria-label="复用参考图"
              title={`复用本次使用的 ${jobReferenceImageCount(job)} 张参考图`}
              onClick={onReuseReferences}
            >
              <ImagePlus aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={!url || downloading}
            aria-label="下载视频"
            title="下载"
          >
            <ArrowDownToLine aria-hidden="true" />
          </button>
        </div>
      </div>
      {downloadError ? (
        <div className="wc-direct-result-download-error" role="alert">
          {downloadError}
        </div>
      ) : null}
    </figure>
  );
}

/**
 * 音频结果卡：波形播放器 + 提示词 + 删除/复用/下载。音频不进放大层
 * （播放器本身就是完整交互），所以不接 onOpen。
 */
function DirectAudioResult({
  job,
  media,
  url,
  onRemove,
  onReusePrompt,
}: {
  job: PublicGenerationJob;
  media: CanvasMedia;
  url: string | null;
  onRemove: () => void;
  onReusePrompt: () => void;
}) {
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const prompt = typeof job.parameters?.prompt === "string" ? job.parameters.prompt : "";

  const handleDownload = async () => {
    if (!url || downloading) return;
    setDownloading(true);
    setDownloadError(null);
    try {
      await downloadUrl(url, media.name);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause.message : "音频下载失败，请稍后重试");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <figure className="wc-direct-result-tile is-audio">
      <header className="wc-direct-result-head">
        <span className="wc-direct-result-model" title={job.modelLabel}>
          {job.modelLabel}
        </span>
      </header>
      <div className="wc-direct-result-media wc-direct-result-media--audio">
        {url ? (
          <MiniAudioPlayer src={url} label={prompt || job.modelLabel} />
        ) : (
          <div className="wc-direct-result-loading" role="status">
            <LoaderCircle className="is-spinning" aria-hidden="true" />
            <span>正在读取结果</span>
          </div>
        )}
      </div>
      <div className="wc-direct-result-body">
        <span
          className="wc-direct-result-caption"
          title={prompt || job.modelLabel}
          aria-label={`生成提示词：${prompt || job.modelLabel}`}
        >
          {prompt || job.modelLabel}
        </span>
        <div className="wc-direct-result-controls">
          <button type="button" aria-label="复用提示词" title="复用提示词" onClick={onReusePrompt}>
            <RotateCcw aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={!url || downloading}
            aria-label="下载音频"
            title="下载"
          >
            <ArrowDownToLine aria-hidden="true" />
          </button>
          <button type="button" aria-label="删除音频结果" title="从工作台移除" onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </button>
        </div>
      </div>
      {downloadError ? (
        <div className="wc-direct-result-download-error" role="alert">
          {downloadError}
        </div>
      ) : null}
    </figure>
  );
}

function isLocalDecodedUrl(url: string) {
  return url.startsWith("blob:") || url.startsWith("data:");
}

const generatedArtifactPersistence = new Map<string, Promise<void>>();

function persistGeneratedJobArtifacts(job: PublicGenerationJob) {
  if (job.status !== "completed") return;
  for (const artifact of job.artifacts) {
    if (artifact.kind === "text" || generatedArtifactPersistence.has(artifact.mediaId)) continue;
    const media = mediaFromArtifact(artifact);
    const kind = artifact.kind;
    const request = Promise.all([cacheServerMedia(media), ensureMediaAsset(media, kind, "canvas")])
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        if (generatedArtifactPersistence.get(artifact.mediaId) === request) {
          generatedArtifactPersistence.delete(artifact.mediaId);
        }
      });
    generatedArtifactPersistence.set(artifact.mediaId, request);
  }
}

function mediaFromArtifact(artifact: Exclude<GenerationArtifact, { kind: "text" }>): CanvasMedia {
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

/** 任务提交时携带的图片参考素材数量（常规/风格/元素三类合计）。 */
function jobReferenceImageCount(job: PublicGenerationJob) {
  const inputs = job.inputs;
  if (!inputs) return 0;
  return (
    (inputs.images?.length ?? 0) +
    (inputs.styleImages?.length ?? 0) +
    (inputs.elementImages?.length ?? 0)
  );
}

function readInitialPromptParam() {
  try {
    const value = new URLSearchParams(window.location.search).get("prompt");
    return value ? value.slice(0, 4000) : "";
  } catch {
    return "";
  }
}

function readInitialModelParam() {
  try {
    return new URLSearchParams(window.location.search).get("model") ?? "";
  } catch {
    return "";
  }
}

function readInitialParameterValues() {
  try {
    const query = new URLSearchParams(window.location.search);
    const values: Record<string, unknown> = {};
    for (const [key, raw] of query.entries()) {
      if (!key.startsWith("p_") || !raw) continue;
      try {
        values[key.slice(2)] = JSON.parse(raw);
      } catch {
        values[key.slice(2)] = raw;
      }
    }
    return values;
  } catch {
    return {};
  }
}

function createDraft(sessionDraft: PersistedDirectDraft | null): DirectDraft {
  const parameters = { ...(sessionDraft?.parameters ?? {}), ...readInitialParameterValues() };
  return {
    prompt: readInitialPromptParam() || sessionDraft?.prompt || "",
    modelId: readInitialModelParam() || sessionDraft?.modelId || "",
    parameters,
    maxOutputTokens: sessionDraft?.maxOutputTokens ?? null,
    invalidParameters: new Set(),
    quote: null,
    quoteState: "idle",
    quoteError: null,
    quoteRevision: 0,
    quantity: sessionDraft?.quantity ?? 1,
    submitting: false,
    submitLabel: "生成",
    jobs: [],
    submissionUnknown: false,
    submissionError: null,
    references: [],
    referenceError: null,
  };
}

function modelInput(model: PublicModel, kind: MediaKind) {
  if (kind === "image") return model.input.images;
  if (kind === "video") return model.input.referenceMedia?.videos ?? model.input.videos;
  return model.input.referenceMedia?.audios ?? model.input.audios;
}

function directReferenceMaximum(input: ModelInputCount | undefined, kind: MediaKind) {
  if (!input) return 0;
  const requestLimit = kind === "image" ? 32 : 10;
  const declared = input.max ?? (input.multiple ? requestLimit : 1);
  return Math.max(0, Math.min(requestLimit, input.multiple ? declared : Math.min(1, declared)));
}

function directReferenceInputs(references: DirectReference[], model: PublicModel | null) {
  const ready = (kind: MediaKind) =>
    references.flatMap((reference) =>
      reference.kind === kind && reference.status === "ready" && reference.serverId
        ? [reference.serverId]
        : [],
    );
  const imagePurposes = model ? getReferenceImagePurposes(model) : [];
  const images: Record<ReferenceImagePurpose, string[]> = {
    images: [],
    styleImages: [],
    elementImages: [],
  };
  for (const reference of references) {
    if (reference.kind !== "image" || reference.status !== "ready" || !reference.serverId) continue;
    // Fall back to the model's default image purpose when the reference carries
    // none (e.g. uploaded from the home gate), so a ready image is never dropped
    // just because its purpose label was never assigned.
    const purpose =
      reference.imagePurpose && imagePurposes.includes(reference.imagePurpose)
        ? reference.imagePurpose
        : imagePurposes[0];
    if (purpose) images[purpose].push(reference.serverId);
  }
  return {
    images: images.images,
    styleImages: images.styleImages,
    elementImages: images.elementImages,
    videos: ready("video"),
    audios: ready("audio"),
  };
}

function directReferenceIssue(model: PublicModel, references: DirectReference[]) {
  const uploading = references.find((reference) => reference.status === "uploading");
  if (uploading) return `${materialKindLabel(uploading.kind)}素材正在上传`;
  const failed = references.find((reference) => reference.status === "error");
  if (failed) return failed.error ?? `${materialKindLabel(failed.kind)}素材上传失败`;
  const imagePurposes = getReferenceImagePurposes(model);
  const readyImages = references.filter(
    (reference) => reference.kind === "image" && reference.status === "ready",
  );
  if (readyImages.length && imagePurposes.length === 0) return "当前模型不支持图片素材";
  if (imagePurposes.length > 1) {
    const unassigned = readyImages.filter(
      (reference) => !reference.imagePurpose || !imagePurposes.includes(reference.imagePurpose),
    );
    if (unassigned.length) return `请为 ${unassigned.length} 张参考图片选择用途`;
  }
  const inputs = directReferenceInputs(references, model);
  for (const purpose of imagePurposes) {
    const input = referenceImageCapability(model, purpose);
    const count = inputs[purpose].length;
    const min = Math.max(0, input?.min ?? 0);
    const max = directReferenceMaximum(input, "image");
    const label = referenceImagePurposeLabel(model, purpose);
    if (count < min) return `${label}至少需要 ${min} 张`;
    if (count > max) return `${label}最多支持 ${max} 张`;
  }
  for (const kind of ["video", "audio"] as const) {
    const input = modelInput(model, kind);
    const count = inputs[kind === "video" ? "videos" : "audios"].length;
    const min = Math.max(0, input?.min ?? 0);
    const max = directReferenceMaximum(input, kind);
    if (count < min) return `当前模型至少需要 ${min} 个${materialKindLabel(kind)}素材`;
    if (count > max) return `当前模型最多支持 ${max} 个${materialKindLabel(kind)}素材`;
  }
  const total =
    inputs.images.length +
    inputs.styleImages.length +
    inputs.elementImages.length +
    inputs.videos.length +
    inputs.audios.length;
  const totalMax = model.input.referenceMedia?.maxTotalItems;
  if (totalMax !== undefined && total > totalMax) {
    return `当前模型合计最多支持 ${totalMax} 个参考素材`;
  }
  // 参考视频总时长上限（目录口径 15 秒）必须前置拦：放过去就是上游 400。时长
  // 缺失不拦——会话恢复的旧素材查一次元数据就有了，服务端也能自己推导，为一个
  // 还在补查的时长挡住能生成的请求不划算。
  if (referenceVideoDurationsParameter(model)) {
    const readyVideos = references.filter(
      (reference) =>
        reference.kind === "video" && reference.status === "ready" && reference.serverId,
    );
    const durations = referenceVideoDurationsFromMedia(
      readyVideos.map((reference) => reference.durationMs),
    );
    if (
      durations &&
      durations.reduce((sum, seconds) => sum + seconds, 0) > MAX_REFERENCE_VIDEO_TOTAL_SECONDS
    ) {
      return `参考视频总时长不能超过 ${MAX_REFERENCE_VIDEO_TOTAL_SECONDS} 秒`;
    }
  }
  return null;
}

function filesFromDataTransfer(dataTransfer: DataTransfer) {
  const files = Array.from(dataTransfer.files);
  if (files.length) return files;
  return Array.from(dataTransfer.items).flatMap((item) => {
    const file = item.kind === "file" ? item.getAsFile() : null;
    return file ? [file] : [];
  });
}

function hasFiles(dataTransfer: DataTransfer) {
  return (
    dataTransfer.files.length > 0 ||
    Array.from(dataTransfer.types).includes("Files") ||
    Array.from(dataTransfer.items).some((item) => item.kind === "file")
  );
}

function materialKindLabel(kind: MediaKind) {
  return kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
}

function MaterialKindIcon({ kind }: { kind: MediaKind }) {
  if (kind === "image") return <FileImage aria-hidden="true" />;
  if (kind === "video") return <FileVideo aria-hidden="true" />;
  return <Music2 aria-hidden="true" />;
}

function isOutputParameter(parameter: ModelParameter) {
  return parameter.name.toLowerCase() === "n" || parameter.name.toLowerCase() === "count";
}

function findOutputParameter(model: PublicModel | null) {
  return (
    model?.parameters.find(
      (parameter) =>
        (parameter.type === "integer" || parameter.type === "number") &&
        isOutputParameter(parameter),
    ) ?? null
  );
}

function outputCountRange(model: PublicModel, parameter: ModelParameter) {
  const fixedValue = parameter.fixed === undefined ? null : Number(parameter.fixed);
  if (fixedValue !== null && Number.isFinite(fixedValue) && fixedValue >= 1) {
    const fixed = Math.max(1, Math.min(8, Math.round(fixedValue)));
    return { min: fixed, max: fixed };
  }
  const min = Math.max(1, model.output.minCount, parameter.min ?? 1);
  const max = Math.max(
    min,
    Math.min(8, model.output.maxCount, parameter.max ?? model.output.maxCount),
  );
  return {
    min,
    max,
  };
}

function modelOutputCountRange(model: PublicModel | null) {
  const min = model?.modality === "image" ? Math.max(1, model.output.minCount) : 1;
  const max = model?.modality === "image" ? Math.max(min, Math.min(8, model.output.maxCount)) : 1;
  return { min, max };
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function hasParameterValue(value: unknown) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function isTerminalJob(job: PublicGenerationJob) {
  return (
    job.status === "completed" || job.status === "failed" || job.status === "submission_unknown"
  );
}

function jobStatusLabel(status: PublicGenerationJob["status"]) {
  return (
    {
      reserved: "已计价，等待提交",
      submitting: "正在提交",
      queued: "排队中",
      running: "生成中",
      validating: "校验结果",
      submission_unknown: "等待确认",
      completed: "已完成",
      failed: "生成失败",
    } as Record<PublicGenerationJob["status"], string>
  )[status];
}

function directStatus({
  draft,
  catalogStateStatus,
  model,
  promptMissing,
  inputInvalid,
  activeJobs,
  latestJob,
}: {
  draft: DirectDraft;
  catalogStateStatus: "idle" | "loading" | "ready" | "error";
  model: PublicModel | null;
  promptMissing: boolean;
  inputInvalid: boolean;
  activeJobs: PublicGenerationJob[];
  latestJob: PublicGenerationJob | null;
}) {
  if (draft.submissionError) return { tone: "error" as const, text: draft.submissionError };
  if (latestJob?.status === "submission_unknown")
    return { tone: "error" as const, text: "提交结果待确认；再次点击会创建新的请求并正常扣费" };
  if (latestJob?.status === "failed")
    return { tone: "error" as const, text: latestJob.error?.message ?? "生成失败，请重试" };
  if (activeJobs.length)
    return { tone: "running" as const, text: `${activeJobs.length} 个任务生成中` };
  if (draft.quoteError) return { tone: "error" as const, text: draft.quoteError };
  if (catalogStateStatus === "error")
    return { tone: "error" as const, text: "模型目录暂时无法读取" };
  if (catalogStateStatus === "loading") return { tone: "loading" as const, text: "正在读取模型" };
  if (!model) return { tone: "idle" as const, text: "暂无可用模型" };
  if (promptMissing) return { tone: "idle" as const, text: "写下提示词后确认价格" };
  if (inputInvalid) return { tone: "error" as const, text: "请补齐必填参数" };
  if (draft.quoteState === "loading") return { tone: "loading" as const, text: "正在确认价格" };
  if (draft.quote) return { tone: "ready" as const, text: "价格已确认" };
  return { tone: "idle" as const, text: "准备开始" };
}
