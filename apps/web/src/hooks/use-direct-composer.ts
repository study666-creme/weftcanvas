import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from "react";

import type { DirectModality } from "../components/direct-generation-studio";
import { pickDefaultModel } from "../components/generation-model-select";
import { createMediaUpload, createRequestKey, uploadMediaBlob } from "../lib/api-client";
import {
  directMentionCandidates,
  insertDirectMention,
  mentionQueryAtCursor,
  type DirectMentionCandidate,
} from "../lib/direct-generation-mentions";
import { directMaterialControls } from "../lib/direct-material-controls";
import {
  defaultModelParameters,
  isModelBoundTextParameter,
  isModelCompatibilityParameterHidden,
  isModelInternalParameter,
  isModelMediaReferenceParameter,
  isUserFacingParameter,
  reconcileModelParameters,
} from "../lib/generation-config";
import { getReferenceImagePurposes } from "../lib/generation-inputs";
import { inferMaterialKind } from "../lib/media-kind";
import { validateImageBlob, validateMediaBlob } from "../lib/media-validation";
import { useDirectReferenceStore, type DirectReference } from "../state/direct-reference-store";
import { useGenerationStore } from "../state/generation-store";

export const DIRECT_COMPOSER_PROMPT_MAX = 4000;

type MaterialKind = "image" | "video" | "audio";

/**
 * 首页生成框的全部状态与行为（模式 / 模型 / 参数 / 参考素材上传 / @ 引用 / 提交）。
 *
 * 入口落地页与工作台式主页共用这一份逻辑，界面各自渲染。提交不在这里生成：
 * 只把提示词、模型与参数编码进 URL 交给 /generate 工作台，由工作台读取共享的
 * 参考素材 store 并自动提交一次（与原入口行为完全一致）。
 */
export function useDirectComposer({ uploadKeyPrefix = "entry-material" } = {}) {
  const [mode, setMode] = useState<DirectModality>("image");
  const [prompt, setPrompt] = useState("");
  const [modelId, setModelId] = useState("");
  const [parameters, setParameters] = useState<Record<string, unknown>>({});
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [mentionRange, setMentionRange] = useState<{
    start: number;
    end: number;
    query: string;
  } | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const references = useDirectReferenceStore((state) => state.references[mode]);
  const addReferences = useDirectReferenceStore((state) => state.addReferences);
  const updateReference = useDirectReferenceStore((state) => state.updateReference);
  const removeStoredReference = useDirectReferenceStore((state) => state.removeReference);

  const catalog = useGenerationStore((state) => state.catalogs[mode]);
  const loadCatalog = useGenerationStore((state) => state.loadCatalog);

  useEffect(() => {
    void loadCatalog(mode);
  }, [mode, loadCatalog]);

  const models = useMemo(
    () => (catalog.data?.models ?? []).filter((item) => item.modality === mode),
    [catalog.data, mode],
  );

  const model = useMemo(
    () => models.find((item) => item.id === modelId) ?? pickDefaultModel(models),
    [models, modelId],
  );

  useEffect(() => {
    if (!models.length) {
      if (modelId) {
        setModelId("");
        setParameters({});
      }
      return;
    }
    const selected = models.find((item) => item.id === modelId) ?? pickDefaultModel(models)!;
    if (selected.id !== modelId) {
      setModelId(selected.id);
      setParameters(defaultModelParameters(selected));
      return;
    }
    setParameters((current) => {
      const reconciled = reconcileModelParameters(selected, current);
      return JSON.stringify(reconciled) === JSON.stringify(current) ? current : reconciled;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models, modelId]);

  const editableParameters = useMemo(
    () =>
      model?.parameters.filter(
        (parameter) =>
          !isModelBoundTextParameter(model, parameter) &&
          !isModelInternalParameter(parameter) &&
          !isModelMediaReferenceParameter(model, parameter) &&
          !isModelCompatibilityParameterHidden(model, parameter) &&
          isUserFacingParameter(parameter),
      ) ?? [],
    [model],
  );

  const changeMode = (next: DirectModality) => {
    if (next === mode) return;
    setMode(next);
    setModelId("");
    setParameters({});
    setMentionRange(null);
    setUploadError(null);
  };

  const setParameter = (name: string, value: unknown) =>
    setParameters((current) => ({ ...current, [name]: value }));

  const mentionCandidates = useMemo(() => directMentionCandidates(references), [references]);
  const visibleMentionCandidates = useMemo(() => {
    if (!mentionRange) return [];
    const query = mentionRange.query.toLocaleLowerCase("zh-CN");
    return mentionCandidates.filter((candidate) =>
      `${candidate.label} ${candidate.name}`.toLocaleLowerCase("zh-CN").includes(query),
    );
  }, [mentionCandidates, mentionRange]);

  const updatePrompt = (value: string, cursor: number) => {
    setPrompt(value);
    setMentionRange(mentionQueryAtCursor(value, cursor));
    setMentionIndex(0);
  };

  const focusPromptAt = (cursor: number) => {
    requestAnimationFrame(() => {
      const textarea = promptRef.current;
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(cursor, cursor);
    });
  };

  const chooseMention = (candidate: DirectMentionCandidate) => {
    if (!mentionRange) return;
    const next = insertDirectMention(prompt, mentionRange, candidate);
    updatePrompt(next.value, next.cursor);
    focusPromptAt(next.cursor);
  };

  const mentionReference = (reference: DirectReference) => {
    if (reference.status !== "ready") return;
    const candidate = mentionCandidates.find((item) => item.id === reference.id);
    if (!candidate) return;
    const cursor = promptRef.current?.selectionStart ?? prompt.length;
    const next = insertDirectMention(prompt, { start: cursor, end: cursor }, candidate);
    updatePrompt(next.value, next.cursor);
    focusPromptAt(next.cursor);
  };

  const removeReference = (reference: DirectReference) => {
    if (reference.previewUrl) URL.revokeObjectURL(reference.previewUrl);
    removeStoredReference(mode, reference.id);
  };

  const materialControls = useMemo(
    () => directMaterialControls(model, references),
    [model, references],
  );
  const acceptedMimes = useMemo(
    () => materialControls.map((control) => control.accept).join(","),
    [materialControls],
  );
  const supportedKinds = useMemo(
    () => new Set(materialControls.map((control) => control.kind)),
    [materialControls],
  );
  const maxFor = (kind: MaterialKind) =>
    materialControls.find((control) => control.kind === kind)?.max ?? 0;

  const uploadKind = async (kind: MaterialKind, files: File[]) => {
    const max = maxFor(kind);
    const existing = references.filter((reference) => reference.kind === kind).length;
    const available = Math.max(0, max - existing);
    if (!available) {
      setUploadError(
        kind === "image"
          ? `图片素材最多 ${max} 个`
          : kind === "video"
            ? `视频素材最多 ${max} 个`
            : `音频素材最多 ${max} 个`,
      );
      return;
    }
    const imagePurposes = model ? getReferenceImagePurposes(model) : [];
    const accepted = files.slice(0, available);
    const pending: DirectReference[] = accepted.map((file) => ({
      id: crypto.randomUUID(),
      kind,
      name: (file.name || "参考素材").slice(0, 255),
      previewUrl: null,
      serverId: null,
      status: "uploading",
      error: null,
      uploadKey: createRequestKey(uploadKeyPrefix),
      imagePurpose: kind === "image" ? (imagePurposes[0] ?? null) : null,
      durationMs: null,
    }));
    addReferences(mode, pending);
    await Promise.all(
      pending.map(async (reference, index) => {
        try {
          const file = accepted[index]!;
          const validated =
            kind === "image" ? await validateImageBlob(file) : await validateMediaBlob(file, kind);
          if (kind === "image" && validated.mimeType === "image/svg+xml")
            throw new Error("暂不支持 SVG，请上传 PNG、JPEG 或 WebP");
          const previewUrl = URL.createObjectURL(validated.blob);
          updateReference(mode, reference.id, { previewUrl });
          const intent = await createMediaUpload({
            kind,
            name: reference.name,
            mimeType: validated.mimeType,
            size: validated.blob.size,
            idempotencyKey: reference.uploadKey,
          });
          const ready = intent.upload
            ? await uploadMediaBlob(intent.media, intent.upload, validated.blob)
            : intent.media;
          if (ready.status !== "ready") throw new Error(ready.error?.message ?? "素材处理失败");
          updateReference(mode, reference.id, {
            serverId: ready.id,
            status: "ready",
            error: null,
            // 上传回包里就带探测出的时长（视频/音频才有）：参考视频必须成对
            // 声明时长，拿到就不必再查一次素材元数据。
            durationMs: kind === "image" ? null : (ready.durationMs ?? null),
          });
        } catch (cause) {
          updateReference(mode, reference.id, {
            status: "error",
            error: cause instanceof Error ? cause.message : "素材上传失败",
          });
        }
      }),
    );
  };

  const uploadFiles = async (files: File[]) => {
    if (!files.length || !model) return;
    setUploadError(null);
    // 按文件内容分类（MIME → 扩展名 → 魔数）：下载素材的 file.type 常为空，
    // 只按 MIME 分组会让这些文件在拖入/粘贴后无声消失。
    const grouped: Record<MaterialKind, File[]> = { image: [], video: [], audio: [] };
    for (const file of files) {
      const kind = await inferMaterialKind(file);
      if (kind) grouped[kind].push(file);
    }
    const groups = (Object.keys(grouped) as MaterialKind[])
      .filter((kind) => grouped[kind].length && supportedKinds.has(kind))
      .map((kind) => ({ kind, items: grouped[kind] }));
    if (!groups.length) {
      setUploadError("当前模型不支持该类型素材");
      return;
    }
    await Promise.all(groups.map(({ kind, items }) => uploadKind(kind, items)));
  };

  const onFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    void uploadFiles(files);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    event.preventDefault();
    setDragActive(false);
    void uploadFiles(files);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (event.dataTransfer?.types.includes("Files")) {
      event.preventDefault();
      setDragActive(true);
    }
  };

  const onDragLeave = (event: DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length) void uploadFiles(files);
  };

  /** 编码当前模型与参数，交给 /generate 工作台（自动提交一次）。 */
  const generateUrl = (modality: DirectModality, text: string, { carryModel = true } = {}) => {
    const query = new URLSearchParams();
    const trimmed = text.trim();
    if (trimmed) query.set("prompt", trimmed);
    if (carryModel && modality === mode) {
      if (model?.id) query.set("model", model.id);
      for (const parameter of editableParameters) {
        const value = parameters[parameter.name];
        if (value !== undefined && value !== null && value !== "")
          query.set(`p_${parameter.name}`, JSON.stringify(value));
      }
    }
    // Mark this as an intentional handoff: the workbench reads the shared
    // reference store for uploaded materials and auto-submits once with the
    // prompt + mentions the user already composed here.
    query.set("autosubmit", "1");
    const suffix = query.toString();
    return `/generate/${modality}${suffix ? `?${suffix}` : ""}`;
  };

  const goGenerate = (modality: DirectModality, text: string) => {
    // 工作台对游客开放：未配置 API / 未登录时由工作台内诚实拦截并指向设置。
    window.location.assign(generateUrl(modality, text));
  };

  const submit = () => goGenerate(mode, prompt);

  /** 文本框按键：@ 引用菜单导航优先，其次 Enter 提交（Shift+Enter 换行）。 */
  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionRange && visibleMentionCandidates.length) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setMentionIndex((current) => (current + 1) % visibleMentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setMentionIndex(
          (current) =>
            (current - 1 + visibleMentionCandidates.length) % visibleMentionCandidates.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        chooseMention(visibleMentionCandidates[mentionIndex] ?? visibleMentionCandidates[0]!);
        return;
      }
      if (event.key === "Escape") {
        setMentionRange(null);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return {
    mode,
    changeMode,
    prompt,
    updatePrompt,
    promptRef,
    fileInputRef,
    mentionRange,
    mentionIndex,
    visibleMentionCandidates,
    chooseMention,
    mentionReference,
    references,
    removeReference,
    dragActive,
    uploadError,
    catalog,
    models,
    model,
    setModelId,
    parameters,
    setParameter,
    editableParameters,
    materialControls,
    acceptedMimes,
    onFileInput,
    onDrop,
    onDragOver,
    onDragLeave,
    onPaste,
    generateUrl,
    goGenerate,
    submit,
    handlePromptKeyDown,
  };
}

export type DirectComposerState = ReturnType<typeof useDirectComposer>;
