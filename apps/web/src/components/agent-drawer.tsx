import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleStop,
  Copy,
  FilePlus2,
  History,
  Maximize2,
  LoaderCircle,
  LogIn,
  Plus,
  Pencil,
  Plug,
  RefreshCw,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import type {
  AgentConversation,
  AgentCreativeGuidance,
  AgentCreativeMode,
  AgentMessage as AgentMessageData,
  AgentRun,
} from "@kachang/contracts";
import { MAX_AGENT_MESSAGE_CHARS } from "@kachang/contracts";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { executeAgentActions, readAgentActionExecution } from "../lib/agent-action-executor";
import { readAgentCreativeGuidance, readProfessionalBaselineStatus, writeAgentCreativeGuidance } from "../lib/agent-creative-guidance";
import { nodeCreationDimensions } from "../lib/node-factory";
import { readCurrentAgentCanvasContext } from "../lib/current-canvas-context";
import { useAgentStore } from "../state/agent-store";
import { useCanvasStore } from "../state/canvas-store";
import { useUiPreferencesStore } from "../state/ui-preferences-store";
import { useIdentityStore } from "../state/identity-store";
import { useToastStore } from "../state/toast-store";
import { AgentConnectorsPanel } from "./agent-connectors-panel";
import { AgentModelSelect } from "./agent-model-select";
import { CanvasSelect } from "./canvas-select";
import { companionStyleLabel, nextCompanionStyle } from "./agent-companion";

type VisibleAgentCreativeMode = Exclude<AgentCreativeMode, "baseline">;

const CREATIVE_MODE_OPTIONS: Array<{ value: VisibleAgentCreativeMode; label: string; title: string }> = [
  { value: "freeform", label: "自由协作", title: "按当前进程调用专业知识辅助，不强加创作流程" },
  { value: "professional", label: "专业辅助", title: "先确定画面比例、画风与目标时长基线，再按专业阶段推进创作" },
];

type BaselineField = keyof Pick<AgentCreativeGuidance["baseline"], "aspectRatio" | "visualStyle" | "targetDuration">;

const BASELINE_PRESETS: Record<BaselineField, readonly string[]> = {
  aspectRatio: ["16:9", "9:16", "1:1", "4:3"],
  visualStyle: ["电影写实", "商业广告", "动画插画", "水墨东方"],
  targetDuration: ["15 秒", "30 秒", "60 秒", "90 秒"],
};

const BASELINE_STEPS: ReadonlyArray<{
  field: BaselineField;
  label: string;
  prompt: string;
  placeholder: string;
  maxLength: number;
}> = [
  { field: "aspectRatio", label: "画面比例", prompt: "这次创作准备采用什么画面比例？", placeholder: "自定义比例", maxLength: 48 },
  { field: "visualStyle", label: "画风", prompt: "你希望这次创作呈现什么画风？", placeholder: "自定义画风", maxLength: 240 },
  { field: "targetDuration", label: "目标时长", prompt: "这次创作的目标时长是多少？", placeholder: "自定义时长", maxLength: 96 },
];

const messageTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const AGENT_THINKING_LABELS: Record<string, string> = {
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
  ultra: "极限",
};

function thinkingLevelLabel(level: string) {
  return AGENT_THINKING_LABELS[level] ?? level;
}

export const AgentDrawer = memo(function AgentDrawer() {
  const open = useAgentStore((state) => state.open);
  const close = useAgentStore((state) => state.close);
  const conversations = useAgentStore((state) => state.conversations);
  const activeConversationId = useAgentStore((state) => state.activeConversationId);
  const detail = useAgentStore((state) => state.detail);
  const agentStatus = useAgentStore((state) => state.status);
  const error = useAgentStore((state) => state.error);
  const models = useAgentStore((state) => state.models);
  const modelStatus = useAgentStore((state) => state.modelStatus);
  const modelError = useAgentStore((state) => state.modelError);
  const selectedModelId = useAgentStore((state) => state.selectedModelId);
  const reasoningEffort = useAgentStore((state) => state.reasoningEffort);
  const setReasoningEffort = useAgentStore((state) => state.setReasoningEffort);
  const load = useAgentStore((state) => state.load);
  const loadModels = useAgentStore((state) => state.loadModels);
  const setSelectedModelId = useAgentStore((state) => state.setSelectedModelId);
  const reset = useAgentStore((state) => state.reset);
  const createConversation = useAgentStore((state) => state.createConversation);
  const selectConversation = useAgentStore((state) => state.selectConversation);
  const send = useAgentStore((state) => state.send);
  const cancel = useAgentStore((state) => state.cancel);
  const confirmProposal = useAgentStore((state) => state.confirmProposal);
  const dismissProposal = useAgentStore((state) => state.dismissProposal);
  const recordReceipt = useAgentStore((state) => state.recordReceipt);
  const projectId = useCanvasStore((state) => state.projectId);
  const projectName = useCanvasStore((state) => state.projectName);
  const companionStyle = useUiPreferencesStore((state) => state.companionStyle);
  const setCompanionStyle = useUiPreferencesStore((state) => state.setCompanionStyle);
  const identityStatus = useIdentityStore((state) => state.status);
  const identityError = useIdentityStore((state) => state.error);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const hydrateIdentity = useIdentityStore((state) => state.hydrate);
  const showToast = useToastStore((state) => state.show);
  const identityMode = identityStatus === "authenticated" ? "authenticated" : "anonymous";
  const isAuthenticated = identityStatus === "authenticated";
  const [draft, setDraft] = useState("");
  const [connectorsOpen, setConnectorsOpen] = useState(false);
  const [creativeGuidance, setCreativeGuidance] = useState<AgentCreativeGuidance>(() => readAgentCreativeGuidance(projectId));
  const [showLatest, setShowLatest] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [proposalPending, setProposalPending] = useState<"confirm" | "dismiss" | "modify" | null>(null);
  const [readerMessage, setReaderMessage] = useState<AgentMessageData | null>(null);
  const [readerDraft, setReaderDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const wasNearBottom = useRef(true);
  const previousConversationId = useRef<string | null>(null);
  const previousIdentityMode = useRef(identityMode);
  const processingRuns = useRef(new Set<string>());
  const drawerRef = useRef<HTMLElement>(null);
  const thinkingLevels = useMemo(
    () => models.find((model) => model.id === selectedModelId)?.thinking?.levels ?? [],
    [models, selectedModelId],
  );
  const thinkingDefault = thinkingLevels.includes("medium") ? "medium" : thinkingLevels[0] ?? "";
  const thinkingOptions = useMemo(() => thinkingLevels.map((level) => ({
    value: level,
    label: `思考 · ${thinkingLevelLabel(level)}`,
    title: thinkingLevelLabel(level),
  })), [thinkingLevels]);
  const activeRun = detail?.latestRun;
  const running = activeRun?.status === "queued" || activeRun?.status === "running";
  const busy = agentStatus === "sending" || running || cancelPending || proposalPending !== null;
  const modelReady = modelStatus === "ready"
    && selectedModelId !== null
    && models.some((model) => model.id === selectedModelId);
  const characterMood = running || agentStatus === "sending"
    ? "thinking"
    : activeRun?.status === "failed" || agentStatus === "error"
      ? "concerned"
      : detail?.messages.at(-1)?.role === "assistant"
        ? "speaking"
        : "listening";
  const panelStatus = getPanelStatus({ identityStatus, agentStatus, running, cancelPending });
  const lastMessage = detail?.messages.at(-1) ?? null;
  const hasUserMessage = detail?.messages.some((message) => message.role === "user") ?? false;
  const professionalBaselineStatus = readProfessionalBaselineStatus(creativeGuidance);
  const missingBaselineStepIndex = BASELINE_STEPS.findIndex(
    ({ field }) => !creativeGuidance.baseline[field]?.trim(),
  );
  const baselineStepIndex = missingBaselineStepIndex >= 0
    ? missingBaselineStepIndex
    : BASELINE_STEPS.length - 1;
  const activeBaselineStep = creativeGuidance.mode === "professional"
    && hasUserMessage
    && !professionalBaselineStatus.ready
    ? BASELINE_STEPS[baselineStepIndex] ?? BASELINE_STEPS.at(-1)!
    : null;

  useEffect(() => {
    const identityChanged = previousIdentityMode.current !== identityMode;
    previousIdentityMode.current = identityMode;
    if (identityChanged) reset();
    if (open && identityStatus === "authenticated") {
      void Promise.all([load(projectId, identityChanged), loadModels(true)]);
    }
  }, [identityMode, identityStatus, load, loadModels, open, projectId, reset]);

  useEffect(() => {
    const nextGuidance = readAgentCreativeGuidance(projectId);
    setCreativeGuidance(nextGuidance);
  }, [projectId]);

  useEffect(() => {
    if (!open || !isAuthenticated) return;
    if (!window.matchMedia("(pointer: fine)").matches || window.innerWidth <= 720) return;
    const focusedAtOpen = document.activeElement;
    const timeoutId = window.setTimeout(() => {
      const activeElement = document.activeElement;
      const focusStillAvailable = activeElement === focusedAtOpen
        || activeElement === document.body
        || activeElement?.classList.contains("kc-agent-companion");
      if (focusStillAvailable) textareaRef.current?.focus({ preventScroll: true });
    }, 180);
    return () => window.clearTimeout(timeoutId);
  }, [isAuthenticated, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || !drawerRef.current?.contains(document.activeElement)) return;
      event.preventDefault();
      close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [close, open]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list || !detail) return;
    const conversationChanged = previousConversationId.current !== detail.conversation.id;
    previousConversationId.current = detail.conversation.id;
    if (conversationChanged || wasNearBottom.current) {
      list.scrollTop = list.scrollHeight;
      setShowLatest(false);
    } else {
      setShowLatest(true);
    }
  }, [
    detail?.conversation.id,
    detail?.messages.length,
    detail?.latestRun?.status,
    detail?.latestRun?.proposalStatus,
    detail?.latestRun?.receipt?.createdAt,
    activeBaselineStep?.field,
  ]);

  useEffect(() => {
    const run = detail?.latestRun;
    const conversationId = detail?.conversation.id;
    const executable = run?.executionMode === "direct"
      || (run?.executionMode === "proposal" && run.proposalStatus === "confirmed");
    if (!run || !conversationId || run.status !== "completed" || !run.actions.length || run.receipt || !executable) return;
    const executionId = `${conversationId}:${run.id}`;
    if (processingRuns.current.has(executionId)) return;
    processingRuns.current.add(executionId);

    void (async () => {
      const before = readCurrentAgentCanvasContext(creativeGuidance);
      const recovered = readAgentActionExecution(projectId, run.id);
      const baselineStatus = readProfessionalBaselineStatus(creativeGuidance);
      if (!recovered && baselineStatus.required && !baselineStatus.ready) {
        const reason = `专业辅助需先完成基线：${baselineStatus.missing.join("、")}`;
        const recorded = await recordReceipt(conversationId, run.id, {
          contextRevisionBefore: before.contextRevision,
          contextRevisionAfter: before.contextRevision,
          appliedActions: 0,
          skippedActions: run.actions.map((_, index) => ({ index, reason })),
          status: "rejected",
          reason,
        });
        showToast(recorded ? reason : "基线未完成，画布操作已阻止，但回执暂未同步", "error");
        processingRuns.current.delete(executionId);
        return;
      }
      if (!recovered && before.contextRevision !== run.contextRevision) {
        const reason = "画布在提案后已发生变化，本次操作没有执行";
        const recorded = await recordReceipt(conversationId, run.id, {
          contextRevisionBefore: before.contextRevision,
          contextRevisionAfter: before.contextRevision,
          appliedActions: 0,
          skippedActions: run.actions.map((_, index) => ({ index, reason })),
          status: "rejected",
          reason,
        });
        showToast(recorded ? `${reason}，请重新提案` : "旧提案已阻止执行，但回执暂未同步", "error");
        processingRuns.current.delete(executionId);
        return;
      }

      try {
        const result = recovered ?? executeAgentActions(projectId, run.id, run.actions);
        const after = readCurrentAgentCanvasContext(creativeGuidance);
        const status = result.skipped === 0 && result.applied === run.actions.length
          ? "applied"
          : result.applied > 0
            ? "partial"
            : "rejected";
        const reason = status === "applied"
          ? null
          : status === "partial"
            ? `已应用 ${result.applied} 项，另有 ${result.skipped} 项未能应用`
            : "画布未接受这组操作";
        const recorded = await recordReceipt(conversationId, run.id, {
          contextRevisionBefore: recovered ? run.contextRevision : before.contextRevision,
          contextRevisionAfter: after.contextRevision,
          appliedActions: result.applied,
          skippedActions: result.skippedActions,
          status,
          reason,
        });
        if (!recorded) {
          showToast("画布操作已完成，但执行回执暂未同步", "error");
        } else if (!result.alreadyApplied) {
          showToast(
            status === "applied"
              ? `Agent 已完成 ${result.applied} 项画布操作`
              : reason || "Agent 操作未能完整应用",
            status === "applied" ? "success" : "error",
          );
        }
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message : "Agent 操作未能应用到画布";
        const after = readCurrentAgentCanvasContext(creativeGuidance);
        await recordReceipt(conversationId, run.id, {
          contextRevisionBefore: recovered ? run.contextRevision : before.contextRevision,
          contextRevisionAfter: after.contextRevision,
          appliedActions: 0,
          skippedActions: run.actions.map((_, index) => ({ index, reason })),
          status: "rejected",
          reason,
        });
        showToast(reason, "error");
      } finally {
        processingRuns.current.delete(executionId);
      }
    })();
  }, [creativeGuidance, detail?.conversation.id, detail?.latestRun, projectId, recordReceipt, showToast]);

  if (!open) return null;

  const copyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      showToast("已复制", "success");
    } catch {
      showToast("复制失败，请手动选择文本", "error");
    }
  };

  /** 把这条内容变成画布上的文本节点（放在当前视口中心）。 */
  const createTextNodeFromMessage = (body: string) => {
    const text = body.trim();
    if (!text) {
      showToast("内容为空，无法创建节点", "error");
      return;
    }
    try {
      const state = useCanvasStore.getState();
      const shell = document.querySelector<HTMLElement>(".kc-flow-shell");
      const rect = shell?.getBoundingClientRect();
      const viewport = state.viewport;
      const screenX = rect ? rect.left + rect.width / 2 : window.innerWidth / 2;
      const screenY = rect ? rect.top + rect.height / 2 : window.innerHeight / 2;
      const flowX = (screenX - (rect?.left ?? 0) - viewport.x) / (viewport.zoom || 1);
      const flowY = (screenY - (rect?.top ?? 0) - viewport.y) / (viewport.zoom || 1);
      const dimensions = nodeCreationDimensions("text", useUiPreferencesStore.getState().defaultNodeAspectRatio);
      const id = state.addNode("text", { x: flowX - dimensions.width / 2, y: flowY - dimensions.height / 2 });
      state.updateNodeData(id, { body: text }, false);
      showToast("已创建文本节点", "success");
      setReaderMessage(null);
    } catch (cause) {
      showToast(cause instanceof Error ? cause.message : "创建文本节点失败", "error");
    }
  };

    const submit = async () => {
    if (!isAuthenticated) {
      openAccount("login");
      return;
    }
    if (busy || !draft.trim()) return;
    if (activeBaselineStep) {
      await submitBaselineAnswer(draft);
      return;
    }
    const completed = await send(projectId, draft, readCurrentAgentCanvasContext(creativeGuidance));
    if (completed) setDraft("");
  };

  const onComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submit();
  };

  const scrollToLatest = () => {
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTo({ top: list.scrollHeight, behavior: "smooth" });
    wasNearBottom.current = true;
    setShowLatest(false);
  };

  const stopRun = async () => {
    if (cancelPending) return;
    setCancelPending(true);
    try {
      await cancel();
    } finally {
      setCancelPending(false);
    }
  };

  const resolveProposal = async (mode: "confirm" | "dismiss" | "modify") => {
    if (!activeRun?.proposal || activeRun.proposalStatus !== "pending" || proposalPending) return;
    setProposalPending(mode);
    try {
      if (mode === "confirm") {
        const baselineStatus = readProfessionalBaselineStatus(creativeGuidance);
        if (baselineStatus.required && !baselineStatus.ready) {
          textareaRef.current?.focus({ preventScroll: true });
          showToast(`请先完成基线：${baselineStatus.missing.join("、")}`, "error");
          return;
        }
        const context = readCurrentAgentCanvasContext(creativeGuidance);
        await confirmProposal(context.contextRevision);
        return;
      }
      const dismissed = await dismissProposal();
      if (dismissed && mode === "modify") {
        setDraft(`调整“${activeRun.proposal.title}”：`);
        window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
      }
    } finally {
      setProposalPending(null);
    }
  };

  const saveCreativeGuidance = (next: AgentCreativeGuidance) => {
    setCreativeGuidance(writeAgentCreativeGuidance(projectId, next));
  };

  const submitBaselineAnswer = async (answer: string) => {
    if (!activeBaselineStep || busy) return;
    const value = answer.trim().slice(0, activeBaselineStep.maxLength);
    if (!value) return;
    const finalStep = activeBaselineStep.field === BASELINE_STEPS.at(-1)?.field;
    const nextGuidance: AgentCreativeGuidance = {
      ...creativeGuidance,
      baseline: {
        ...creativeGuidance.baseline,
        [activeBaselineStep.field]: value,
        locked: finalStep,
      },
    };
    const completed = await send(projectId, value, readCurrentAgentCanvasContext(nextGuidance));
    if (!completed) return;
    saveCreativeGuidance(nextGuidance);
    setDraft("");
  };

  const updateCreativeMode = (value: string) => {
    const mode = CREATIVE_MODE_OPTIONS.find((option) => option.value === value)?.value;
    if (!mode) return;
    saveCreativeGuidance({
      ...creativeGuidance,
      mode,
      baseline: creativeGuidance.baseline,
    });
  };

  return (
    <section
      ref={drawerRef}
      className="kc-agent-drawer kc-agent-drawer--refined"
      role="dialog"
      aria-label="画布 Agent"
      aria-modal="false"
      aria-busy={agentStatus === "loading" || agentStatus === "sending" || running || cancelPending}
      data-mood={characterMood}
      data-status={panelStatus.tone}
    >
      <div className="kc-agent-disc">
        <header className="kc-agent-header">
          <span className="kc-agent-mark" aria-hidden="true" data-companion-style={companionStyle}>
            {companionStyle === "whale"
              ? <img className="kc-agent-mark-whale" src="/agent/whale-girl/head.png" alt="" draggable={false} />
              : <Sparkles />}
          </span>
          <span className="kc-agent-title">
            <strong>画布 Agent</strong>
            <small><i aria-hidden="true" />{panelStatus.label}</small>
          </span>
          <AgentThreadMenu
            authenticated={isAuthenticated}
            projectName={projectName}
            conversations={conversations}
            activeConversationId={activeConversationId}
            disabled={agentStatus === "loading" || agentStatus === "sending"}
            creating={agentStatus === "loading"}
            busy={busy}
            onSelect={(next) => void selectConversation(next)}
            onCreate={() => void createConversation(projectId)}
          />
          {isAuthenticated ? (
            <button
              type="button"
              className="kc-agent-header-button"
              aria-label="新建 Agent 对话"
              title="新建对话"
              onClick={() => void createConversation(projectId)}
              disabled={agentStatus === "loading" || busy}
            >
              <Plus aria-hidden="true" />
            </button>
          ) : null}
          {isAuthenticated ? (
            <button
              type="button"
              className="kc-agent-header-button"
              aria-label="外部连接"
              title="外部连接：Codex 操作画布 / Agent 操作 Blender"
              aria-pressed={connectorsOpen}
              onClick={() => setConnectorsOpen((value) => !value)}
            >
              <Plug aria-hidden="true" />
            </button>
          ) : null}
          <button
            type="button"
            className="kc-agent-header-button"
            aria-label={`切换伙伴形象（当前：${companionStyleLabel(companionStyle)}）`}
            title={`伙伴形象：${companionStyleLabel(companionStyle)}（点击切换为${companionStyleLabel(nextCompanionStyle(companionStyle))}）`}
            aria-pressed={companionStyle === "whale"}
            onClick={() => setCompanionStyle(nextCompanionStyle(companionStyle))}
          >
            <Bot aria-hidden="true" />
          </button>
          <button type="button" className="kc-agent-header-button" aria-label="收起 Agent" title="收起" onClick={close}>
            <X aria-hidden="true" />
          </button>
        </header>

        {!isAuthenticated ? (
          <AgentAuthGate
            status={identityStatus}
            error={identityError}
            onLogin={() => openAccount("login")}
            onRetry={() => void hydrateIdentity(true)}
          />
        ) : (
          <>
            <div
              ref={messageListRef}
              className="kc-agent-messages"
              role="log"
              aria-label="Agent 回复"
              aria-live="polite"
              onScroll={(event) => {
                const target = event.currentTarget;
                const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 72;
                wasNearBottom.current = nearBottom;
                if (nearBottom) setShowLatest(false);
              }}
            >

            {agentStatus === "loading" && !detail ? <AgentLoading /> : null}
            {isAuthenticated
              && agentStatus === "ready"
              && !activeBaselineStep
              && !running
              && (!detail || detail.messages.length === 0) ? (
              <AgentEmptyState
                disabled={busy || !modelReady}
                onUseStarter={(value) => {
                  setDraft(value);
                  window.requestAnimationFrame(() => textareaRef.current?.focus({ preventScroll: true }));
                }}
              />
            ) : null}
              {detail?.messages.map((message) => (
                <AgentMessageItem
                  key={message.id}
                  message={message}
                  onCopy={(content) => void copyMessage(content)}
                  onOpen={(target) => { setReaderMessage(target); setReaderDraft(target.content); }}
                />
              ))}
            {activeBaselineStep ? (
              <AgentBaselineQuestion
                step={activeBaselineStep}
                stepIndex={baselineStepIndex}
                compact={lastMessage?.role === "assistant"}
                disabled={busy}
                onSelect={(value) => void submitBaselineAnswer(value)}
              />
            ) : null}
            {activeRun?.status === "completed" && activeRun.proposal && !activeRun.receipt ? (
              <AgentProposalCard
                run={activeRun}
                pending={proposalPending}
                onConfirm={() => void resolveProposal("confirm")}
                onModify={() => void resolveProposal("modify")}
                onDismiss={() => void resolveProposal("dismiss")}
              />
            ) : null}
            {activeRun?.status === "completed" && activeRun.receipt ? (
              <AgentReceiptCard run={activeRun} />
            ) : null}
            {running ? (
              <div className="kc-agent-run" role="status">
                <span className="kc-agent-run-indicator" aria-hidden="true"><LoaderCircle className="is-spinning" /></span>
                <span className="kc-agent-run-copy">
                  <strong>{activeRun?.status === "queued" ? "任务已排队" : "正在整理画布"}</strong>
                  <small>{cancelPending ? "正在停止" : "正在生成回复"}</small>
                </span>
                <button type="button" aria-label="取消 Agent 任务" title="停止" onClick={() => void stopRun()} disabled={cancelPending}>
                  {cancelPending ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Square aria-hidden="true" />}
                  <span>{cancelPending ? "停止中" : "停止"}</span>
                </button>
              </div>
            ) : null}
            {activeRun?.status === "failed" && activeRun.error ? (
              <div className="kc-agent-run-error" role="alert"><CircleAlert aria-hidden="true" /><span>{activeRun.error.message}</span></div>
            ) : null}
            {activeRun?.status === "cancelled" ? (
              <div className="kc-agent-run-cancelled" role="status"><CircleStop aria-hidden="true" /><span>已停止这次处理</span></div>
            ) : null}
            {error ? (
              <div className="kc-agent-request-error" role="alert">
                <CircleAlert aria-hidden="true" />
                <span>{error}</span>
                <button type="button" aria-label="重新连接 Agent" title="重新连接" onClick={() => void load(projectId, true)}><RefreshCw aria-hidden="true" /></button>
              </div>
            ) : null}
            </div>
          </>
        )}

        {isAuthenticated && showLatest ? (
          <button type="button" className="kc-agent-latest" aria-label="跳到最新消息" title="最新消息" onClick={scrollToLatest}><ArrowDown aria-hidden="true" /></button>
        ) : null}
      </div>

      {isAuthenticated && connectorsOpen ? (
        <AgentConnectorsPanel onClose={() => setConnectorsOpen(false)} />
      ) : null}

      {isAuthenticated ? (
        <div className="kc-agent-composer" data-busy={busy ? "true" : "false"} data-has-value={draft.trim() ? "true" : "false"}>
          <textarea
            ref={textareaRef}
            aria-label="发送给 Agent"
            value={draft}
            rows={3}
            maxLength={activeBaselineStep?.maxLength ?? MAX_AGENT_MESSAGE_CHARS}
            placeholder={activeBaselineStep
              ? `输入${activeBaselineStep.placeholder}`
              : busy
                ? "可以先写下下一步"
                : "描述你想推进的内容"}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onComposerKeyDown}
          />
          <div className="kc-agent-composer-footer">
            <CanvasSelect
              className="kc-agent-mode-select kc-agent-mode-select--footer"
              ariaLabel="创作协作模式"
              value={creativeGuidance.mode}
              options={CREATIVE_MODE_OPTIONS}
              onChange={updateCreativeMode}
              disabled={busy}
              variant="compact"
              menuMinWidth={180}
            />
            <div
              className={`kc-agent-model-field${modelStatus === "error" ? " kc-agent-model-error" : ""}`}
              role={modelStatus === "error" ? "status" : undefined}
            >
                <AgentModelSelect
                  ariaLabel="Agent 模型"
                  value={selectedModelId || ""}
                  models={models}
                  placeholder={modelStatus === "loading" ? "加载模型" : modelStatus === "error" ? "模型不可用" : "选择模型"}
                  onChange={setSelectedModelId}
                  disabled={busy || modelStatus !== "ready"}
                />
              {modelStatus === "error" ? (
                <>
                  <span className="kc-visually-hidden">{modelError || "Agent 模型列表没有加载完成"}</span>
                  <button
                    type="button"
                    className="kc-agent-model-retry"
                    aria-label="重新加载 Agent 模型"
                    title={modelError || "重新加载模型列表"}
                    onClick={() => void loadModels(true)}
                  >
                    <RefreshCw aria-hidden="true" />
                  </button>
                </>
              ) : null}
            </div>
            {models.length ? (
              <CanvasSelect
                className="kc-agent-thinking-select"
                ariaLabel="思考强度"
                value={reasoningEffort ?? thinkingDefault}
                options={thinkingOptions.length
                  ? thinkingOptions
                  : [{ value: "", label: "思考 · 默认", title: "该模型未声明思考强度" }]}
                onChange={(next) => setReasoningEffort(next)}
                disabled={busy || modelStatus !== "ready" || thinkingLevels.length < 2}
                variant="compact"
                menuMinWidth={148}
              />
            ) : null}
            <button type="button" className="kc-agent-send" aria-label="发送给 Agent" title="发送" disabled={!draft.trim() || busy || agentStatus === "loading" || !modelReady} onClick={() => void submit()}>
              {agentStatus === "sending" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
            </button>
          </div>
        </div>
      ) : null}

      {readerMessage ? createPortal(
        <div
          className="kc-agent-reader-scrim"
          role="presentation"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setReaderMessage(null);
          }}
        >
          <section className="kc-agent-reader" role="dialog" aria-modal="true" aria-label="消息全文">
            <header>
              <strong>{readerMessage.role === "assistant" ? "Agent 回复" : "我的提示词"}</strong>
              <span>{readerDraft.length} 字</span>
              <button type="button" aria-label="关闭" title="关闭" onClick={() => setReaderMessage(null)}>
                <X aria-hidden="true" />
              </button>
            </header>
            <textarea
              aria-label="消息全文"
              value={readerDraft}
              onChange={(event) => setReaderDraft(event.target.value)}
              spellCheck={false}
            />
            <footer>
              <button type="button" onClick={() => void copyMessage(readerDraft)}>
                <Copy aria-hidden="true" />复制
              </button>
              <button type="button" className="is-primary" onClick={() => createTextNodeFromMessage(readerDraft)}>
                <FilePlus2 aria-hidden="true" />创建文本节点
              </button>
              <button type="button" onClick={() => setReaderMessage(null)}>关闭</button>
            </footer>
          </section>
        </div>,
        document.body,
      ) : null}
    </section>
  );
});

const AGENT_STARTERS = [
  { label: "梳理当前画布", prompt: "帮我梳理当前画布的结构，指出最需要补强的一步。" },
  { label: "补一个分镜", prompt: "基于现有节点，帮我补一个能衔接前后节奏的分镜节点。" },
  { label: "优化提示词", prompt: "帮我优化画布里最影响成片质量的提示词。" },
] as const;

function AgentThreadMenu({
  authenticated,
  projectName,
  conversations,
  activeConversationId,
  disabled,
  creating,
  busy,
  onSelect,
  onCreate,
}: {
  authenticated: boolean;
  projectName: string;
  conversations: AgentConversation[];
  activeConversationId: string | null;
  disabled: boolean;
  creating: boolean;
  busy: boolean;
  onSelect: (conversationId: string) => void;
  onCreate: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = conversations.find((conversation) => conversation.id === activeConversationId) ?? null;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const keyboard = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // 只收起对话记录，不要冒泡去触发抽屉自身的关闭快捷键。
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", keyboard);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", keyboard);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  if (!authenticated) {
    return <span className="kc-agent-project-name" title={projectName}>{projectName}</span>;
  }

  return (
    <div className="kc-agent-thread" ref={rootRef} data-value={activeConversationId ?? ""}>
      <button
        type="button"
        className="kc-agent-thread-trigger"
        aria-label="Agent 对话"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <History aria-hidden="true" />
        <span className="kc-agent-thread-title">{active?.title ?? "新对话"}</span>
        <ChevronDown aria-hidden="true" className="kc-agent-thread-caret" />
      </button>
      {open ? (
        <div className="kc-agent-thread-menu" role="menu" aria-label="对话记录">
          <button
            type="button"
            role="menuitem"
            className="kc-agent-thread-new"
            onClick={() => {
              setOpen(false);
              onCreate();
            }}
            disabled={creating || busy}
          >
            <Plus aria-hidden="true" />
            <span>新建对话</span>
          </button>
          <div className="kc-agent-thread-divider" aria-hidden="true" />
          <div className="kc-agent-thread-list">
            {conversations.length ? conversations.map((conversation) => {
              const current = conversation.id === activeConversationId;
              return (
                <button
                  key={conversation.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={current}
                  className={`kc-agent-thread-item${current ? " is-active" : ""}`}
                  onClick={() => {
                    setOpen(false);
                    if (!current) onSelect(conversation.id);
                  }}
                >
                  <span className="kc-agent-thread-item-copy">
                    <strong>{conversation.title}</strong>
                    <small>{formatThreadTime(conversation.updatedAt)}</small>
                  </span>
                  {current ? <Check aria-hidden="true" /> : null}
                </button>
              );
            }) : <div className="kc-agent-thread-empty">还没有历史对话</div>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AgentEmptyState({
  disabled,
  onUseStarter,
}: {
  disabled: boolean;
  onUseStarter: (value: string) => void;
}) {
  return (
    <div className="kc-agent-empty">
      <span className="kc-agent-empty-mark" aria-hidden="true"><Sparkles /></span>
      <strong>说说这一步想做什么</strong>
      <small>Agent 能看到当前画布的节点和连线，可以直接增删节点、接好上下游。</small>
      <div className="kc-agent-starters">
        {AGENT_STARTERS.map((starter) => (
          <button key={starter.label} type="button" disabled={disabled} onClick={() => onUseStarter(starter.prompt)}>
            {starter.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const threadTimeFormatter = new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

function formatThreadTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const elapsed = Date.now() - date.getTime();
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))} 小时前`;
  if (elapsed < 7 * 24 * 60 * 60_000) return `${Math.floor(elapsed / (24 * 60 * 60_000))} 天前`;
  return threadTimeFormatter.format(date);
}

const AgentMessageItem = memo(function AgentMessageItem({ message, onOpen, onCopy }: {
  message: AgentMessageData;
  onOpen: (message: AgentMessageData) => void;
  onCopy: (content: string) => void;
}) {
  const time = formatMessageTime(message.createdAt);
  const sender = message.role === "assistant" ? "Agent" : "你";
  const paragraphs = message.content.split(/\n\s*\n/);

  return (
    <article
      className={`kc-agent-message kc-agent-message--${message.role}`}
      aria-label={`${sender}的消息`}
      onDoubleClick={() => onOpen(message)}
      title="双击放大阅读 / 编辑 / 建为文本节点"
    >
      {message.role === "assistant" ? <span className="kc-agent-message-icon" aria-hidden="true"><Sparkles /></span> : null}
      <div className="kc-agent-message-body">
        <div className="kc-agent-message-content">
          {paragraphs.map((paragraph, index) => <p key={`${message.id}-${index}`}>{paragraph}</p>)}
        </div>
        <span className="kc-agent-message-foot">
          {time ? <time dateTime={message.createdAt}>{time}</time> : null}
          <button type="button" className="kc-agent-message-tool" aria-label={`复制这条${sender}消息`} title="复制" onClick={() => onCopy(message.content)}><Copy aria-hidden="true" /></button>
          <button type="button" className="kc-agent-message-tool" aria-label={`放大阅读这条${sender}消息`} title="放大阅读 / 建为文本节点" onClick={() => onOpen(message)}><Maximize2 aria-hidden="true" /></button>
        </span>
      </div>
    </article>
  );
});

function AgentProposalCard({
  run,
  pending,
  onConfirm,
  onModify,
  onDismiss,
}: {
  run: AgentRun;
  pending: "confirm" | "dismiss" | "modify" | null;
  onConfirm: () => void;
  onModify: () => void;
  onDismiss: () => void;
}) {
  if (!run.proposal) return null;
  if (run.proposalStatus === "confirmed") {
    return (
      <div className="kc-agent-proposal-state" role="status">
        <LoaderCircle className="is-spinning" aria-hidden="true" />
        <span><strong>提案已确认</strong><small>正在核对画布并应用操作</small></span>
      </div>
    );
  }
  if (run.proposalStatus === "dismissed") {
    return (
      <div className="kc-agent-proposal-state is-dismissed" role="status">
        <CircleStop aria-hidden="true" />
        <span><strong>提案已取消</strong><small>画布没有发生修改</small></span>
      </div>
    );
  }
  return (
    <section className="kc-agent-proposal" aria-label="待确认的 Agent 提案">
      <header>
        <span><Sparkles aria-hidden="true" /></span>
        <div><small>{run.actions.length} 项画布操作</small><strong>{run.proposal.title}</strong></div>
      </header>
      <p>{run.proposal.reason}</p>
      <ul>
        {run.proposal.successCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}
      </ul>
      <footer>
        <button type="button" className="is-primary" onClick={onConfirm} disabled={pending !== null}>
          {pending === "confirm" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Check aria-hidden="true" />}
          确认
        </button>
        <button type="button" onClick={onModify} disabled={pending !== null}>
          {pending === "modify" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Pencil aria-hidden="true" />}
          修改
        </button>
        <button type="button" onClick={onDismiss} disabled={pending !== null}>
          {pending === "dismiss" ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <X aria-hidden="true" />}
          取消
        </button>
      </footer>
    </section>
  );
}

function AgentReceiptCard({ run }: { run: AgentRun }) {
  const receipt = run.receipt;
  if (!receipt) return null;
  const label = receipt.status === "applied"
    ? `已应用 ${receipt.appliedActions} 项操作`
    : receipt.status === "partial"
      ? `已应用 ${receipt.appliedActions} 项，跳过 ${receipt.skippedActions.length} 项`
      : "操作未执行";
  return (
    <div className="kc-agent-receipt" data-status={receipt.status} role="status">
      {receipt.status === "applied" ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
      <span><strong>{label}</strong>{receipt.reason ? <small>{receipt.reason}</small> : null}</span>
    </div>
  );
}

function AgentBaselineQuestion({
  step,
  stepIndex,
  compact,
  disabled,
  onSelect,
}: {
  step: (typeof BASELINE_STEPS)[number];
  stepIndex: number;
  compact: boolean;
  disabled: boolean;
  onSelect: (value: string) => void;
}) {
  return (
    <section className="kc-agent-baseline-question" aria-label={`专业辅助问题 ${stepIndex + 1} / ${BASELINE_STEPS.length}`}>
      <div className="kc-agent-baseline-progress">
        <span>{step.label} · {stepIndex + 1}/{BASELINE_STEPS.length}</span>
        <div aria-hidden="true">
          {BASELINE_STEPS.map((item, index) => (
            <i key={item.field} data-active={index === stepIndex ? "true" : undefined} data-complete={index < stepIndex ? "true" : undefined} />
          ))}
        </div>
      </div>
      {!compact ? <strong>{step.prompt}</strong> : null}
      <div className="kc-agent-baseline-options" role="group" aria-label={`${step.label}预设`}>
        {BASELINE_PRESETS[step.field].map((preset) => (
          <button key={preset} type="button" disabled={disabled} onClick={() => onSelect(preset)}>{preset}</button>
        ))}
      </div>
      <small>也可以在下方直接输入{step.placeholder}</small>
    </section>
  );
}

function AgentAuthGate({
  status,
  error,
  onLogin,
  onRetry,
}: {
  status: ReturnType<typeof useIdentityStore.getState>["status"];
  error: string | null;
  onLogin: () => void;
  onRetry: () => void;
}) {
  if (status === "loading" || status === "idle") {
    return (
      <div className="kc-agent-auth-gate" role="status">
        <LoaderCircle className="is-spinning" aria-hidden="true" />
        <strong>正在确认账号</strong>
      </div>
    );
  }

  if (status === "unavailable") {
    return (
      <div className="kc-agent-auth-gate is-error" role="status">
        <CircleAlert aria-hidden="true" />
        <strong>账号服务暂不可用</strong>
        {error ? <span>{error}</span> : null}
        <button type="button" onClick={onRetry}><RefreshCw aria-hidden="true" />重新连接</button>
      </div>
    );
  }

  return (
    <div className="kc-agent-auth-gate">
      <LogIn aria-hidden="true" />
      <strong>登录后继续对话</strong>
      <span>当前画布会保留在原位</span>
      <button type="button" onClick={onLogin}><LogIn aria-hidden="true" />登录账号</button>
    </div>
  );
}

function AgentLoading() {
  return (
    <div className="kc-agent-loading" role="status">
      <span><LoaderCircle className="is-spinning" aria-hidden="true" />正在接入画布</span>
      <i />
      <i />
      <i />
    </div>
  );
}

function formatMessageTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : messageTimeFormatter.format(date);
}

function getPanelStatus({
  identityStatus,
  agentStatus,
  running,
  cancelPending,
}: {
  identityStatus: ReturnType<typeof useIdentityStore.getState>["status"];
  agentStatus: ReturnType<typeof useAgentStore.getState>["status"];
  running: boolean;
  cancelPending: boolean;
}) {
  if (identityStatus === "loading" || identityStatus === "idle") return { tone: "loading", label: "确认账号" } as const;
  if (identityStatus === "anonymous") return { tone: "locked", label: "需要登录" } as const;
  if (identityStatus === "unavailable") return { tone: "error", label: "账号离线" } as const;
  if (cancelPending) return { tone: "loading", label: "正在停止" } as const;
  if (running || agentStatus === "sending") return { tone: "working", label: "思考中" } as const;
  if (agentStatus === "loading") return { tone: "loading", label: "连接中" } as const;
  if (agentStatus === "error") return { tone: "error", label: "需要处理" } as const;
  return { tone: "ready", label: "就绪" } as const;
}
