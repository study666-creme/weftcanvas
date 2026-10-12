import {
  CANVAS_SCHEMA_VERSION,
  canvasProjectSchema,
  type CanvasProject,
} from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import {
  ACTIVE_PROJECT_STORAGE_KEY,
  LEGACY_PROJECT_STORAGE_KEY,
  PROJECT_IMPORT_MAX_BYTES,
  collectLocalMediaIds,
  duplicateProjectSnapshot,
  loadProjectLibrary,
  parseProjectImportText,
  readProject,
  removeProject,
  setActiveProject,
  uniqueProjectName,
  writeProject,
} from "./project-library";

describe("project library", () => {
  it("migrates the previous single-project storage without losing content", () => {
    const storage = new MemoryStorage();
    const project = fixtureProject("project-old", "旧画布");
    storage.setItem(LEGACY_PROJECT_STORAGE_KEY, JSON.stringify(project));

    const library = loadProjectLibrary(storage);
    expect(library.activeProject?.name).toBe("旧画布");
    expect(library.projects).toEqual([
      expect.objectContaining({ id: "project-old", nodeCount: 2 }),
    ]);
    expect(storage.getItem(LEGACY_PROJECT_STORAGE_KEY)).toBeNull();
    expect(readProject("project-old", storage)?.nodes[0]?.data.body).toBe("第一幕");
  });

  it("tracks active projects and removes snapshots independently", () => {
    const storage = new MemoryStorage();
    writeProject(fixtureProject("project-a", "A", 10), storage);
    writeProject(fixtureProject("project-b", "B", 20), storage);
    expect(loadProjectLibrary(storage).projects.map((project) => project.id)).toEqual([
      "project-b",
      "project-a",
    ]);
    expect(setActiveProject("project-a", storage)).toBe(true);
    expect(storage.getItem(ACTIVE_PROJECT_STORAGE_KEY)).toBe("project-a");
    removeProject("project-a", storage);
    expect(readProject("project-a", storage)).toBeNull();
    expect(loadProjectLibrary(storage).projects.map((project) => project.id)).toEqual([
      "project-b",
    ]);
  });

  it("duplicates graph identity while retaining reusable media and clearing jobs", () => {
    const source = fixtureProject("project-a", "A", 10);
    source.nodes[0]!.data.status = "running";
    source.nodes[0]!.data.generation.jobId = "job-1";
    source.nodes[0]!.data.generation.jobVersion = 3;
    source.nodes[0]!.data.generation.referenceNodeIds = [source.nodes[1]!.id];
    const duplicate = duplicateProjectSnapshot(source, "A 副本", 100);

    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.nodes.map((node) => node.id)).not.toEqual(source.nodes.map((node) => node.id));
    expect(duplicate.edges[0]?.source).toBe(duplicate.nodes[0]?.id);
    expect(duplicate.nodes[0]?.data.generation.jobId).toBeNull();
    expect(duplicate.nodes[0]?.data.generation.referenceNodeIds).toEqual([duplicate.nodes[1]?.id]);
    expect(duplicate.nodes[1]?.data.media?.id).toBe("media-1");
    expect(
      uniqueProjectName("A", [{ id: "1", name: "A", createdAt: 1, updatedAt: 1, nodeCount: 0 }]),
    ).toBe("A 2");
  });

  it("collects only local media ids that are still referenced by projects", () => {
    const localProject = fixtureProject("project-a", "A", 10);
    const serverProject = fixtureProject("project-b", "B", 20);
    serverProject.nodes[1]!.data.media = {
      id: "server-media",
      name: "remote.png",
      mimeType: "image/png",
      size: 10,
      source: "server",
      serverId: "server-media",
      width: null,
      height: null,
      durationMs: null,
    };

    expect([...collectLocalMediaIds([localProject, serverProject])]).toEqual(["media-1"]);
  });

  it("round-trips a rich graph through write and read without losing authored state", () => {
    const storage = new MemoryStorage();
    const source = richProject();
    writeProject(source, storage);

    const restored = readProject(source.id, storage);
    expect(restored).not.toBeNull();
    expect(canvasProjectSchema.parse(restored)).toEqual(source);

    const library = loadProjectLibrary(storage);
    expect(library.projects[0]).toMatchObject({
      id: source.id,
      nodeCount: source.nodes.length,
      updatedAt: source.updatedAt,
    });
    expect(library.activeProject?.id).toBe(source.id);
  });

  it("keeps projects isolated when several snapshots live in the same library", () => {
    const storage = new MemoryStorage();
    const first = richProject();
    const second = duplicateProjectSnapshot(first, "另一个项目", 300);
    second.nodes[0]!.data.body = "第二个项目的开场白";
    writeProject(first, storage);
    writeProject(second, storage);

    const firstRestored = readProject(first.id, storage)!;
    const secondRestored = readProject(second.id, storage)!;
    expect(firstRestored.nodes[0]!.data.body).toBe("第一个项目的开场白");
    expect(secondRestored.nodes[0]!.data.body).toBe("第二个项目的开场白");
    expect(firstRestored.groups[0]!.id).not.toBe(secondRestored.groups[0]!.id);
    expect(firstRestored.edges[0]!.id).not.toBe(secondRestored.edges[0]!.id);

    removeProject(first.id, storage);
    expect(readProject(first.id, storage)).toBeNull();
    expect(canvasProjectSchema.parse(readProject(second.id, storage)!)).toEqual(second);
  });

  it("imports a valid project file with fresh graph identity while keeping media ids", () => {
    const storage = new MemoryStorage();
    const source = richProject();
    const exported = JSON.stringify(source);
    const outcome = parseProjectImportText(exported);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const imported = duplicateProjectSnapshot(outcome.project, "导入的项目", 200);
    expect(imported.id).not.toBe(source.id);
    expect(imported.nodes.map((node) => node.id)).not.toEqual(source.nodes.map((node) => node.id));
    expect(imported.edges[0]?.source).toBe(imported.nodes[0]?.id);
    expect(
      imported.groups[0]?.nodeIds.map((id) => imported.nodes.some((node) => node.id === id)),
    ).toEqual([true, true]);
    expect(imported.nodes[1]?.data.media?.id).toBe("media-1");
    expect(imported.nodes[0]?.data.generation.jobId).toBeNull();
    expect(imported.nodes[0]?.data.generation.jobStatus).toBeNull();
    expect(imported.nodes[1]?.data.status).toBe("success");

    writeProject(imported, storage);
    expect(readProject(imported.id, storage)).not.toBeNull();
    expect(readProject(source.id, storage)).toBeNull();
  });

  it("accepts unknown fields and legacy note kinds as a stable migration", () => {
    const source = richProject();
    source.nodes[1]!.data.kind = "note" as CanvasProject["nodes"][number]["data"]["kind"];
    const exported = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    (exported.nodes as Array<Record<string, unknown>>)[1] = {
      ...(exported.nodes as Array<Record<string, unknown>>)[1],
      unexpectedField: "kept nowhere",
    };
    (exported as Record<string, unknown>).extraRootField = { arbitrary: true };

    const outcome = parseProjectImportText(JSON.stringify(exported));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.project.nodes[1]?.data.kind).toBe("text");
    expect(outcome.project.nodes[1]?.data).not.toHaveProperty("unexpectedField");
    expect(outcome.project).not.toHaveProperty("extraRootField");
  });

  it("explicitly rejects malformed, wrong-version, and oversized import files", () => {
    expect(parseProjectImportText("{ not json").ok).toBe(false);
    expect(parseProjectImportText(JSON.stringify({ hello: "world" })).ok).toBe(false);

    const wrongVersion = JSON.parse(JSON.stringify(richProject())) as Record<string, unknown>;
    wrongVersion.schemaVersion = 999;
    const wrongVersionOutcome = parseProjectImportText(JSON.stringify(wrongVersion));
    expect(wrongVersionOutcome.ok).toBe(false);
    if (wrongVersionOutcome.ok) return;
    expect(wrongVersionOutcome.reason).toBe("invalid");

    const oversized = `{"schemaVersion":1,"id":"p","name":"n","nodes":[],"edges":[],"groups":[],"viewport":{"x":0,"y":0,"zoom":1},"createdAt":1,"updatedAt":1}${"x".repeat(PROJECT_IMPORT_MAX_BYTES)}`;
    const oversizedOutcome = parseProjectImportText(oversized);
    expect(oversizedOutcome.ok).toBe(false);
    if (oversizedOutcome.ok) return;
    expect(oversizedOutcome.reason).toBe("too-large");
  });

  it("assigns unique names across repeated imports of the same file", () => {
    const projects: Array<{
      id: string;
      name: string;
      createdAt: number;
      updatedAt: number;
      nodeCount: number;
    }> = [];
    const names: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const name = uniqueProjectName("第一个项目", projects);
      names.push(name);
      projects.push({ id: `n${index}`, name, createdAt: 1, updatedAt: 1, nodeCount: 0 });
    }
    expect(names).toEqual(["第一个项目", "第一个项目 2", "第一个项目 3"]);
  });
});

function richProject(): CanvasProject {
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id: "rich-project",
    name: "第一个项目",
    nodes: [
      {
        id: "text-a",
        type: "weftcanvas",
        position: { x: 120, y: 80 },
        data: {
          kind: "text",
          body: "第一个项目的开场白",
          accent: "jade",
          status: "running",
          progress: 40,
          media: null,
          directorCapture: null,
          config: null,
          edit: null,
          music: null,
          generation: {
            modelId: "creative-text",
            parameters: { temperature: 0.8, topP: 0.9 },
            referenceImagePurposes: {},
            maxOutputTokens: 512,
            referenceMode: "auto",
            referenceNodeIds: [],
            jobId: "job-text-1",
            jobVersion: 2,
            jobCreatedAt: "2026-08-01T00:00:00.000Z",
            jobStatus: "running",
            error: null,
          },
          createdAt: 10,
          updatedAt: 20,
        },
      },
      {
        id: "image-b",
        type: "weftcanvas",
        position: { x: 420, y: 120 },
        width: 360,
        height: 360,
        data: {
          kind: "image",
          body: "参考图",
          accent: "blue",
          status: "success",
          progress: null,
          media: {
            id: "media-1",
            name: "frame.png",
            mimeType: "image/png",
            size: 1024,
            source: "local",
            serverId: null,
            width: 512,
            height: 512,
            durationMs: null,
          },
          directorCapture: null,
          config: null,
          edit: null,
          music: null,
          generation: {
            modelId: null,
            parameters: {},
            referenceImagePurposes: {},
            maxOutputTokens: null,
            referenceMode: "explicit",
            referenceNodeIds: ["text-a"],
            jobId: null,
            jobVersion: null,
            jobCreatedAt: null,
            jobStatus: null,
            error: null,
          },
          createdAt: 10,
          updatedAt: 20,
        },
      },
    ],
    edges: [
      {
        id: "edge-ab",
        source: "text-a",
        target: "image-b",
        sourceHandle: null,
        targetHandle: null,
      },
    ],
    groups: [
      {
        id: "group-1",
        name: "开场",
        color: "#7dd3a8",
        nodeIds: ["text-a", "image-b"],
        frame: { x: 100, y: 60, width: 700, height: 440 },
        createdAt: 10,
        updatedAt: 20,
      },
    ],
    viewport: { x: 96, y: 138, zoom: 0.9 },
    createdAt: 5,
    updatedAt: 200,
  };
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }
}

function fixtureProject(id: string, name: string, updatedAt = 1): CanvasProject {
  return {
    schemaVersion: CANVAS_SCHEMA_VERSION,
    id,
    name,
    nodes: [
      node("node-a", "text", "第一幕"),
      node("node-b", "image", "", {
        id: "media-1",
        name: "frame.png",
        mimeType: "image/png",
        size: 10,
        source: "local",
        serverId: null,
        width: null,
        height: null,
        durationMs: null,
      }),
    ],
    edges: [{ id: "edge-a", source: "node-a", target: "node-b" }],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 1,
    updatedAt,
  };
}

function node(
  id: string,
  kind: "text" | "image",
  body: string,
  media: CanvasProject["nodes"][number]["data"]["media"] = null,
): CanvasProject["nodes"][number] {
  return {
    id,
    type: "weftcanvas",
    position: { x: 0, y: 0 },
    data: {
      kind,
      body,
      accent: "jade",
      status: media ? "success" : "idle",
      progress: null,
      media,
      directorCapture: null,
      config: null,
      edit: null,
      music: null,
      generation: {
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
      },
      createdAt: 1,
      updatedAt: 1,
    },
  };
}
