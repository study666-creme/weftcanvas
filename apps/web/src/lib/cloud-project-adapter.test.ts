import type { CanvasProject } from "@weftcanvas/contracts";
import { describe, expect, it } from "vitest";

import { canvasDocumentToProject, projectToCanvasDocument } from "./cloud-project-adapter";

describe("cloud project adapter", () => {
  it("removes canvas-engine state from cloud documents", () => {
    const project = fixtureProject();
    project.nodes[0]!.selected = true;
    project.nodes[0]!.data.status = "running";
    project.nodes[0]!.data.progress = 42;

    const document = projectToCanvasDocument(project);
    expect(document.nodes[0]).not.toHaveProperty("type");
    expect(document.nodes[0]).not.toHaveProperty("selected");
    expect(document.nodes[0]?.data).not.toHaveProperty("status");
    expect(document.nodes[0]?.data).not.toHaveProperty("progress");
  });

  it("turns uploaded local media into portable server references", () => {
    const project = fixtureProject();
    project.nodes[0]!.data.media = {
      id: "local-media",
      name: "frame.png",
      mimeType: "image/png",
      size: 128,
      source: "local",
      serverId: "11111111-1111-4111-8111-111111111111",
      width: 640,
      height: 360,
      durationMs: null,
    };

    const document = projectToCanvasDocument(project);
    expect(document.nodes[0]?.data.media).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      source: "server",
    });
    expect(canvasDocumentToProject(document).nodes[0]?.data.status).toBe("success");
  });
});

function fixtureProject(): CanvasProject {
  return {
    schemaVersion: 1,
    id: "project-1",
    name: "Project",
    nodes: [
      {
        id: "node-1",
        type: "weftcanvas",
        position: { x: 10, y: 20 },
        data: {
          kind: "image",
          body: "",
          accent: "jade",
          status: "idle",
          progress: null,
          media: null,
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
      },
    ],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}
