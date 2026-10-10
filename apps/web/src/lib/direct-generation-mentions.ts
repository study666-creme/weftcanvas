export type DirectMentionReference = {
  id: string;
  kind: "image" | "video" | "audio";
  name: string;
  status: "uploading" | "ready" | "error";
};

export type DirectMentionCandidate = DirectMentionReference & {
  label: string;
};

const KIND_LABELS: Record<DirectMentionReference["kind"], string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
};

export function directMentionCandidates(references: DirectMentionReference[]): DirectMentionCandidate[] {
  const counters: Record<string, number> = {};
  return references
    .filter((reference) => reference.status === "ready")
    .map((reference) => {
      const prefix = KIND_LABELS[reference.kind];
      counters[prefix] = (counters[prefix] ?? 0) + 1;
      return { ...reference, label: `${prefix}${counters[prefix]}` };
    });
}

export function mentionQueryAtCursor(value: string, cursor: number): { start: number; end: number; query: string } | null {
  const before = value.slice(0, cursor);
  // Trigger on "@" at the start, after whitespace, or right after CJK/punctuated
  // text (e.g. "猫@"), but not when it is glued to a latin word/handle like an
  // email ("email@test") or another "@" ("@@").
  const match = before.match(/(^|[^A-Za-z0-9@＠])@([^\s@＠]*)$/u);
  if (!match) return null;
  const start = cursor - (match[2]?.length ?? 0) - 1;
  return { start, end: cursor, query: match[2] ?? "" };
}

export function insertDirectMention(
  value: string,
  range: { start: number; end: number },
  candidate: DirectMentionCandidate,
): { value: string; cursor: number } {
  const insertion = `@${candidate.label} `;
  const nextValue = `${value.slice(0, range.start)}${insertion}${value.slice(range.end)}`;
  return { value: nextValue, cursor: range.start + insertion.length };
}

export function removeInvalidDirectMentions(value: string, references: DirectMentionReference[]): string {
  const valid = new Set(directMentionCandidates(references).map((candidate) => candidate.label));
  return value.replace(/@((?:图片|视频|音频)\d+)/gu, (token, label: string) => valid.has(label) ? token : "");
}

/**
 * Keep mention labels bound to the same uploaded material when removing an
 * earlier item causes the visible 图片1/图片2 numbering to shift.
 */
export function reconcileDirectMentions(
  value: string,
  previousReferences: DirectMentionReference[],
  nextReferences: DirectMentionReference[],
): string {
  const previousByLabel = new Map(directMentionCandidates(previousReferences).map((candidate) => [candidate.label, candidate.id]));
  const nextById = new Map(directMentionCandidates(nextReferences).map((candidate) => [candidate.id, candidate.label]));
  return value.replace(/@((?:图片|视频|音频)\d+)/gu, (_token, label: string) => {
    const referenceId = previousByLabel.get(label);
    const nextLabel = referenceId ? nextById.get(referenceId) : null;
    return nextLabel ? `@${nextLabel}` : "";
  });
}
