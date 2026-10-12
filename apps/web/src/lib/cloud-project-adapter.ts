import {
  canvasDocumentSchema,
  canvasProjectSchema,
  type CanvasDocument,
  type CanvasProject,
} from "@weftcanvas/contracts";

export function projectToCanvasDocument(value: CanvasProject): CanvasDocument {
  const project = canvasProjectSchema.parse(value);
  return canvasDocumentSchema.parse({
    schemaVersion: 1,
    projectId: project.id,
    title: project.name,
    nodes: project.nodes.map((node) => {
      const { kind, status: _status, progress: _progress, ...data } = node.data;
      return {
        id: node.id,
        kind,
        position: node.position,
        size: node.width && node.height ? { width: node.width, height: node.height } : null,
        data: {
          ...data,
          media: cloudMedia(data.media),
        },
      };
    }),
    edges: project.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourcePort: edge.sourceHandle ?? null,
      targetPort: edge.targetHandle ?? null,
    })),
    groups: project.groups,
    viewport: project.viewport,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  });
}

export function canvasDocumentToProject(value: CanvasDocument): CanvasProject {
  const document = canvasDocumentSchema.parse(value);
  return canvasProjectSchema.parse({
    schemaVersion: 1,
    id: document.projectId,
    name: document.title,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      type: "weftcanvas",
      position: node.position,
      ...(node.size ? { width: node.size.width, height: node.size.height } : {}),
      data: {
        ...node.data,
        kind: node.kind,
        status: restoredNodeStatus(node.data),
        progress: null,
      },
    })),
    edges: document.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourcePort,
      targetHandle: edge.targetPort,
    })),
    groups: document.groups,
    viewport: document.viewport,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
  });
}

export async function canvasDocumentFingerprint(document: CanvasDocument) {
  const signature = JSON.stringify({ ...canvasDocumentSchema.parse(document), updatedAt: 0 });
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signature));
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  return fallbackFingerprint(signature);
}

function cloudMedia(media: CanvasProject["nodes"][number]["data"]["media"]) {
  if (!media?.serverId) return media;
  return {
    ...media,
    id: media.serverId,
    source: "server" as const,
    serverId: media.serverId,
  };
}

function restoredNodeStatus(data: CanvasDocument["nodes"][number]["data"]) {
  const jobStatus = data.generation.jobStatus;
  if (jobStatus === "failed" || data.generation.error) return "error" as const;
  if (jobStatus && jobStatus !== "completed") return "running" as const;
  if (data.media || jobStatus === "completed") return "success" as const;
  return "idle" as const;
}

function fallbackFingerprint(value: string) {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
}
