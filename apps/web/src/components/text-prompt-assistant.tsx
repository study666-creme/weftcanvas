import type { CanvasNodeData, PublicModel } from "@weftcanvas/contracts";
import { Lightbulb, LoaderCircle, Wand2 } from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";

import {
  CanvasApiError,
  createGenerationQuote,
  createRequestKey,
  submitGenerationJob,
} from "../lib/api-client";
import {
  beginBrowserSubmission,
  endBrowserSubmission,
  releaseBrowserSubmissionIdentity,
} from "../lib/browser-generation-runtime";
import { isCustomModelKey } from "../lib/custom-api";
import { formatCreditMicros } from "../lib/generation-billing";
import { composeModelParameters, quoteTokenFields } from "../lib/generation-config";
import type { GenerationReferences } from "../lib/generation-inputs";
import { publicModelPickerModels } from "../lib/model-picker";
import {
  composeTextPromptTask,
  describeTextAssistantFailure,
  resolveTextPromptModel,
  type TextPromptTask,
} from "../lib/text-prompt-assistant";
import { useCanvasStore } from "../state/canvas-store";
import { getMergedModels, useCustomApiStore } from "../state/custom-api-store";
import { useGenerationStore } from "../state/generation-store";
import { useIdentityStore } from "../state/identity-store";
import { useToastStore } from "../state/toast-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import { ModelPickerSelect } from "./agent-model-select";
import { modelPickerLabel } from "./generation-model-select";

const ZERO_INPUT_COUNTS = {
  images: 0,
  styleImages: 0,
  elementImages: 0,
  videos: 0,
  audios: 0,
} as const;

const EMPTY_REFERENCES: GenerationReferences = {
  images: [],
  styleImages: [],
  elementImages: [],
  videos: [],
  audios: [],
  connectedImages: [],
  unassignedImages: [],
  imagePurposes: [],
  overflow: [],
  aggregateOverflow: null,
};

/**
 * 平台文本模型在托管通道里还没有执行链（`prompt-hub-service.submitOnce` 只放行
 * image/video），提交必然失败；失败文案见 lib/text-prompt-assistant 里的
 * describeTextAssistantFailure（通道不支持时换成可执行的下一步）。
 */

const EMPTY_GENERATION: CanvasNodeData["generation"] = {
  modelId: null,
  parameters: {},
  referenceImagePurposes: {},
  maxOutputTokens: null,
  referenceMode: "auto",
  referenceNodeIds: [],
  jobId: null,
  jobVersion: null,
  jobCreatedAt: null,
  jobStatus: null,
  error: null,
};

/**
 * 文本模型写不进正文（超时、上游 5xx、传输中断）时，服务端可能已经受理了
 * 这次提交。和生成面板同一条判定：这种结果必须留在「待确认」，不能标失败
 * 让创作者再点一次，否则可能重复扣费。
 */
function isAmbiguousSubmissionFailure(error: unknown) {
  if (error instanceof CanvasApiError) {
    return (
      error.status === 0 || error.status === 408 || error.status === 425 || error.status >= 500
    );
  }
  return true;
}

/**
 * 文本节点上的两个提示词助手动作。它们复用画布既有的文本模型目录与托管 /
 * BYOK 生成管线：
 * - 优化：结果写回当前节点正文；
 * - 生成提示词：结果落到右侧新建的文本节点，原文本保持原样。
 */
export function TextPromptAssistant({ nodeId, data }: { nodeId: string; data: CanvasNodeData }) {
  const platformCatalog = useGenerationStore((state) => state.catalogs.text);
  const loadCatalog = useGenerationStore((state) => state.loadCatalog);
  const watchJob = useGenerationStore((state) => state.watchJob);
  const beginHostedSubmission = useGenerationStore((state) => state.beginHostedSubmission);
  const profiles = useCustomApiStore((state) => state.profiles);
  const hiddenModelKeys = useCustomApiStore((state) => state.hiddenModelKeys);
  const runCustomGeneration = useCustomApiStore((state) => state.runGeneration);
  const identityStatus = useIdentityStore((state) => state.status);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const rememberedModelId = useUiPreferencesStore(
    (state) => state.lastMediaGeneration.text?.modelId,
  );
  const showToast = useToastStore((state) => state.show);
  const [busy, setBusy] = useState<TextPromptTask | null>(null);
  // 同步闸门：两枚按钮共用一次调用。React 状态更新是异步的，连续快速点击
  // 可能在同一帧内进来两次；不做 ref 闸门就会创建两个节点、发两笔付费任务。
  const busyRef = useRef<TextPromptTask | null>(null);

  useEffect(() => {
    void loadCatalog("text");
  }, [loadCatalog]);

  const models = useMemo(
    () => getMergedModels(platformCatalog.data?.models ?? [], "text", profiles, hiddenModelKeys),
    [hiddenModelKeys, platformCatalog.data?.models, profiles],
  );
  const model = resolveTextPromptModel(models, data.generation.modelId, rememberedModelId);
  // 与 Agent 抽屉同款选择器：厂商分组 + 每家模型的真实价格（按次 / 按量）。
  const pickerModels = useMemo(() => publicModelPickerModels(models), [models]);
  const hasText = Boolean(data.body.trim());
  // 与生成面板同一把锁：节点已有文本任务在跑（含提交待确认）时不再发第二笔。
  const generationActive =
    data.status === "running" ||
    (data.generation.jobStatus !== null &&
      ["submitting", "queued", "running", "validating", "submission_unknown"].includes(
        data.generation.jobStatus,
      ));
  const disabled = busy !== null || !model || !hasText || generationActive;
  const disabledReason = !model
    ? "暂时没有可用的文本模型"
    : !hasText
      ? "先写下文本内容"
      : generationActive
        ? "节点正在生成，请等待完成"
        : null;

  const chooseModel = (modelId: string) => {
    const canvas = useCanvasStore.getState();
    const node = canvas.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    canvas.updateNodeData(nodeId, { generation: { ...node.data.generation, modelId } }, false);
  };

  const markFailure = (targetId: string, message: string, ambiguous: boolean) => {
    const canvas = useCanvasStore.getState();
    const node = canvas.nodes.find((item) => item.id === targetId);
    if (!node) return;
    canvas.applyGenerationUpdate(targetId, {
      status: ambiguous ? "running" : "error",
      progress: null,
      generation: {
        ...node.data.generation,
        jobStatus: ambiguous ? "submission_unknown" : "failed",
        error: message,
      },
    });
  };

  const createResultNode = (
    selected: PublicModel,
    parameters: Record<string, unknown>,
    maxOutputTokens: number | null,
  ) => {
    const canvas = useCanvasStore.getState();
    const [targetId] = canvas.addGenerationBatchNodes(nodeId, "text", 1, {
      generation: {
        ...EMPTY_GENERATION,
        modelId: selected.id,
        parameters,
        maxOutputTokens,
      },
    });
    return targetId ?? null;
  };

  const run = async (task: TextPromptTask) => {
    if (busyRef.current) return;
    const source = data.body.trim();
    if (!source) {
      showToast("先写下文本内容，再让助手处理", "info");
      return;
    }
    if (!model) {
      showToast("暂时没有可用的文本模型，请先配置模型或自有 API", "error");
      return;
    }
    const prompt = composeTextPromptTask(task, source);
    if (!prompt.trim()) return;
    const parameters = composeModelParameters(model, prompt, data.generation.parameters);

    if (isCustomModelKey(model.id)) {
      busyRef.current = task;
      setBusy(task);
      const targetId =
        task === "derive"
          ? createResultNode(model, parameters, data.generation.maxOutputTokens)
          : nodeId;
      if (!targetId) {
        busyRef.current = null;
        setBusy(null);
        return;
      }
      try {
        runCustomGeneration({
          nodeId: targetId,
          model,
          modality: "text",
          body: prompt,
          parameters,
          references: EMPTY_REFERENCES,
        });
        showToast(task === "optimize" ? "正在优化提示词" : "正在根据文本生成提示词", "info");
      } catch (cause) {
        if (targetId !== nodeId) useCanvasStore.getState().deleteNode(targetId);
        showToast(cause instanceof Error ? cause.message : "提示词助手暂时不可用", "error");
      } finally {
        busyRef.current = null;
        setBusy(null);
      }
      return;
    }

    if (identityStatus !== "authenticated") {
      openAccount("login");
      showToast("登录后即可使用平台文本模型", "info");
      return;
    }

    busyRef.current = task;
    setBusy(task);
    const canvas = useCanvasStore.getState();
    const projectId = canvas.projectId;
    let targetId: string | null = null;
    let identityCreated = false;
    try {
      const maxOutputTokens = data.generation.maxOutputTokens;
      const tokenFields = quoteTokenFields(
        model,
        prompt,
        data.generation.parameters,
        maxOutputTokens,
      );
      const quote = await createGenerationQuote({
        modelId: model.id,
        modality: "text",
        parameters,
        inputs: ZERO_INPUT_COUNTS,
        quantity: 1,
        ...tokenFields,
      });
      targetId = task === "derive" ? createResultNode(model, parameters, maxOutputTokens) : nodeId;
      if (!targetId) throw new Error("无法创建结果节点");

      const identity = beginHostedSubmission(targetId, () => createRequestKey("prompt-assistant"));
      identityCreated = true;
      beginBrowserSubmission(targetId);
      try {
        const job = await submitGenerationJob({
          projectId,
          nodeId: targetId,
          modelId: model.id,
          modality: "text",
          parameters,
          inputs: { images: [], styleImages: [], elementImages: [], videos: [], audios: [] },
          quantity: 1,
          ...tokenFields,
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
        identityCreated = false;
        watchJob(job);
        showToast(
          `${task === "optimize" ? "正在优化提示词" : "正在生成提示词"} · 预计 ${formatCreditMicros(quote.creditMicros)} 积分`,
          "info",
        );
      } finally {
        endBrowserSubmission(targetId);
      }
    } catch (cause) {
      const message = describeTextAssistantFailure(cause, "提示词助手暂时不可用");
      const ambiguous = identityCreated && isAmbiguousSubmissionFailure(cause);
      if (identityCreated && !ambiguous && targetId)
        releaseBrowserSubmissionIdentity(projectId, targetId);
      if (targetId) markFailure(targetId, ambiguous ? "任务提交结果待确认" : message, ambiguous);
      if (targetId && targetId !== nodeId && !ambiguous) {
        useCanvasStore.getState().deleteNode(targetId);
      }
      if (cause instanceof CanvasApiError && cause.status === 401)
        useIdentityStore.getState().expire();
      showToast(
        ambiguous ? "提交结果待确认，请稍后在任务记录中确认" : message,
        ambiguous ? "info" : "error",
      );
    } finally {
      busyRef.current = null;
      setBusy(null);
    }
  };

  return (
    <>
      <ModelPickerSelect
        className="wc-text-assist-model"
        value={model?.id ?? ""}
        models={pickerModels}
        onChange={chooseModel}
        ariaLabel="提示词助手使用的文本模型"
        placeholder={platformCatalog.status === "loading" ? "读取模型…" : "暂无文本模型"}
        disabled={!models.length || busy !== null}
      />
      <button
        type="button"
        className="wc-text-assist-action"
        aria-label="优化提示词"
        title={disabledReason ?? `用 ${modelPickerLabel(model!)} 优化当前提示词`}
        disabled={disabled}
        onClick={() => void run("optimize")}
      >
        {busy === "optimize" ? (
          <LoaderCircle className="is-spinning" aria-hidden="true" />
        ) : (
          <Wand2 aria-hidden="true" />
        )}
        <span>优化提示词</span>
      </button>
      <button
        type="button"
        className="wc-text-assist-action"
        aria-label="根据文本生成提示词"
        title={
          disabledReason ?? `用 ${modelPickerLabel(model!)} 生成提示词，结果落到右侧新文本节点`
        }
        disabled={disabled}
        onClick={() => void run("derive")}
      >
        {busy === "derive" ? (
          <LoaderCircle className="is-spinning" aria-hidden="true" />
        ) : (
          <Lightbulb aria-hidden="true" />
        )}
        <span>生成提示词</span>
      </button>
    </>
  );
}
