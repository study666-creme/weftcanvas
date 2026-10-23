import type { CanvasNodeData } from "@weftcanvas/contracts";
import { nodeLabel } from "../lib/node-registry";
import { AtSign, Check, Image as ImageIcon, Music2, Plus, Video, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { useMediaUrl } from "../hooks/use-media-url";
import { useNodeOverlayPosition } from "../hooks/use-node-overlay-position";
import { indexIncomingNodeIds } from "../lib/canvas-graph";
import { selectCanvasContentGraph } from "../lib/canvas-content-graph";
import {
  createReferenceMentionMap,
  deletePromptReferenceAtSelection,
  ensurePromptReferenceMentions,
  findPromptReferenceRanges,
  generationReferenceMentionNodeIds,
  isReferenceKind,
  reconcileReferenceMentions,
  referenceKindLabel,
  referenceIdsPresentInBody,
  stripUnboundReferenceMentions,
} from "../lib/prompt-references";
import { collectUpstreamTextContent } from "../lib/generation-inputs";
import { useCanvasStore } from "../state/canvas-store";
import { useUiPreferencesStore, type CompanionAnchor } from "../state/ui-preferences-store";
import { useUiShellStore } from "../state/ui-shell-store";
import type { WeftcanvasEdge, WeftcanvasNode } from "../types";
import { DOCK_RIGHT_CORNER_X } from "./companion-placement";
import { NodeGenerationPanel } from "./node-generation-panel";
import { TextPromptAssistant } from "./text-prompt-assistant";

const MAX_REFERENCE_NODES = 32;
const MAX_VISIBLE_CANDIDATES = MAX_REFERENCE_NODES;
const MAX_PROMPT_LENGTH = 8_000;

type ActiveMention = {
  start: number;
  end: number;
  query: string;
};

type PromptSelection = {
  start: number;
  end: number;
};

type PendingPromptSelection = PromptSelection & {
  focus: boolean;
};

type ReferenceCandidate = {
  node: WeftcanvasNode;
  ordinal: number;
  sourceLabel: string;
  label: string;
  searchText: string;
};

type NodePromptComposerProps = {
  nodeId: string;
  data: CanvasNodeData;
  dragging?: boolean;
};

export const NodePromptComposer = memo(function NodePromptComposer({
  nodeId,
  data,
  dragging = false,
}: NodePromptComposerProps) {
  const { nodes, edges } = useCanvasStore(selectCanvasContentGraph);
  const { updateNodeData, disconnectNodes, beginTransaction, commitTransaction } =
    useCanvasStore.getState();
  const shellRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const renderedEditorChildrenRef = useRef<ChildNode[]>([]);
  const lastSelectionRef = useRef({ start: data.body.length, end: data.body.length });
  const pendingSelectionRef = useRef<PendingPromptSelection | null>(null);
  const composingRef = useRef(false);
  const legacyMigrationAttemptedRef = useRef(false);
  const optionRefs = useRef(new Map<string, HTMLButtonElement>());
  const submitButtonRef = useRef<HTMLButtonElement>(null);
  const buttonTriggerStartRef = useRef<number | null>(null);
  const buttonTriggerInsertionStartRef = useRef<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [mention, setMention] = useState<ActiveMention | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  /**
   * 输入框摆到节点上方时，节点功能栏让到下面去——用户：「输入框在上面的时候，
   * 节点上方的功能栏会被挡住，此时应该功能栏到下面去」。方位由覆层布局算出来，
   * 输入框是唯一知道结果的一方，所以由它上报给外壳 store，节点里的功能栏读同一份
   * 状态。卸载时只清自己写的那一份。
   */
  const publishOverlayPlacement = useCallback(
    (placement: "above" | "below") => {
      useUiShellStore.getState().setPromptAboveNodeId(placement === "above" ? nodeId : null);
    },
    [nodeId],
  );
  useNodeOverlayPosition(nodeId, shellRef, publishOverlayPlacement);
  useEffect(
    () => () => {
      const shell = useUiShellStore.getState();
      if (shell.promptAboveNodeId === nodeId) shell.setPromptAboveNodeId(null);
    },
    [nodeId],
  );

  /**
   * 输入框打开时，伙伴趴到它的右上角（用户：「输入框点开的时候是挂在输入框上」
   * 「挂输入框右上角就行」）；输入框关掉后回到原来的位置——默认就是天上飘着，
   * 她不再挂节点。
   *
   * 只接管「本来没有别的位置」的情况（默认位，或上一次的输入框位）：用户手动把
   * 她拖到某个面板 / 某个自由位置时，这里不抢。卸载时也只清掉自己写的那一份。
   */
  useEffect(() => {
    const isInputDock = (anchor: CompanionAnchor | null) =>
      anchor?.kind === "dock" && anchor.dock === "node-prompt";
    const store = useUiPreferencesStore.getState();
    const before = store.companionAnchor;
    if (before && !isInputDock(before)) return;
    store.setCompanionAnchor({
      kind: "dock",
      dock: "node-prompt",
      x: DOCK_RIGHT_CORNER_X,
    });
    return () => {
      const current = useUiPreferencesStore.getState().companionAnchor;
      if (isInputDock(current)) useUiPreferencesStore.getState().setCompanionAnchor(before);
    };
  }, []);

  const candidates = useMemo(
    () => collectMediaCandidates(nodeId, nodes, edges),
    [edges, nodeId, nodes],
  );
  const upstreamTextContent = useMemo(
    () => (data.kind === "text" ? [] : collectUpstreamTextContent(nodeId, nodes, edges)),
    [data.kind, edges, nodeId, nodes],
  );
  const promptPlaceholder = upstreamTextContent.length
    ? `已连接 ${upstreamTextContent.length} 条文本，生成时自动使用`
    : data.kind === "audio"
      ? "描述音乐风格与情绪，或写下要说的话"
      : "描述想生成的内容";
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const candidateById = useMemo(
    () => new Map(candidates.map((candidate) => [candidate.node.id, candidate])),
    [candidates],
  );
  const selectedCandidates = useMemo(
    () => data.generation.referenceNodeIds.flatMap((id) => candidateById.get(id) ?? []),
    [candidateById, data.generation.referenceNodeIds],
  );
  const mentionNodeIds = useMemo(
    () => generationReferenceMentionNodeIds(nodeId, data.generation.referenceNodeIds, nodes),
    [data.generation.referenceNodeIds, nodeId, nodes],
  );
  const selectedMentions = useMemo(
    () => createReferenceMentionMap(mentionNodeIds, nodes),
    [mentionNodeIds, nodes],
  );
  const promptReferenceRanges = useMemo(
    () => findPromptReferenceRanges(data.body, mentionNodeIds, nodes),
    [data.body, mentionNodeIds, nodes],
  );
  const filteredCandidates = useMemo(() => {
    const query = (mention?.query ?? "").trim().toLocaleLowerCase("zh-CN");
    const matches = query
      ? candidates.filter((candidate) => candidate.searchText.includes(query))
      : candidates;
    return matches.slice(0, MAX_VISIBLE_CANDIDATES);
  }, [candidates, mention?.query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query, pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    const candidate = filteredCandidates[activeIndex];
    if (candidate) optionRefs.current.get(candidate.node.id)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filteredCandidates, pickerOpen]);

  useLayoutEffect(() => {
    if (composingRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    renderedEditorChildrenRef.current = Array.from(editor.childNodes);
    const pending = pendingSelectionRef.current;
    if (!pending) return;
    if (pending.focus) editor.focus({ preventScroll: true });
    restorePromptSelection(editor, pending);
    // React can restore its pre-commit DOM selection after layout effects; repeat before paint.
    window.queueMicrotask(() => {
      if (pendingSelectionRef.current !== pending || editorRef.current !== editor) return;
      if (pending.focus) editor.focus({ preventScroll: true });
      restorePromptSelection(editor, pending);
      pendingSelectionRef.current = null;
    });
  }, [data.body, data.generation.referenceNodeIds]);

  useEffect(() => {
    const allowedIds = new Set(candidates.map((candidate) => candidate.node.id));
    const previousNodeIds = data.generation.referenceNodeIds;
    const previousMentionIds = generationReferenceMentionNodeIds(nodeId, previousNodeIds, nodes);
    let referenceNodeIds = previousNodeIds.filter((id) => allowedIds.has(id));
    const explicit = data.generation.referenceMode === "explicit";
    let body = data.body;

    if (!legacyMigrationAttemptedRef.current) {
      legacyMigrationAttemptedRef.current = true;
      body = ensurePromptReferenceMentions(body, referenceNodeIds, previousMentionIds, nodes);
    }

    let currentMentionIds = previousMentionIds;
    if (!sameIds(referenceNodeIds, previousNodeIds)) {
      const nextMentionIds = generationReferenceMentionNodeIds(nodeId, referenceNodeIds, nodes);
      body = stripUnboundReferenceMentions(
        reconcileReferenceMentions(body, currentMentionIds, nextMentionIds, nodes),
        nextMentionIds,
        nodes,
      );
      currentMentionIds = nextMentionIds;
    }

    const presentIds = new Set(referenceIdsPresentInBody(body, currentMentionIds, nodes));
    const boundReferenceNodeIds = referenceNodeIds.filter((id) => presentIds.has(id));
    if (!sameIds(boundReferenceNodeIds, referenceNodeIds)) {
      const nextMentionIds = generationReferenceMentionNodeIds(
        nodeId,
        boundReferenceNodeIds,
        nodes,
      );
      body = stripUnboundReferenceMentions(
        reconcileReferenceMentions(body, currentMentionIds, nextMentionIds, nodes),
        nextMentionIds,
        nodes,
      );
      referenceNodeIds = boundReferenceNodeIds;
    }

    if (sameIds(referenceNodeIds, previousNodeIds) && body === data.body) return;
    updateNodeData(
      nodeId,
      {
        body,
        generation: {
          ...data.generation,
          referenceMode: explicit ? "explicit" : "auto",
          referenceNodeIds,
          error: null,
        },
      },
      false,
    );
  }, [
    candidates,
    data.body,
    data.generation,
    data.generation.referenceNodeIds,
    nodeId,
    nodes,
    updateNodeData,
  ]);

  const persistPromptChange = (rawBody: string, requestedSelection: PromptSelection) => {
    const state = useCanvasStore.getState();
    const current = state.nodes.find((node) => node.id === nodeId);
    if (!current) return;
    const previousNodeIds = current.data.generation.referenceNodeIds;
    const previousMentionIds = generationReferenceMentionNodeIds(
      nodeId,
      previousNodeIds,
      state.nodes,
    );
    let body = rawBody.slice(0, MAX_PROMPT_LENGTH);
    const presentIds = new Set(referenceIdsPresentInBody(body, previousMentionIds, state.nodes));
    const referenceNodeIds = previousNodeIds.filter((id) => presentIds.has(id));
    if (!sameIds(referenceNodeIds, previousNodeIds)) {
      const nextMentionIds = generationReferenceMentionNodeIds(
        nodeId,
        referenceNodeIds,
        state.nodes,
      );
      body = reconcileReferenceMentions(body, previousMentionIds, nextMentionIds, state.nodes);
    }
    const selection = {
      start: Math.min(requestedSelection.start, body.length),
      end: Math.min(requestedSelection.end, body.length),
    };
    pendingSelectionRef.current = {
      ...selection,
      focus: document.activeElement === editorRef.current,
    };
    state.updateNodeData(
      nodeId,
      {
        body,
        ...(sameIds(referenceNodeIds, previousNodeIds)
          ? {}
          : {
              generation: {
                ...current.data.generation,
                referenceMode: "explicit" as const,
                referenceNodeIds,
                error: null,
              },
            }),
      },
      false,
    );
    lastSelectionRef.current = selection;
    const activeMention = findActiveMention(
      body,
      selection.end,
      findPromptReferenceRanges(
        body,
        generationReferenceMentionNodeIds(nodeId, referenceNodeIds, state.nodes),
        state.nodes,
      ),
    );
    setMention(activeMention);
    if (activeMention) {
      setPickerOpen(true);
    } else {
      setPickerOpen(false);
      buttonTriggerStartRef.current = null;
      buttonTriggerInsertionStartRef.current = null;
    }
  };

  const chooseReference = (candidate: ReferenceCandidate) => {
    const state = useCanvasStore.getState();
    const current = state.nodes.find((node) => node.id === nodeId);
    if (!current) return;
    const alreadySelected = current.data.generation.referenceNodeIds.includes(candidate.node.id);
    if (!alreadySelected && current.data.generation.referenceNodeIds.length >= MAX_REFERENCE_NODES)
      return;
    const referenceNodeIds = alreadySelected
      ? current.data.generation.referenceNodeIds
      : [...current.data.generation.referenceNodeIds, candidate.node.id];
    const mentionIds = generationReferenceMentionNodeIds(nodeId, referenceNodeIds, state.nodes);
    const mentionLabel = createReferenceMentionMap(mentionIds, state.nodes).get(candidate.node.id);
    if (!mentionLabel) return;
    const promptUpdate = replaceActiveMention(
      current.data.body,
      mention,
      lastSelectionRef.current,
      buttonTriggerStartRef.current === mention?.start
        ? buttonTriggerInsertionStartRef.current
        : null,
      `@${mentionLabel}`,
    );
    pendingSelectionRef.current = {
      start: promptUpdate.caret,
      end: promptUpdate.caret,
      focus: true,
    };
    state.updateNodeData(
      nodeId,
      {
        body: promptUpdate.body,
        generation: {
          ...current.data.generation,
          referenceMode: "explicit",
          referenceNodeIds,
          error: null,
        },
      },
      false,
    );
    setPickerOpen(false);
    setMention(null);
    buttonTriggerStartRef.current = null;
    buttonTriggerInsertionStartRef.current = null;
    lastSelectionRef.current = { start: promptUpdate.caret, end: promptUpdate.caret };
  };

  const removeReference = (referenceNodeId: string) => {
    const state = useCanvasStore.getState();
    const current = state.nodes.find((node) => node.id === nodeId);
    if (!current) return;
    const referenceNodeIds = current.data.generation.referenceNodeIds.filter(
      (id) => id !== referenceNodeId,
    );
    const currentMentionIds = generationReferenceMentionNodeIds(
      nodeId,
      current.data.generation.referenceNodeIds,
      state.nodes,
    );
    const nextMentionIds = generationReferenceMentionNodeIds(nodeId, referenceNodeIds, state.nodes);
    const removedRange = findPromptReferenceRanges(
      current.data.body,
      currentMentionIds,
      state.nodes,
    ).find((range) => range.nodeId === referenceNodeId);
    const body = stripUnboundReferenceMentions(
      reconcileReferenceMentions(current.data.body, currentMentionIds, nextMentionIds, state.nodes),
      nextMentionIds,
      state.nodes,
    );
    const caret = Math.min(removedRange?.start ?? lastSelectionRef.current.start, body.length);
    lastSelectionRef.current = { start: caret, end: caret };
    pendingSelectionRef.current = { start: caret, end: caret, focus: true };
    updateNodeData(nodeId, {
      body,
      generation: {
        ...current.data.generation,
        referenceMode: "explicit",
        referenceNodeIds,
        error: null,
      },
    });
  };

  const disconnectReference = (referenceNodeId: string) => {
    disconnectNodes(referenceNodeId, nodeId);
  };

  const closeReferencePicker = (removeEmptyButtonTrigger: boolean) => {
    const current = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    const triggerStart = buttonTriggerStartRef.current;
    const insertionStart = buttonTriggerInsertionStartRef.current;
    if (
      removeEmptyButtonTrigger &&
      current &&
      mention &&
      mention.query === "" &&
      triggerStart === mention.start
    ) {
      const removalStart = insertionStart ?? mention.start;
      const body = `${current.data.body.slice(0, removalStart)}${current.data.body.slice(mention.end)}`;
      lastSelectionRef.current = { start: removalStart, end: removalStart };
      pendingSelectionRef.current = { start: removalStart, end: removalStart, focus: true };
      updateNodeData(nodeId, { body }, false);
    }
    buttonTriggerStartRef.current = null;
    buttonTriggerInsertionStartRef.current = null;
    setPickerOpen(false);
    setMention(null);
  };

  const openReferencePicker = () => {
    const editor = editorRef.current;
    const current = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    if (!editor || !current) return;
    if (pickerOpen) {
      closeReferencePicker(true);
      return;
    }
    const remembered = lastSelectionRef.current;
    const selectionStart = Math.min(remembered.start, current.data.body.length);
    const selectionEnd = Math.min(remembered.end, current.data.body.length);
    const before = current.data.body.slice(0, selectionStart);
    const after = current.data.body.slice(selectionEnd);
    const prefix = before && !/\s$/u.test(before) ? " @" : "@";
    const start = before.length + prefix.length - 1;
    const body = `${before}${prefix}${after}`;
    pendingSelectionRef.current = { start: start + 1, end: start + 1, focus: true };
    updateNodeData(nodeId, { body }, false);
    buttonTriggerStartRef.current = start;
    buttonTriggerInsertionStartRef.current = before.length;
    setMention({ start, end: start + 1, query: "" });
    setPickerOpen(true);
    setActiveIndex(0);
    lastSelectionRef.current = { start: start + 1, end: start + 1 };
  };

  const syncMentionFromCaret = (allowStartReset = false) => {
    const editor = editorRef.current;
    if (!editor) return;
    if (pendingSelectionRef.current) return;
    const selection = readPromptSelection(editor);
    if (!selection) return;
    if (
      !allowStartReset &&
      selection.start === 0 &&
      selection.end === 0 &&
      (lastSelectionRef.current.start > 0 || lastSelectionRef.current.end > 0)
    )
      return;
    const body = serializePromptEditor(editor);
    lastSelectionRef.current = selection;
    const activeMention = findActiveMention(
      body,
      selection.end,
      findPromptReferenceRanges(body, mentionNodeIds, nodes),
    );
    if (activeMention?.start !== buttonTriggerStartRef.current) {
      buttonTriggerStartRef.current = null;
      buttonTriggerInsertionStartRef.current = null;
    }
    setMention(activeMention);
    setPickerOpen(Boolean(activeMention));
  };

  const deleteReferenceFromEditor = (direction: "backward" | "forward") => {
    const editor = editorRef.current;
    const state = useCanvasStore.getState();
    const current = state.nodes.find((node) => node.id === nodeId);
    if (!editor || !current) return false;
    const selection = readPromptSelection(editor);
    if (!selection) return false;
    const currentMentionIds = generationReferenceMentionNodeIds(
      nodeId,
      current.data.generation.referenceNodeIds,
      state.nodes,
    );
    const deletion = deletePromptReferenceAtSelection(
      current.data.body,
      selection.start,
      selection.end,
      currentMentionIds,
      state.nodes,
      direction,
    );
    if (!deletion) return false;
    persistPromptChange(deletion.body, { start: deletion.caret, end: deletion.caret });
    return true;
  };

  const insertPromptText = (text: string) => {
    const editor = editorRef.current;
    const current = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    if (!editor || !current) return;
    const liveSelection = readPromptSelection(editor);
    const rememberedSelection = lastSelectionRef.current;
    const selection =
      liveSelection &&
      current.data.body.length > 0 &&
      liveSelection.start === 0 &&
      liveSelection.end === 0 &&
      (rememberedSelection.start > 0 || rememberedSelection.end > 0)
        ? rememberedSelection
        : (liveSelection ?? rememberedSelection);
    const normalized = text.replace(/\r\n?/gu, "\n");
    const available = Math.max(
      0,
      MAX_PROMPT_LENGTH - (current.data.body.length - (selection.end - selection.start)),
    );
    const inserted = normalized.slice(0, available);
    const body = `${current.data.body.slice(0, selection.start)}${inserted}${current.data.body.slice(selection.end)}`;
    const caret = selection.start + inserted.length;
    persistPromptChange(body, { start: caret, end: caret });
  };

  const deletePromptText = (direction: "backward" | "forward") => {
    if (deleteReferenceFromEditor(direction)) return;
    const editor = editorRef.current;
    const current = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    if (!editor || !current) return;
    const selection = readPromptSelection(editor) ?? lastSelectionRef.current;
    let start = selection.start;
    let end = selection.end;
    if (start === end) {
      if (direction === "backward") start = previousGraphemeOffset(current.data.body, start);
      else end = nextGraphemeOffset(current.data.body, end);
    }
    if (start === end) return;
    const body = `${current.data.body.slice(0, start)}${current.data.body.slice(end)}`;
    persistPromptChange(body, { start, end: start });
  };

  const handleInput = (event?: FormEvent<HTMLDivElement>) => {
    if (composingRef.current) return;
    const editor = editorRef.current;
    if (!editor) return;
    const body = serializePromptEditor(editor);
    const inputEvent = event?.nativeEvent as InputEvent | undefined;
    const liveSelection = readPromptSelection(editor);
    const replacedWholeBody = inputEvent?.inputType === "insertText" && inputEvent.data === body;
    const selection = replacedWholeBody
      ? { start: body.length, end: body.length }
      : (liveSelection ?? { start: body.length, end: body.length });
    restoreRenderedPromptChildren(editor, renderedEditorChildrenRef.current);
    persistPromptChange(body, selection);
  };

  const handleBeforeInput = (event: InputEvent) => {
    if (composingRef.current) return;
    const inputType = event.inputType;
    if (inputType === "insertText" || inputType === "insertReplacementText") {
      event.preventDefault();
      insertPromptText(event.data ?? "");
      return;
    }
    if (inputType === "deleteContentBackward" || inputType === "deleteContentForward") {
      event.preventDefault();
      deletePromptText(inputType === "deleteContentBackward" ? "backward" : "forward");
      return;
    }
    if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
      event.preventDefault();
      insertPromptText("\n");
    }
  };

  // React 19 的合成 onBeforeInput 不携带 inputType（实测恒为 undefined），上面
  // 的分支在合成路径下永远不会命中：原生插入绕过 store 驱动的路径，DOM 与光标
  // 各走各路，Enter 后光标被重序列化读回换行符之前（下一个字符插到上一行）。
  // 改绑原生 beforeinput（可 preventDefault），让所有输入都走 store 驱动的路径。
  const nativeBeforeInputRef = useRef<(event: InputEvent) => void>(() => {});
  nativeBeforeInputRef.current = handleBeforeInput;
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const listener = (event: Event) => nativeBeforeInputRef.current(event as InputEvent);
    editor.addEventListener("beforeinput", listener);
    return () => editor.removeEventListener("beforeinput", listener);
  }, []);

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (Array.from(event.clipboardData.items).some((item) => item.kind === "file")) return;
    insertPromptText(event.clipboardData.getData("text/plain"));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    const command = event.ctrlKey || event.metaKey;
    const key = event.key.toLocaleLowerCase("en-US");
    if (command && (key === "z" || key === "y")) {
      event.preventDefault();
      commitTransaction();
      const state = useCanvasStore.getState();
      if (key === "y" || (key === "z" && event.shiftKey)) state.redo();
      else state.undo();
      const restored = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
      const caret = Math.min(lastSelectionRef.current.start, restored?.data.body.length ?? 0);
      lastSelectionRef.current = { start: caret, end: caret };
      pendingSelectionRef.current = { start: caret, end: caret, focus: true };
      setMention(null);
      setPickerOpen(false);
      beginTransaction();
      return;
    }
    if (event.key === "@") {
      event.preventDefault();
      insertPromptText("@");
      return;
    }
    if (pickerOpen) {
      if (event.key === "ArrowDown" && filteredCandidates.length) {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % filteredCandidates.length);
        return;
      }
      if (event.key === "ArrowUp" && filteredCandidates.length) {
        event.preventDefault();
        setActiveIndex(
          (index) => (index - 1 + filteredCandidates.length) % filteredCandidates.length,
        );
        return;
      }
      if ((event.key === "Enter" || event.key === "Tab") && filteredCandidates[activeIndex]) {
        event.preventDefault();
        chooseReference(filteredCandidates[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeReferencePicker(true);
        return;
      }
    }
    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      deleteReferenceFromEditor(event.key === "Backspace" ? "backward" : "forward")
    ) {
      event.preventDefault();
      return;
    }
    if (data.kind !== "text" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitButtonRef.current?.click();
    }
  };

  return createPortal(
    <div
      ref={shellRef}
      className={`wc-node-prompt-shell ${data.kind === "text" ? "" : "wc-node-prompt-shell--generation"} ${dragging ? "is-node-dragging" : ""}`}
      data-node-prompt-composer
      role="region"
      aria-label={`${nodeLabel(data.kind)}编辑器`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="wc-node-prompt-composer nodrag nowheel nopan">
        {candidates.length ? (
          <div className="wc-node-reference-chips" aria-label="已连接素材">
            <div className="wc-node-reference-chips-header">
              <span>已连接素材</span>
              <small>
                {selectedCandidates.length}/{candidates.length} 已引用
              </small>
            </div>
            <div className="wc-node-reference-chips-track">
              {candidates.map((candidate) => {
                const selected = data.generation.referenceNodeIds.includes(candidate.node.id);
                const mentionLabel =
                  selectedMentions.get(candidate.node.id) ?? candidate.sourceLabel;
                return (
                  <div
                    key={candidate.node.id}
                    className={`wc-node-reference-chip ${selected ? "is-selected" : ""}`}
                  >
                    <button
                      type="button"
                      className="wc-node-reference-choice"
                      aria-pressed={selected}
                      aria-label={
                        selected ? `已引用素材 ${candidate.label}` : `引用素材 ${candidate.label}`
                      }
                      title={`${selected ? `@${mentionLabel}` : "单击引用"} · ${candidate.label}`}
                      onClick={() => chooseReference(candidate)}
                    >
                      <ReferenceThumbnail node={candidate.node} />
                      <span>
                        <b>{selected ? `@${mentionLabel}` : candidate.sourceLabel}</b>
                        <small>{candidate.label}</small>
                      </span>
                      {selected ? (
                        <Check className="wc-node-reference-selected" aria-hidden="true" />
                      ) : null}
                    </button>
                    <button
                      type="button"
                      className="wc-node-reference-remove"
                      aria-label={`取消素材链接 ${candidate.label}`}
                      title={`取消素材链接 ${candidate.label}`}
                      onKeyDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        disconnectReference(candidate.node.id);
                      }}
                    >
                      <X aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="wc-node-prompt-row">
          <div
            ref={editorRef}
            className="wc-node-prompt-editor"
            data-prompt-editor
            data-placeholder={promptPlaceholder}
            contentEditable
            suppressContentEditableWarning
            role="textbox"
            aria-label={`${nodeLabel(data.kind)}提示词`}
            aria-multiline="true"
            aria-placeholder={promptPlaceholder}
            spellCheck
            onFocus={() => {
              beginTransaction();
              syncMentionFromCaret(false);
            }}
            onBlur={() => {
              if (composingRef.current) {
                composingRef.current = false;
                handleInput();
              }
              commitTransaction();
            }}
            onInput={handleInput}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              window.queueMicrotask(() => {
                if (!composingRef.current) return;
                composingRef.current = false;
                handleInput();
              });
            }}
            onClick={() => syncMentionFromCaret(true)}
            onSelect={() => syncMentionFromCaret(false)}
            onKeyUp={() => syncMentionFromCaret(true)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onDrop={(event) => event.preventDefault()}
            aria-activedescendant={
              pickerOpen && filteredCandidates[activeIndex]
                ? referenceOptionId(filteredCandidates[activeIndex].node.id)
                : undefined
            }
          >
            {renderPromptEditorContent(
              data.body,
              promptReferenceRanges,
              nodeById,
              candidateById,
              removeReference,
            )}
          </div>
        </div>

        {data.kind === "text" ? (
          <div className="wc-generation-compact-bar wc-node-text-reference-bar">
            <div className="wc-generation-leading-control">
              <button
                type="button"
                className={`wc-node-reference-trigger ${pickerOpen ? "is-active" : ""}`}
                aria-label="引用画布素材"
                title="引用画布素材"
                aria-expanded={pickerOpen}
                onClick={openReferencePicker}
              >
                <AtSign aria-hidden="true" />
              </button>
            </div>
            <TextPromptAssistant nodeId={nodeId} data={data} />
          </div>
        ) : null}

        {pickerOpen ? (
          <div className="wc-node-reference-picker" role="listbox" aria-label="选择参考素材">
            <div className="wc-node-reference-picker-header">
              <strong>{mention?.query ? `匹配“${mention.query}”` : "选择已连接素材"}</strong>
              <span>
                {filteredCandidates.length}/{candidates.length}
              </span>
            </div>
            {filteredCandidates.length ? (
              <div className="wc-node-reference-options">
                {filteredCandidates.map((candidate, index) => {
                  const selected = data.generation.referenceNodeIds.includes(candidate.node.id);
                  const selectedOfKind = selectedCandidates.filter(
                    (item) => item.node.data.kind === candidate.node.data.kind,
                  ).length;
                  const mentionLabel =
                    selectedMentions.get(candidate.node.id) ??
                    `${referenceKindLabel(candidate.node.data.kind)}${selectedOfKind + 1}`;
                  return (
                    <button
                      id={referenceOptionId(candidate.node.id)}
                      ref={(element) => {
                        if (element) optionRefs.current.set(candidate.node.id, element);
                        else optionRefs.current.delete(candidate.node.id);
                      }}
                      key={candidate.node.id}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      aria-label={`引用参考素材 ${candidate.label}`}
                      className={index === activeIndex ? "is-active" : undefined}
                      disabled={
                        !selected && data.generation.referenceNodeIds.length >= MAX_REFERENCE_NODES
                      }
                      title={`@${mentionLabel} · ${candidate.label}`}
                      onPointerDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => chooseReference(candidate)}
                    >
                      <ReferenceThumbnail node={candidate.node} />
                      <span>
                        <b>@{mentionLabel}</b>
                        <small>{candidate.label}</small>
                      </span>
                      {selected ? <Check aria-hidden="true" /> : <Plus aria-hidden="true" />}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="wc-node-reference-empty">
                <ImageIcon aria-hidden="true" />
                <span>{candidates.length ? "没有匹配的参考素材" : "请先连接含媒体的上游节点"}</span>
              </div>
            )}
          </div>
        ) : null}
        {data.kind !== "text" ? (
          <NodeGenerationPanel
            nodeId={nodeId}
            data={data}
            presentation="embedded"
            submitButtonRef={submitButtonRef}
            leadingControl={
              <button
                type="button"
                className={`wc-node-reference-trigger ${pickerOpen ? "is-active" : ""}`}
                aria-label="引用画布素材"
                title="引用画布素材"
                aria-expanded={pickerOpen}
                onClick={openReferencePicker}
              >
                <AtSign aria-hidden="true" />
              </button>
            }
            onClose={() => undefined}
          />
        ) : null}
      </div>
    </div>,
    document.body,
  );
});

function renderPromptEditorContent(
  body: string,
  ranges: readonly { nodeId: string; start: number; end: number }[],
  nodeById: ReadonlyMap<string, WeftcanvasNode>,
  candidateById: ReadonlyMap<string, ReferenceCandidate>,
  onRemove: (nodeId: string) => void,
) {
  const content: ReactNode[] = [];
  const occurrences = new Map<string, number>();
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    if (range.start > cursor) content.push(body.slice(cursor, range.start));
    const node = nodeById.get(range.nodeId);
    const token = body.slice(range.start, range.end);
    if (!node) {
      content.push(token);
    } else {
      const occurrence = occurrences.get(range.nodeId) ?? 0;
      occurrences.set(range.nodeId, occurrence + 1);
      const label =
        candidateById.get(range.nodeId)?.label ||
        node.data.body.trim() ||
        node.data.media?.name ||
        referenceKindLabel(node.data.kind);
      content.push(
        <span
          key={`${range.nodeId}-${occurrence}`}
          className="wc-node-reference-token"
          data-reference-token={token}
          data-reference-node-id={range.nodeId}
          contentEditable={false}
          role="group"
          aria-label={`参考素材 ${token}`}
          title={`${token} · ${label}`}
        >
          <ReferenceThumbnail node={node} />
          <span className="wc-node-reference-token-label">{token}</span>
          <button
            type="button"
            tabIndex={-1}
            contentEditable={false}
            aria-label={`移除参考素材 ${label}`}
            title={`移除 ${label}`}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onClick={(event) => {
              event.stopPropagation();
              onRemove(range.nodeId);
            }}
          >
            <X aria-hidden="true" />
          </button>
        </span>,
      );
    }
    cursor = range.end;
  }
  if (cursor < body.length) content.push(body.slice(cursor));
  return content;
}

function ReferenceThumbnail({ node }: { node: WeftcanvasNode }) {
  const { url } = useMediaUrl(node.data.media);
  const [previewPosition, setPreviewPosition] = useState<{ left: number; top: number } | null>(
    null,
  );
  const thumbnailRef = useRef<HTMLElement>(null);
  const updatePreviewPosition = useCallback(() => {
    const thumbnail = thumbnailRef.current;
    if (!thumbnail || !url) return;
    const rect = thumbnail.getBoundingClientRect();
    if (
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth
    ) {
      setPreviewPosition(null);
      return;
    }
    const width = Math.min(280, window.innerWidth - 24);
    const height = 196;
    const left = Math.max(
      12,
      Math.min(window.innerWidth - width - 12, rect.left + rect.width / 2 - width / 2),
    );
    const top =
      rect.top - height - 10 >= 12
        ? rect.top - height - 10
        : Math.min(window.innerHeight - height - 12, rect.bottom + 10);
    const next = { left, top: Math.max(12, top) };
    setPreviewPosition((current) =>
      current?.left === next.left && current.top === next.top ? current : next,
    );
  }, [url]);
  const previewOpen = previewPosition !== null;
  useLayoutEffect(() => {
    if (!previewOpen) return;
    window.addEventListener("resize", updatePreviewPosition);
    window.addEventListener("scroll", updatePreviewPosition, true);
    return () => {
      window.removeEventListener("resize", updatePreviewPosition);
      window.removeEventListener("scroll", updatePreviewPosition, true);
    };
  }, [previewOpen, updatePreviewPosition]);
  return (
    <>
      <i
        ref={thumbnailRef}
        className="wc-node-reference-thumbnail"
        aria-hidden="true"
        onPointerEnter={updatePreviewPosition}
        onPointerLeave={() => setPreviewPosition(null)}
      >
        {node.data.kind === "image" && url ? (
          <img src={url} alt="" draggable={false} loading="lazy" />
        ) : null}
        {node.data.kind === "video" ? <Video /> : null}
        {node.data.kind === "audio" ? <Music2 /> : null}
        {!isReferenceKind(node.data.kind) || (node.data.kind === "image" && !url) ? (
          <ImageIcon />
        ) : null}
      </i>
      {previewPosition && url
        ? createPortal(
            <div
              className={`wc-node-reference-preview is-${node.data.kind}`}
              data-reference-preview
              style={{ left: previewPosition.left, top: previewPosition.top }}
              role="tooltip"
            >
              <div className="wc-node-reference-preview-media">
                {node.data.kind === "image" ? (
                  <img src={url} alt={node.data.media?.name ?? "参考图片"} draggable={false} />
                ) : null}
                {node.data.kind === "video" ? (
                  <video src={url} muted autoPlay loop playsInline preload="metadata" />
                ) : null}
                {node.data.kind === "audio" ? <Music2 aria-hidden="true" /> : null}
              </div>
              <span>
                {node.data.body.trim() ||
                  node.data.media?.name ||
                  `${referenceKindLabel(node.data.kind)}素材`}
              </span>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function collectMediaCandidates(
  nodeId: string,
  nodes: WeftcanvasNode[],
  edges: WeftcanvasEdge[],
): ReferenceCandidate[] {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const target = nodesById.get(nodeId);
  const directIncomingNodeIds = indexIncomingNodeIds(edges).get(nodeId) ?? [];
  const connectedMedia: WeftcanvasNode[] = [];

  for (const currentId of directIncomingNodeIds) {
    const node = nodesById.get(currentId);
    if (node?.data.media && isReferenceKind(node.data.kind)) {
      connectedMedia.push(node);
    }
  }

  const ordinals = { image: 0, video: 0, audio: 0 };
  if (target?.data.media && isReferenceKind(target.data.kind)) ordinals[target.data.kind] = 1;
  return connectedMedia.map((node) => {
    if (!isReferenceKind(node.data.kind)) throw new Error("Unsupported reference kind");
    ordinals[node.data.kind] += 1;
    const ordinal = ordinals[node.data.kind];
    const kindLabel = referenceKindLabel(node.data.kind);
    const label = node.data.body.trim() || node.data.media?.name || `${kindLabel} ${ordinal}`;
    return {
      node,
      ordinal,
      sourceLabel: `${kindLabel}${ordinal}`,
      label,
      searchText:
        `${kindLabel}${ordinal} ${kindLabel} ${label} ${node.data.media?.name ?? ""}`.toLocaleLowerCase(
          "zh-CN",
        ),
    };
  });
}

function findActiveMention(
  value: string,
  caret: number,
  referenceRanges: readonly { start: number; end: number }[] = [],
): ActiveMention | null {
  if (referenceRanges.some((range) => caret > range.start && caret <= range.end)) return null;
  const beforeCaret = value.slice(0, caret);
  const match = beforeCaret.match(/(^|[^A-Za-z0-9_@])@([^\s@]*)$/u);
  if (!match || match.index === undefined) return null;
  const start = match.index + (match[1] ?? "").length;
  return { start, end: caret, query: match[2] ?? "" };
}

function replaceActiveMention(
  body: string,
  mention: ActiveMention | null,
  selection: PromptSelection,
  insertionStart: number | null,
  replacement: string,
) {
  const start = mention
    ? (insertionStart ?? mention.start)
    : Math.min(selection.start, selection.end, body.length);
  const end = mention
    ? mention.end
    : Math.min(Math.max(selection.start, selection.end), body.length);
  const insertedPrefix = mention ? body.slice(start, mention.start) : "";
  let before = `${body.slice(0, start)}${insertedPrefix}`;
  let after = body.slice(end);
  if (!mention && before && !/\s$/u.test(before)) before += " ";
  const needsTrailingSpace = !after || !/^[\s，。！？；：、,.!?;:)}\]]/u.test(after);
  const inserted = `${before}${replacement}${needsTrailingSpace ? " " : ""}`;
  if (/\s$/u.test(inserted) && /^\s/u.test(after)) after = after.replace(/^\s+/u, "");
  return { body: `${inserted}${after}`, caret: inserted.length };
}

function referenceOptionId(nodeId: string) {
  return `wc-reference-option-${nodeId}`;
}

function serializePromptEditor(root: ParentNode) {
  const children = Array.from(root.childNodes);
  if (children.length === 1 && children[0] instanceof HTMLBRElement) return "";
  return children.map(serializePromptNode).join("").replace(/\r/gu, "");
}

function serializePromptNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\u00a0/gu, " ");
  if (!(node instanceof Element)) return "";
  const referenceToken = node.getAttribute("data-reference-token");
  if (referenceToken !== null) return referenceToken;
  if (node.tagName === "BR") return "\n";
  const content = Array.from(node.childNodes).map(serializePromptNode).join("");
  return /^(DIV|P|LI)$/u.test(node.tagName) && node.nextSibling && !content.endsWith("\n")
    ? `${content}\n`
    : content;
}

/**
 * Some browser and IME insertion paths mutate a contenteditable before React
 * can prevent the edit. Restore the nodes from the previous React commit before
 * publishing the new value so React can reconcile them without duplicates or a
 * removeChild failure; the numeric selection is restored after the commit.
 */
function restoreRenderedPromptChildren(root: HTMLElement, renderedChildren: readonly ChildNode[]) {
  const liveChildren = Array.from(root.childNodes);
  if (
    liveChildren.length === renderedChildren.length &&
    liveChildren.every((child, index) => child === renderedChildren[index])
  )
    return;
  root.replaceChildren(...renderedChildren);
}

function readPromptSelection(root: HTMLElement): PromptSelection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const beforeStart = document.createRange();
  beforeStart.setStart(root, 0);
  beforeStart.setEnd(range.startContainer, range.startOffset);
  const beforeEnd = document.createRange();
  beforeEnd.setStart(root, 0);
  beforeEnd.setEnd(range.endContainer, range.endOffset);
  return {
    start: serializePromptEditor(beforeStart.cloneContents()).length,
    end: serializePromptEditor(beforeEnd.cloneContents()).length,
  };
}

function restorePromptSelection(root: HTMLElement, selection: PromptSelection) {
  const browserSelection = window.getSelection();
  if (!browserSelection) return;
  const start = resolvePromptDomPoint(root, selection.start);
  const end = resolvePromptDomPoint(root, selection.end);
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  browserSelection.removeAllRanges();
  browserSelection.addRange(range);
}

function resolvePromptDomPoint(
  root: HTMLElement,
  requestedOffset: number,
): { node: Node; offset: number } {
  let remaining = Math.max(0, requestedOffset);
  for (let index = 0; index < root.childNodes.length; index += 1) {
    const node = root.childNodes[index]!;
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node.textContent ?? "").length;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      continue;
    }
    if (node instanceof Element && node.hasAttribute("data-reference-token")) {
      const length = node.getAttribute("data-reference-token")?.length ?? 0;
      if (remaining === 0) return { node: root, offset: index };
      if (remaining <= length) return { node: root, offset: index + 1 };
      remaining -= length;
      continue;
    }
    const length = serializePromptNode(node).length;
    if (remaining <= length && node instanceof HTMLElement)
      return resolvePromptDomPoint(node, remaining);
    remaining -= length;
  }
  return { node: root, offset: root.childNodes.length };
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function previousGraphemeOffset(value: string, offset: number) {
  if (offset <= 0) return 0;
  if (typeof Intl.Segmenter !== "function") return offset - 1;
  let previous = 0;
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    const end = segment.index + segment.segment.length;
    if (end >= offset) return segment.index;
    previous = end;
  }
  return previous;
}

function nextGraphemeOffset(value: string, offset: number) {
  if (offset >= value.length) return value.length;
  if (typeof Intl.Segmenter !== "function") return offset + 1;
  for (const segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    const end = segment.index + segment.segment.length;
    if (end > offset) return end;
  }
  return value.length;
}
