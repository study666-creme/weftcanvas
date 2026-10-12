import type { PublicGenerationJob } from "@weftcanvas/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { createCanvasNode } from "../lib/node-factory";
import { useCanvasStore } from "./canvas-store";

describe("canvas generation history", () => {
  beforeEach(() => {
    useCanvasStore.setState({
      projectId: "project-test",
      nodes: [],
      edges: [],
      groups: [],
      past: [],
      future: [],
      transactionBase: null,
      clipboard: null,
      activeToolbarNodeId: null,
      saveState: "saved",
    });
  });

  it("keeps a paid running node when undo reaches a snapshot from before node creation", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-running",
        nodeId,
        status: "running",
        version: 2,
        progress: 37,
      }),
    );

    expect(useCanvasStore.getState().past).toHaveLength(1);
    useCanvasStore.getState().undo();

    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    expect(node?.data.status).toBe("running");
    expect(node?.data.progress).toBe(37);
    expect(node?.data.generation).toMatchObject({
      jobId: "job-running",
      jobVersion: 2,
      jobStatus: "running",
    });
  });

  it("protects an optimistic submission before the first server job snapshot", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      progress: 0,
      generation: {
        ...node.data.generation,
        jobStatus: "submitting",
        error: null,
      },
    });

    useCanvasStore.getState().undo();
    let restored = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    expect(restored?.data.status).toBe("running");
    expect(restored?.data.generation.jobStatus).toBe("submitting");

    useCanvasStore.getState().updateNodeData(nodeId, { body: "ordinary edit" });
    useCanvasStore.getState().undo();
    restored = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    expect(restored?.data.body).toBe("");
    expect(restored?.data.status).toBe("running");
    expect(restored?.data.generation.jobStatus).toBe("submitting");
  });

  it("protects browser-owned primary and additional media with their generated edge", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    const generation = {
      ...node.data.generation,
      modelId: "custom:image",
      jobId: "browser:test",
      jobVersion: 2,
      jobCreatedAt: "2026-07-29T02:00:00.000Z",
      jobStatus: "completed" as const,
      error: null,
    };
    useCanvasStore.getState().applyGenerationUpdate(
      nodeId,
      {
        media: localImage("browser-primary"),
        status: "success",
        progress: null,
        generation,
      },
      { result: "media" },
    );
    const additionalId = useCanvasStore.getState().addGeneratedConnectedNode(nodeId, "image", {
      media: localImage("browser-additional"),
      status: "success",
      progress: null,
      generation,
    });
    expect(additionalId).toBeTruthy();

    useCanvasStore.getState().undo();
    useCanvasStore.getState().undo();

    const state = useCanvasStore.getState();
    expect(
      state.nodes
        .map((item) => item.data.media?.id)
        .filter(Boolean)
        .sort(),
    ).toEqual(["browser-additional", "browser-primary"]);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]).toMatchObject({ source: nodeId, target: additionalId });
  });

  it("restores a paid node undone before the first accepted server snapshot arrives", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes).toHaveLength(0);

    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-accepted-race",
        nodeId,
        status: "queued",
        version: 1,
        progress: 0,
      }),
    );

    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId);
    expect(node?.data.status).toBe("running");
    expect(node?.data.generation.jobId).toBe("job-accepted-race");
  });

  it("keeps a completed primary artifact through undo and redo of a user edit", () => {
    const origin = createCanvasNode("image", { x: 0, y: 0 }, { body: "first prompt" });
    origin.id = "origin";
    useCanvasStore.setState({ nodes: [origin] });
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-completed",
        nodeId: origin.id,
        status: "running",
        version: 1,
        progress: 45,
      }),
    );
    useCanvasStore.getState().updateNodeData(origin.id, { body: "edited prompt" });
    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((node) =>
        node.id === origin.id ? { ...node, width: 512, height: 288 } : node,
      ),
    }));
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-completed",
        nodeId: origin.id,
        status: "completed",
        version: 2,
        progress: 100,
        artifacts: [imageArtifact("primary")],
      }),
    );

    expect(useCanvasStore.getState().past).toHaveLength(1);
    const completedNode = useCanvasStore.getState().nodes.find((item) => item.id === origin.id);
    const completedDimensions = { width: completedNode?.width, height: completedNode?.height };
    expect(completedDimensions.width).toBe(completedDimensions.height);
    useCanvasStore.getState().undo();
    let node = useCanvasStore.getState().nodes.find((item) => item.id === origin.id);
    expect(node?.data.body).toBe("first prompt");
    expect(node?.data.status).toBe("success");
    expect(node?.data.media?.id).toBe("primary");
    expect(node?.data.generation.jobStatus).toBe("completed");
    expect(node).toMatchObject(completedDimensions);

    useCanvasStore.getState().redo();
    node = useCanvasStore.getState().nodes.find((item) => item.id === origin.id);
    expect(node?.data.body).toBe("edited prompt");
    expect(node?.data.media?.id).toBe("primary");
    expect(node?.data.generation.jobStatus).toBe("completed");
    expect(node).toMatchObject(completedDimensions);
  });

  it("projects additional artifacts and their generated edges into old snapshots", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-batch",
        nodeId,
        status: "completed",
        version: 3,
        progress: 100,
        artifacts: [imageArtifact("primary"), imageArtifact("additional")],
      }),
    );
    const additionalId = useCanvasStore
      .getState()
      .nodes.find((node) => node.data.media?.id === "additional")?.id;
    expect(additionalId).toBeTruthy();
    expect(useCanvasStore.getState().past).toHaveLength(1);

    useCanvasStore.getState().undo();

    const state = useCanvasStore.getState();
    expect(
      state.nodes
        .map((node) => node.data.media?.id)
        .filter(Boolean)
        .sort(),
    ).toEqual(["additional", "primary"]);
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]).toMatchObject({ source: nodeId, target: additionalId });
  });

  it("updates an active transaction baseline so committing a gesture cannot restore idle state", () => {
    const origin = createCanvasNode("image", { x: 0, y: 0 }, { body: "before gesture" });
    origin.id = "origin";
    useCanvasStore.setState({ nodes: [origin] });
    useCanvasStore.getState().beginTransaction();
    useCanvasStore.getState().updateNodeData(origin.id, { body: "during gesture" }, false);
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-during-gesture",
        nodeId: origin.id,
        status: "running",
        version: 1,
        progress: 12,
      }),
    );
    useCanvasStore.getState().commitTransaction();
    useCanvasStore.getState().undo();

    const node = useCanvasStore.getState().nodes.find((item) => item.id === origin.id);
    expect(node?.data.body).toBe("before gesture");
    expect(node?.data.status).toBe("running");
    expect(node?.data.generation.jobId).toBe("job-during-gesture");
  });

  it("keeps an explicit deletion while projecting a hidden completion into undo and redo history", () => {
    const origin = createCanvasNode("image", { x: 0, y: 0 });
    origin.id = "origin";
    useCanvasStore.setState({ nodes: [origin] });
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-delete",
        nodeId: origin.id,
        status: "running",
        version: 1,
        progress: 10,
      }),
    );

    useCanvasStore.getState().deleteNode(origin.id);
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-delete",
        nodeId: origin.id,
        status: "completed",
        version: 2,
        progress: 100,
        artifacts: [imageArtifact("deleted-result")],
      }),
    );
    expect(useCanvasStore.getState().nodes).toHaveLength(0);

    useCanvasStore.getState().undo();
    const restored = useCanvasStore.getState().nodes.find((node) => node.id === origin.id);
    expect(restored?.data.status).toBe("success");
    expect(restored?.data.media?.id).toBe("deleted-result");
    expect(restored?.data.generation.jobVersion).toBe(2);

    useCanvasStore.getState().redo();
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes[0]?.data.media?.id).toBe("deleted-result");
  });

  it("projects browser-owned additional media into an explicitly deleted anchor's history", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const running = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)!;
    const generation = {
      ...running.data.generation,
      modelId: "custom:image",
      jobId: "browser:hidden",
      jobVersion: 2,
      jobCreatedAt: "2026-07-29T02:00:00.000Z",
      jobStatus: "completed" as const,
      error: null,
    };
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      progress: 20,
      generation: { ...generation, jobStatus: "running" },
    });
    useCanvasStore.getState().deleteNode(nodeId);
    useCanvasStore.getState().applyGenerationUpdate(
      nodeId,
      {
        media: localImage("hidden-primary"),
        status: "success",
        progress: null,
        generation,
      },
      { result: "media" },
    );
    const additionalId = useCanvasStore.getState().addGeneratedConnectedNode(nodeId, "image", {
      media: localImage("hidden-additional"),
      status: "success",
      progress: null,
      generation,
    });

    expect(additionalId).toBeTruthy();
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    useCanvasStore.getState().undo();
    const restored = useCanvasStore.getState();
    expect(
      restored.nodes
        .map((node) => node.data.media?.id)
        .filter(Boolean)
        .sort(),
    ).toEqual(["hidden-additional", "hidden-primary"]);
    expect(restored.edges).toContainEqual(
      expect.objectContaining({ source: nodeId, target: additionalId }),
    );
  });

  it("does not revive an explicitly deleted task when an unrelated transaction is undone", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 40, y: 60 });
    const otherId = useCanvasStore.getState().addNode("text", { x: 500, y: 60 });
    const running = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)!;
    const generation = {
      ...running.data.generation,
      modelId: "custom:image",
      jobId: "browser:hidden-during-transaction",
      jobVersion: 2,
      jobCreatedAt: "2026-07-29T02:00:00.000Z",
      jobStatus: "completed" as const,
      error: null,
    };
    useCanvasStore.getState().applyGenerationUpdate(nodeId, {
      status: "running",
      progress: 20,
      generation: { ...generation, jobStatus: "running" },
    });
    useCanvasStore.getState().deleteNode(nodeId);

    useCanvasStore.getState().beginTransaction();
    useCanvasStore.getState().updateNodeData(otherId, { body: "gesture edit" }, false);
    useCanvasStore.getState().applyGenerationUpdate(
      nodeId,
      {
        media: localImage("hidden-primary-during-transaction"),
        status: "success",
        progress: null,
        generation,
      },
      { result: "media" },
    );
    useCanvasStore.getState().addGeneratedConnectedNode(nodeId, "image", {
      media: localImage("hidden-additional-during-transaction"),
      status: "success",
      progress: null,
      generation,
    });
    useCanvasStore.getState().commitTransaction();

    expect(useCanvasStore.getState().nodes.some((node) => node.id === nodeId)).toBe(false);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.some((node) => node.id === nodeId)).toBe(false);
    expect(useCanvasStore.getState().nodes.find((node) => node.id === otherId)?.data.body).toBe("");
  });

  it("keeps decoded media dimensions and geometry through undo", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });
    useCanvasStore.getState().applyGenerationJob(
      generationJob({
        id: "job-measured",
        nodeId,
        status: "completed",
        version: 2,
        progress: 100,
        artifacts: [imageArtifact("measured", false)],
      }),
    );
    const media = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data.media;
    expect(media).toBeTruthy();
    useCanvasStore.getState().setNodeMedia(nodeId, { ...media!, width: 240, height: 480 }, false);

    useCanvasStore.getState().undo();

    const restored = useCanvasStore.getState().nodes.find((node) => node.id === nodeId);
    expect(restored?.data.media).toMatchObject({ width: 240, height: 480 });
    expect(restored).toMatchObject({ width: 200, height: 400 });
  });
});

function generationJob({
  id,
  nodeId,
  status,
  version,
  progress,
  artifacts = [],
}: {
  id: string;
  nodeId: string;
  status: PublicGenerationJob["status"];
  version: number;
  progress: number;
  artifacts?: PublicGenerationJob["artifacts"];
}): PublicGenerationJob {
  const createdAt = "2026-07-29T02:00:00.000Z";
  return {
    schemaVersion: 1,
    version,
    id,
    projectId: "project-test",
    nodeId,
    modelId: "image-model",
    modelLabel: "Image model",
    modality: "image",
    status,
    progress,
    quote: {
      id: `quote-${id}`,
      modelId: "image-model",
      modelLabel: "Image model",
      modality: "image",
      quantity: 1,
      normalizedParameters: {},
      creditMicros: 1,
      credits: "0.000001",
      yuanMicros: 1,
      yuan: "0.000001",
      estimated: false,
      pricingUnit: "image",
      catalogVersion: "catalog-1",
      capabilityVersion: "capability-1",
      pricingVersion: "pricing-1",
      expiresAt: "2026-07-29T03:00:00.000Z",
    },
    artifacts,
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: status === "reserved" ? null : createdAt,
    completedAt: status === "completed" || status === "failed" ? createdAt : null,
  };
}

function imageArtifact(
  id: string,
  withDimensions = true,
): PublicGenerationJob["artifacts"][number] {
  return {
    id: `artifact-${id}`,
    kind: "image",
    mediaId: id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 128,
    ...(withDimensions ? { width: 1024, height: 1024 } : {}),
    createdAt: "2026-07-29T02:01:00.000Z",
  };
}

function localImage(id: string) {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 68,
    source: "local" as const,
    serverId: null,
    width: 1,
    height: 1,
    durationMs: null,
  };
}
