import type { CanvasNodeKind } from "@weftcanvas/contracts";

import type { WeftcanvasEdge, WeftcanvasNode } from "../types";
import { indexIncomingNodeIds } from "./canvas-graph";

const referenceKindLabels = {
  image: "图片",
  video: "视频",
  audio: "音频",
} as const;

type ReferenceKind = keyof typeof referenceKindLabels;

export type PromptReferenceRange = {
  nodeId: string;
  start: number;
  end: number;
};

export type PromptReferenceDeletion = {
  body: string;
  caret: number;
  affectedNodeIds: string[];
};

export function isReferenceKind(kind: CanvasNodeKind): kind is ReferenceKind {
  return kind === "image" || kind === "video" || kind === "audio";
}

export function referenceKindLabel(kind: CanvasNodeKind) {
  return isReferenceKind(kind) ? referenceKindLabels[kind] : "素材";
}

export function createReferenceMentionMap(
  referenceNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const counts: Record<ReferenceKind, number> = { image: 0, video: 0, audio: 0 };
  const mentions = new Map<string, string>();
  for (const nodeId of referenceNodeIds) {
    if (mentions.has(nodeId)) continue;
    const node = byId.get(nodeId);
    if (!node?.data.media || !isReferenceKind(node.data.kind)) continue;
    counts[node.data.kind] += 1;
    mentions.set(nodeId, `${referenceKindLabels[node.data.kind]}${counts[node.data.kind]}`);
  }
  return mentions;
}

export function generationReferenceMentionNodeIds(
  nodeId: string,
  referenceNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const target = nodes.find((node) => node.id === nodeId);
  if (!target?.data.media || !isReferenceKind(target.data.kind)) return [...referenceNodeIds];
  return [nodeId, ...referenceNodeIds.filter((referenceNodeId) => referenceNodeId !== nodeId)];
}

export function referenceIdsPresentInBody(
  body: string,
  referenceNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const mentions = createReferenceMentionMap(referenceNodeIds, nodes);
  return referenceNodeIds.filter((nodeId, index) => {
    if (referenceNodeIds.indexOf(nodeId) !== index) return false;
    const mention = mentions.get(nodeId);
    return mention ? mentionPattern(mention).test(body) : false;
  });
}

export function reconcileReferenceMentions(
  body: string,
  previousNodeIds: readonly string[],
  nextNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const previousMentions = createReferenceMentionMap(previousNodeIds, nodes);
  const nextMentions = createReferenceMentionMap(nextNodeIds, nodes);
  let nextBody = body;
  const placeholders = new Map<string, string>();

  [...previousMentions.entries()]
    .sort((left, right) => right[1].length - left[1].length)
    .forEach(([nodeId, mention], index) => {
      const placeholder = `\uE000wc-ref-${index}\uE001`;
      placeholders.set(nodeId, placeholder);
      nextBody = nextBody.replace(mentionPattern(mention), placeholder);
    });

  for (const [nodeId, placeholder] of placeholders) {
    const mention = nextMentions.get(nodeId);
    nextBody = nextBody.replaceAll(placeholder, mention ? `@${mention}` : "");
  }

  return cleanReferenceWhitespace(nextBody);
}

export function stripUnboundReferenceMentions(
  body: string,
  referenceNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const allowed = new Set(
    [...createReferenceMentionMap(referenceNodeIds, nodes).values()].map((value) => `@${value}`),
  );
  return cleanReferenceWhitespace(
    body.replace(/@(图片|视频|音频)\d+/gu, (value) => (allowed.has(value) ? value : "")),
  );
}

export function findPromptReferenceRanges(
  body: string,
  referenceNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const mentions = createReferenceMentionMap(referenceNodeIds, nodes);
  const ranges: PromptReferenceRange[] = [];
  for (const [nodeId, mention] of mentions) {
    const pattern = mentionPattern(mention);
    for (const match of body.matchAll(pattern)) {
      if (match.index === undefined) continue;
      ranges.push({ nodeId, start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges.sort((left, right) => left.start - right.start);
}

export function ensurePromptReferenceMentions(
  body: string,
  referenceNodeIds: readonly string[],
  mentionNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const mentions = createReferenceMentionMap(mentionNodeIds, nodes);
  let nextBody = body;
  const missing: string[] = [];

  for (const nodeId of referenceNodeIds) {
    const mention = mentions.get(nodeId);
    if (!mention || mentionPattern(mention).test(nextBody)) continue;
    const unmarkedIndex = findUnmarkedMentionIndex(nextBody, mention);
    if (unmarkedIndex >= 0) {
      nextBody = `${nextBody.slice(0, unmarkedIndex)}@${nextBody.slice(unmarkedIndex)}`;
    } else {
      missing.push(`@${mention}`);
    }
  }

  if (!missing.length) return nextBody;
  return `${missing.join(" ")}${nextBody ? ` ${nextBody}` : ""}`;
}

export function deletePromptReferenceAtSelection(
  body: string,
  selectionStart: number,
  selectionEnd: number,
  referenceNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
  direction: "backward" | "forward",
): PromptReferenceDeletion | null {
  const start = Math.max(0, Math.min(selectionStart, selectionEnd, body.length));
  const end = Math.max(start, Math.min(Math.max(selectionStart, selectionEnd), body.length));
  const ranges = findPromptReferenceRanges(body, referenceNodeIds, nodes);
  let affected: PromptReferenceRange[];

  if (start !== end) {
    affected = ranges.filter((range) => range.start < end && range.end > start);
  } else if (direction === "backward") {
    affected = ranges.filter(
      (range) =>
        (start > range.start && start <= range.end) ||
        (body[start - 1] === " " && start - 1 === range.end),
    );
  } else {
    affected = ranges.filter((range) => start >= range.start && start < range.end);
  }

  if (!affected.length) return null;
  let deletionStart = Math.min(start, ...affected.map((range) => range.start));
  let deletionEnd = Math.max(end, ...affected.map((range) => range.end));

  if (start === end) {
    if (deletionStart === 0 && body[deletionEnd] === " ") deletionEnd += 1;
    else if (deletionEnd === body.length && body[deletionStart - 1] === " ") deletionStart -= 1;
    else if (body[deletionStart - 1] === " " && body[deletionEnd] === " ") deletionEnd += 1;
  }

  return {
    body: `${body.slice(0, deletionStart)}${body.slice(deletionEnd)}`,
    caret: deletionStart,
    affectedNodeIds: [...new Set(affected.map((range) => range.nodeId))],
  };
}

export function stripReferenceMentionTokens(
  body: string,
  referenceNodeIds: readonly string[],
  nodes: readonly WeftcanvasNode[],
) {
  const ranges = findPromptReferenceRanges(body, referenceNodeIds, nodes);
  if (!ranges.length) return body;
  let nextBody = body;
  for (const range of [...ranges].reverse()) {
    nextBody = `${nextBody.slice(0, range.start)}${nextBody.slice(range.start + 1)}`;
  }
  return cleanReferenceWhitespace(nextBody);
}

export function pruneDisconnectedPromptReferences(
  nodes: readonly WeftcanvasNode[],
  edges: readonly WeftcanvasEdge[],
  mentionNodes: readonly WeftcanvasNode[] = nodes,
) {
  const incoming = indexIncomingNodeIds(edges);
  const existingById = new Map(nodes.map((node) => [node.id, node]));

  return nodes.map((node) => {
    const previousIds = node.data.generation.referenceNodeIds;
    if (node.data.generation.referenceMode !== "explicit" || !previousIds.length) return node;
    const allowedIds = new Set(incoming.get(node.id) ?? []);
    const referenceNodeIds = previousIds.filter((id) => {
      const reference = existingById.get(id);
      return (
        allowedIds.has(id) &&
        Boolean(reference?.data.media) &&
        Boolean(reference && isReferenceKind(reference.data.kind))
      );
    });
    if (referenceNodeIds.length === previousIds.length) return node;
    const previousMentionIds = generationReferenceMentionNodeIds(
      node.id,
      previousIds,
      mentionNodes,
    );
    const nextMentionIds = generationReferenceMentionNodeIds(
      node.id,
      referenceNodeIds,
      mentionNodes,
    );
    const canonicalBody = ensurePromptReferenceMentions(
      node.data.body,
      previousIds,
      previousMentionIds,
      mentionNodes,
    );
    const body = stripUnboundReferenceMentions(
      reconcileReferenceMentions(canonicalBody, previousMentionIds, nextMentionIds, mentionNodes),
      nextMentionIds,
      mentionNodes,
    );
    return {
      ...node,
      data: {
        ...node.data,
        body,
        updatedAt: Date.now(),
        generation: {
          ...node.data.generation,
          referenceMode: "explicit" as const,
          referenceNodeIds,
          error: null,
        },
      },
    };
  });
}

function mentionPattern(mention: string) {
  return new RegExp(`@${escapeRegExp(mention)}(?!\\d)`, "gu");
}

function findUnmarkedMentionIndex(body: string, mention: string) {
  let index = body.indexOf(mention);
  while (index >= 0) {
    const followsMentionNumber = /\d/u.test(body[index + mention.length] ?? "");
    if (body[index - 1] !== "@" && !followsMentionNumber) return index;
    index = body.indexOf(mention, index + mention.length);
  }
  return -1;
}

function cleanReferenceWhitespace(body: string) {
  return body
    .replace(/[ \t]+([，。！？；：、,.!?;:])/gu, "$1")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/ +\n/gu, "\n")
    .trimEnd();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
