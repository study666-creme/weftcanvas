import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicGenerationJob } from "@weftcanvas/contracts";

import { createCanvasNode } from "../lib/node-factory";
import { generationParametersAspectRatio, parseMediaAspectRatio } from "../lib/node-size";
import type { WeftcanvasNode } from "../types";
import { queueCanvasNodePositionChanges, selectProject, useCanvasStore } from "./canvas-store";
import { useUiPreferencesStore } from "./ui-preferences-store";

describe("canvas reference lifecycle", () => {
  beforeEach(() => {
    useUiPreferencesStore.getState().setDefaultNodeAspectRatio("16:9");
    useCanvasStore.setState({
      nodes: [],
      edges: [],
      groups: [],
      past: [],
      future: [],
      transactionBase: null,
      clipboard: null,
      activeToolbarNodeId: null,
      saveState: "saved",
      viewport: { x: 0, y: 0, zoom: 0.9 },
    });
  });

  it("removes deleted node ids from explicit references", () => {
    useCanvasStore.setState({
      nodes: referenceGraph(),
      edges: [{ id: "reference-edge", source: "reference", target: "target" }],
    });

    useCanvasStore.getState().deleteNode("reference");

    const target = useCanvasStore.getState().nodes.find((node) => node.id === "target");
    expect(target?.data.generation.referenceNodeIds).toEqual([]);
    expect(target?.data.generation.referenceMode).toBe("explicit");
    expect(target?.data.body).toBe("");
  });

  it("removes explicit references when their upstream connection is deleted", () => {
    useCanvasStore.setState({
      nodes: referenceGraph(),
      edges: [{ id: "reference-edge", source: "reference", target: "target" }],
    });

    useCanvasStore.getState().onEdgesChange([{ id: "reference-edge", type: "remove" }]);

    const target = useCanvasStore.getState().nodes.find((node) => node.id === "target");
    expect(target?.data.generation.referenceNodeIds).toEqual([]);
    expect(target?.data.body).toBe("");
  });

  it("disconnects nodes without deleting endpoints and records an undo step", () => {
    useCanvasStore.setState({
      nodes: referenceGraph(),
      edges: [{ id: "reference-edge", source: "reference", target: "target" }],
    });

    useCanvasStore.getState().disconnectNodes("reference", "target");

    let state = useCanvasStore.getState();
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toEqual([]);
    expect(
      state.nodes.find((node) => node.id === "target")?.data.generation.referenceNodeIds,
    ).toEqual([]);
    expect(state.past).toHaveLength(1);
    expect(state.saveState).toBe("saving");

    state.undo();
    state = useCanvasStore.getState();
    expect(state.nodes).toHaveLength(2);
    expect(state.edges).toHaveLength(1);
    expect(
      state.nodes.find((node) => node.id === "target")?.data.generation.referenceNodeIds,
    ).toEqual(["reference"]);
  });

  it("connects every selected node to one target as one undoable batch", () => {
    const first = createCanvasNode("text", { x: 0, y: 0 });
    const second = createCanvasNode("text", { x: 360, y: 0 });
    const target = createCanvasNode("image", { x: 720, y: 0 });
    first.selected = true;
    second.selected = true;
    target.selected = false;
    useCanvasStore.setState({ nodes: [first, second, target], edges: [] });

    expect(useCanvasStore.getState().connectSelectionToNode(target.id, "outgoing")).toBe(2);
    expect(useCanvasStore.getState().edges.map((edge) => [edge.source, edge.target])).toEqual([
      [first.id, target.id],
      [second.id, target.id],
    ]);
    expect(useCanvasStore.getState().past).toHaveLength(1);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().edges).toEqual([]);
  });

  it("connects one source to every selected node and filters self or duplicate edges", () => {
    const source = createCanvasNode("text", { x: 0, y: 0 });
    const first = createCanvasNode("image", { x: 360, y: 0 });
    const second = createCanvasNode("image", { x: 720, y: 0 });
    source.selected = false;
    first.selected = true;
    second.selected = true;
    const existing = {
      id: "existing",
      type: "weftcanvas" as const,
      source: source.id,
      target: first.id,
    };
    useCanvasStore.setState({ nodes: [source, first, second], edges: [existing] });

    expect(useCanvasStore.getState().connectSelectionToNode(source.id, "incoming")).toBe(1);
    expect(useCanvasStore.getState().edges.map((edge) => [edge.source, edge.target])).toEqual([
      [source.id, first.id],
      [source.id, second.id],
    ]);
    expect(useCanvasStore.getState().connectSelectionToNode(first.id, "outgoing")).toBe(0);
    expect(useCanvasStore.getState().past).toHaveLength(1);
  });

  it("remaps references when duplicating a selected graph", () => {
    const nodes = referenceGraph();
    nodes.forEach((node) => {
      node.selected = true;
    });
    useCanvasStore.setState({ nodes });

    useCanvasStore.getState().duplicateSelection();

    expectSelectedCopyToReferenceSelectedImage();
  });

  it("remaps references when copying and pasting a selected graph", () => {
    const nodes = referenceGraph();
    nodes.forEach((node) => {
      node.selected = true;
    });
    useCanvasStore.setState({ nodes });

    useCanvasStore.getState().copySelection();
    useCanvasStore.getState().pasteSelection();

    expectSelectedCopyToReferenceSelectedImage();
  });

  it("clears generation runtime state while duplicating and pasting a graph", () => {
    const source = createCanvasNode("image", { x: 0, y: 0 }, { body: "image prompt" });
    source.id = "source";
    const target = createCanvasNode("video", { x: 400, y: 0 }, { body: "video prompt" });
    target.id = "target";
    source.selected = true;
    target.selected = true;
    source.data.media = {
      id: "old-media",
      name: "old.png",
      mimeType: "image/png",
      size: 1,
      source: "server",
      serverId: "old-media",
      width: 1,
      height: 1,
      durationMs: null,
    };
    source.data.status = "running";
    source.data.progress = 47;
    source.data.generation = {
      ...source.data.generation,
      modelId: "image-model",
      parameters: { aspect_ratio: "16:9" },
      referenceImagePurposes: { "old-media": "styleImages" },
      maxOutputTokens: 2048,
      referenceMode: "explicit",
      referenceNodeIds: [target.id],
      jobId: "job-running",
      jobVersion: 4,
      jobCreatedAt: "2026-07-15T10:00:00.000Z",
      jobStatus: "running",
      error: "stale error",
    };
    Object.assign(source.data.generation as Record<string, unknown>, {
      artifactId: "artifact-runtime",
      submissionKey: "submission-runtime",
    });
    useCanvasStore.setState({
      nodes: [source, target],
      edges: [{ id: "source-target", source: source.id, target: target.id }],
    });

    useCanvasStore.getState().duplicateSelection();
    assertReusableGraph({ expectTwoCopies: true });

    useCanvasStore.getState().copySelection();
    useCanvasStore.getState().pasteSelection();
    assertReusableGraph({ expectTwoCopies: false });
  });

  it("inserts a dropped batch as one selected undo transaction", () => {
    useCanvasStore.getState().addImportedNodes([
      { kind: "text", position: { x: 10, y: 20 }, data: { body: "一" } },
      { kind: "text", position: { x: 360, y: 20 }, data: { body: "二" } },
    ]);

    expect(useCanvasStore.getState().nodes).toHaveLength(2);
    expect(useCanvasStore.getState().nodes.every((node) => node.selected)).toBe(true);
    expect(useCanvasStore.getState().past).toHaveLength(1);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
  });

  it("keeps intrinsic dimensions stable for direct, connected, and uploaded nodes regardless of the creation zoom", () => {
    useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 0.1 });

    const imageId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });
    const videoId = useCanvasStore.getState().addConnectedNode(imageId, "right", "video");
    const [uploadedId] = useCanvasStore.getState().addImportedNodes([
      {
        kind: "image",
        position: { x: 4_000, y: 0 },
        data: {
          media: {
            id: "overview-upload",
            name: "overview.png",
            mimeType: "image/png",
            size: 1,
            source: "local",
            serverId: null,
            width: 1_920,
            height: 1_080,
            durationMs: null,
          },
        },
      },
    ]);

    expect(useCanvasStore.getState().nodes.find((node) => node.id === imageId)).toMatchObject({
      width: 340,
      height: 191,
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === videoId)).toMatchObject({
      width: 340,
      height: 191,
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === uploadedId)).toMatchObject({
      width: 360,
      height: 203,
    });
  });

  it("parses generation aspect ratios from common model parameter formats", () => {
    expect(parseMediaAspectRatio("16:9")).toBeCloseTo(16 / 9);
    expect(parseMediaAspectRatio("16 / 9")).toBeCloseTo(16 / 9);
    expect(parseMediaAspectRatio(4 / 3)).toBeCloseTo(4 / 3);
    expect(parseMediaAspectRatio({ width: 720, height: 1_280 })).toBeCloseTo(9 / 16);
    expect(generationParametersAspectRatio({ size: "720x1280" })).toBeCloseTo(9 / 16);
    expect(generationParametersAspectRatio({ aspect_ratio: "auto", size: "720x1280" })).toBeCloseTo(
      9 / 16,
    );
    expect(
      generationParametersAspectRatio({ aspect_ratio: "original", size: "1024x1024" }),
    ).toBeNull();
    expect(
      generationParametersAspectRatio({ aspect_ratio: "16:9", size: "720x1280" }, "size"),
    ).toBeCloseTo(9 / 16);
    expect(generationParametersAspectRatio({ size: 1_024 })).toBeNull();
    expect(generationParametersAspectRatio({ size: "1024" })).toBeNull();
    expect(parseMediaAspectRatio("original")).toBeNull();
    expect(parseMediaAspectRatio("0:9")).toBeNull();
    expect(parseMediaAspectRatio("not-a-ratio")).toBeNull();
  });

  it("reshapes media through generation parameters without moving its center or losing its scale", () => {
    const node = createCanvasNode("image", { x: 100, y: 200 });
    node.width = 680;
    node.height = 382;
    node.id = "ratio-image";
    useCanvasStore.setState({ nodes: [node] });
    const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };

    useCanvasStore
      .getState()
      .resizeMediaNodeForGenerationParameters(node.id, { ratio: "9/16" }, { force: true });
    const current = useCanvasStore.getState().nodes[0]!;

    expect(current.width! / current.height!).toBeCloseTo(9 / 16);
    expect(Math.max(current.width!, current.height!)).toBeCloseTo(680);
    expect(current.position.x + current.width! / 2).toBeCloseTo(center.x);
    expect(current.position.y + current.height! / 2).toBeCloseTo(center.y);
    expect(useCanvasStore.getState().past).toHaveLength(1);
  });

  it("reshapes only media targets currently owned by a configuration node", () => {
    const config = createCanvasNode("config", { x: 0, y: 0 }, { config: { modality: "video" } });
    config.id = "ratio-config";
    const target = createCanvasNode("video", { x: 400, y: 0 });
    target.id = "ratio-video";
    const image = createCanvasNode("image", { x: 800, y: 0 });
    image.id = "ratio-image-unbound";
    useCanvasStore.setState({
      nodes: [config, target, image],
      edges: [
        { id: "config-video", source: config.id, target: target.id },
        { id: "config-image", source: config.id, target: image.id },
      ],
    });

    useCanvasStore
      .getState()
      .resizeMediaNodeForGenerationParameters(config.id, { aspect_ratio: "9:16" }, { force: true });

    expect(targetRatio(target.id)).toBeCloseTo(9 / 16);
    expect(targetRatio(image.id)).toBeCloseTo(16 / 9);
    expect(useCanvasStore.getState().past).toHaveLength(1);
  });

  it("reshapes a target when it is connected to an already configured ratio", () => {
    const config = createCanvasNode(
      "config",
      { x: 0, y: 0 },
      {
        config: { modality: "image" },
      },
    );
    config.id = "ratio-config-connect";
    config.data.generation.parameters = { aspect_ratio: "9:16" };
    config.data.generation.aspectExplicit = true;
    const target = createCanvasNode("image", { x: 400, y: 0 });
    target.id = "ratio-image-connect";
    useCanvasStore.setState({ nodes: [config, target], edges: [] });

    useCanvasStore.getState().onConnect({
      source: config.id,
      target: target.id,
      sourceHandle: null,
      targetHandle: null,
    });

    expect(targetRatio(target.id)).toBeCloseTo(9 / 16);
    expect(
      useCanvasStore.getState().nodes.find((node) => node.id === target.id)?.data.generation
        .parameters,
    ).toEqual({ aspect_ratio: "9:16" });
  });

  it("reshapes a target when its authoritative configuration connection changes", () => {
    const first = createCanvasNode("config", { x: 0, y: 0 }, { config: { modality: "image" } });
    first.id = "ratio-config-first";
    first.data.generation.parameters = { aspect_ratio: "4:3" };
    first.data.generation.aspectExplicit = true;
    const latest = createCanvasNode("config", { x: 0, y: 300 }, { config: { modality: "image" } });
    latest.id = "ratio-config-latest";
    latest.data.generation.parameters = { aspect_ratio: "9:16" };
    latest.data.generation.aspectExplicit = true;
    const target = createCanvasNode("image", { x: 400, y: 0 });
    target.id = "ratio-image-authority";
    useCanvasStore.setState({ nodes: [first, latest, target], edges: [] });

    useCanvasStore
      .getState()
      .onConnect({ source: first.id, target: target.id, sourceHandle: null, targetHandle: null });
    useCanvasStore
      .getState()
      .onConnect({ source: latest.id, target: target.id, sourceHandle: null, targetHandle: null });
    expect(targetRatio(target.id)).toBeCloseTo(9 / 16);

    const latestEdge = useCanvasStore.getState().edges.find((edge) => edge.source === latest.id)!;
    useCanvasStore.getState().onEdgesChange([{ id: latestEdge.id, type: "remove" }]);

    expect(targetRatio(target.id)).toBeCloseTo(4 / 3);
    expect(
      useCanvasStore.getState().nodes.find((node) => node.id === target.id)?.data.generation
        .parameters,
    ).toEqual({ aspect_ratio: "4:3" });
  });

  it("preserves a generation-selected ratio when a media node is restored", () => {
    const node = createCanvasNode("image", { x: 100, y: 200 });
    node.id = "ratio-image-restore";
    node.width = 360;
    node.height = 360;
    node.data.media = {
      id: "landscape-media",
      name: "landscape.png",
      mimeType: "image/png",
      size: 1,
      source: "local",
      serverId: null,
      width: 1_920,
      height: 1_080,
      durationMs: null,
    };
    node.data.generation.parameters = { aspect_ratio: "1:1" };
    useCanvasStore.setState({ nodes: [node], edges: [], groups: [] });
    const project = selectProject(useCanvasStore.getState());

    useCanvasStore.getState().replaceProject(project);

    expect(targetRatio(node.id)).toBeCloseTo(1);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({ width: 360, height: 360 });
  });

  it("does not resize or create history when unrelated generation parameters change", () => {
    const node = createCanvasNode("image", { x: 100, y: 200 });
    node.id = "ratio-image-unrelated";
    node.data.generation.parameters = { aspect_ratio: "16:9", steps: 20 };
    useCanvasStore.setState({ nodes: [node], past: [], future: [] });

    useCanvasStore.getState().resizeMediaNodeForGenerationParameters(node.id, {
      aspect_ratio: "16:9",
      steps: 30,
    });

    expect(useCanvasStore.getState().nodes[0]).toBe(node);
    expect(useCanvasStore.getState().past).toHaveLength(0);
  });

  it("applies the global default aspect ratio to every empty visual-node path", () => {
    useUiPreferencesStore.getState().setDefaultNodeAspectRatio("9:16");

    const imageId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });
    const connectedId = useCanvasStore.getState().addConnectedNode(imageId, "right", "video");
    const [importedId] = useCanvasStore.getState().addImportedNodes([
      {
        kind: "image",
        position: { x: 900, y: 0 },
        data: {
          status: "success",
          media: {
            id: "imported-media",
            name: "imported.png",
            mimeType: "image/png",
            size: 1,
            source: "local",
            serverId: null,
            width: 1920,
            height: 1080,
            durationMs: null,
          },
        },
      },
    ]);

    expect(useCanvasStore.getState().nodes.find((node) => node.id === imageId)).toMatchObject({
      width: 191,
      height: 340,
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === connectedId)).toMatchObject({
      width: 191,
      height: 340,
    });
    expect(useCanvasStore.getState().nodes.find((node) => node.id === importedId)).toMatchObject({
      width: 360,
      height: 203,
    });
  });

  it("keeps the creator default aspect on restore when only auto model defaults are persisted", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });
    // 模拟生成面板自动选模型后写入的模型默认参数（未显式配置画幅）。
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    useCanvasStore.getState().updateNodeData(
      nodeId,
      {
        generation: {
          ...node.data.generation,
          modelId: "auto-model",
          parameters: { size: "9:16" },
        },
      },
      false,
    );

    const project = selectProject(useCanvasStore.getState());
    useCanvasStore.getState().replaceProject(project);

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)).toMatchObject({
      width: 340,
      height: 191,
    });
  });

  it("restores an explicitly chosen aspect for an empty node after reload", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });
    const node = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)!;
    // 用户在面板里显式把画幅改为 9:16：标记 aspectExplicit 并改写几何。
    useCanvasStore.getState().updateNodeData(
      nodeId,
      {
        width: 191,
        height: 340,
        generation: {
          ...node.data.generation,
          modelId: "auto-model",
          parameters: { size: "9:16" },
          aspectExplicit: true,
        },
      },
      false,
    );

    const project = selectProject(useCanvasStore.getState());
    useCanvasStore.getState().replaceProject(project);

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)).toMatchObject({
      width: 191.25,
      height: 340,
    });
  });

  it("does not resize an empty node when automatic parameter sync carries a model default aspect", () => {
    useUiPreferencesStore.getState().setDefaultNodeAspectRatio("16:9");
    const nodeId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });

    useCanvasStore.getState().resizeMediaNodeForGenerationParameters(nodeId, { size: "9:16" });

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)).toMatchObject({
      width: 340,
      height: 191,
    });

    // 显式（force）路径仍然改写几何。
    useCanvasStore
      .getState()
      .resizeMediaNodeForGenerationParameters(nodeId, { size: "9:16" }, { force: true });

    expect(useCanvasStore.getState().nodes.find((item) => item.id === nodeId)).toMatchObject({
      width: 191.25,
      height: 340,
    });
  });

  it("scales every selected node uniformly around the selection center", () => {
    const a = createCanvasNode("image", { x: 0, y: 0 });
    a.id = "group-a";
    const b = createCanvasNode("text", { x: 600, y: 300 });
    b.id = "group-b";
    const outside = createCanvasNode("image", { x: 2_000, y: 2_000 });
    outside.id = "group-outside";
    a.selected = true;
    b.selected = true;
    outside.selected = false;
    useCanvasStore.setState({ nodes: [a, b, outside] });

    // 选区包围盒：x 0..908，y 0..476，中心 (454, 238)。
    useCanvasStore.getState().resizeNodeByFactor("group-a", 1.5);

    const scaledA = useCanvasStore.getState().nodes.find((item) => item.id === "group-a")!;
    const scaledB = useCanvasStore.getState().nodes.find((item) => item.id === "group-b")!;
    const untouched = useCanvasStore.getState().nodes.find((item) => item.id === "group-outside")!;

    expect(scaledA.width!).toBeCloseTo(340 * 1.5);
    expect(scaledA.height!).toBeCloseTo(191 * 1.5);
    expect(scaledA.position.x + scaledA.width! / 2).toBeCloseTo(454 + (170 - 454) * 1.5);
    expect(scaledA.position.y + scaledA.height! / 2).toBeCloseTo(238 + (95.5 - 238) * 1.5);

    expect(scaledB.width!).toBeCloseTo(308 * 1.5);
    expect(scaledB.height!).toBeCloseTo(176 * 1.5);
    expect(scaledB.position.x + scaledB.width! / 2).toBeCloseTo(454 + (754 - 454) * 1.5);
    expect(scaledB.position.y + scaledB.height! / 2).toBeCloseTo(238 + (388 - 238) * 1.5);

    // 未选中的节点不受影响。
    expect(untouched.width).toBe(340);
    expect(untouched.position).toEqual({ x: 2_000, y: 2_000 });
  });

  it("keeps single-node resize anchored at its own center", () => {
    const node = createCanvasNode("image", { x: 100, y: 200 });
    node.id = "solo-node";
    node.selected = true;
    useCanvasStore.setState({ nodes: [node] });

    useCanvasStore.getState().resizeNodeByFactor("solo-node", 2);

    const scaled = useCanvasStore.getState().nodes[0]!;
    expect(scaled.width!).toBeCloseTo(680);
    expect(scaled.height!).toBeCloseTo(382);
    expect(scaled.position.x + scaled.width! / 2).toBeCloseTo(100 + 170);
    expect(scaled.position.y + scaled.height! / 2).toBeCloseTo(200 + 95.5);
  });

  it("fits a new node to the real media ratio when media arrives later", () => {
    useUiPreferencesStore.getState().setDefaultNodeAspectRatio("9:16");
    const nodeId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });

    useCanvasStore.getState().setNodeMedia(
      nodeId,
      {
        id: "late-media",
        name: "late.png",
        mimeType: "image/png",
        size: 1,
        source: "server",
        serverId: "late-media",
        width: 1920,
        height: 1080,
        durationMs: null,
      },
      false,
    );

    expect(useCanvasStore.getState().nodes.find((node) => node.id === nodeId)).toMatchObject({
      width: 360,
      height: 203,
    });
  });

  it("does not overwrite an earlier media identity while projecting measured dimensions", () => {
    const nodeId = useCanvasStore.getState().addNode("image", { x: 0, y: 0 });
    const first = {
      id: "first-media",
      name: "first.png",
      mimeType: "image/png",
      size: 1,
      source: "local" as const,
      serverId: null,
      width: 120,
      height: 240,
      durationMs: null,
    };
    useCanvasStore.getState().setNodeMedia(nodeId, first);
    useCanvasStore.getState().setNodeMedia(nodeId, {
      id: "replacement-media",
      name: "replacement.png",
      mimeType: "image/png",
      size: 1,
      source: "local",
      serverId: null,
      width: null,
      height: null,
      durationMs: null,
    });
    useCanvasStore.getState().setNodeMedia(
      nodeId,
      {
        id: "replacement-media",
        name: "replacement.png",
        mimeType: "image/png",
        size: 1,
        source: "local",
        serverId: null,
        width: 300,
        height: 150,
        durationMs: null,
      },
      false,
    );

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data.media).toEqual(
      first,
    );
    useCanvasStore.getState().redo();
    expect(
      useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data.media,
    ).toMatchObject({
      id: "replacement-media",
      width: 300,
      height: 150,
    });
  });

  it("batches measured media dimensions while preserving undo snapshots", () => {
    const measured = createCanvasNode("image", { x: 0, y: 0 });
    measured.id = "measured";
    measured.data.media = {
      id: "measured-media",
      name: "measured.png",
      mimeType: "image/png",
      size: 1,
      source: "local",
      serverId: null,
      width: null,
      height: null,
      durationMs: null,
    };
    const untouched = createCanvasNode("image", { x: 360, y: 0 });
    untouched.id = "untouched";
    const historyNode = structuredClone(measured);
    useCanvasStore.setState({
      nodes: [measured, untouched],
      past: [{ nodes: [historyNode], edges: [], groups: [] }],
      future: [{ nodes: [structuredClone(historyNode)], edges: [], groups: [] }],
    });

    useCanvasStore.getState().setNodeMediaDimensions([
      {
        id: measured.id,
        mediaId: "measured-media",
        width: 1080,
        height: 1920,
      },
    ]);

    const state = useCanvasStore.getState();
    expect(state.nodes.find((node) => node.id === measured.id)?.data.media).toMatchObject({
      width: 1080,
      height: 1920,
    });
    expect(state.past[0]?.nodes[0]?.data.media).toMatchObject({ width: 1080, height: 1920 });
    expect(state.future[0]?.nodes[0]?.data.media).toMatchObject({ width: 1080, height: 1920 });
    expect(state.nodes.find((node) => node.id === untouched.id)).toBe(untouched);
  });

  it("keeps copied and restored node dimensions independent of the current default", () => {
    const original = createCanvasNode("image", { x: 0, y: 0 }, {}, "small");
    original.width = 301;
    original.height = 509;
    original.data.media = {
      id: "portrait-media",
      name: "portrait.png",
      mimeType: "image/png",
      size: 1,
      source: "local",
      serverId: null,
      width: 1080,
      height: 1920,
      durationMs: null,
    };
    original.data.status = "success";
    original.selected = true;
    useCanvasStore.setState({ nodes: [original] });
    const project = selectProject(useCanvasStore.getState());

    useUiPreferencesStore.getState().setDefaultNodeAspectRatio("3:4");
    useCanvasStore.getState().copySelection();
    useCanvasStore.getState().pasteSelection();
    expect(useCanvasStore.getState().nodes.at(-1)).toMatchObject({ width: 301, height: 509 });

    useCanvasStore.getState().replaceProject(project);
    expect(useCanvasStore.getState().nodes[0]).toMatchObject({ width: 301, height: 509 });
  });

  it("drops a queued position frame when replacing the current project", () => {
    const prior = createCanvasNode("text", { x: 0, y: 0 });
    prior.id = "shared-node";
    const replacement = createCanvasNode("text", { x: 80, y: 120 });
    replacement.id = "shared-node";
    let queuedFrame: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 7;
    });
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("window", { requestAnimationFrame, cancelAnimationFrame });

    try {
      useCanvasStore.setState({ nodes: [prior], edges: [], groups: [] });
      useCanvasStore.getState().onNodesChange([
        {
          id: prior.id,
          type: "position",
          position: { x: 640, y: 360 },
        },
      ]);
      expect(queuedFrame).not.toBeNull();

      useCanvasStore.getState().replaceProject({
        ...selectProject(useCanvasStore.getState()),
        id: "replacement-project",
        nodes: [replacement],
        edges: [],
        groups: [],
      });
      const pendingFrame = queuedFrame as FrameRequestCallback | null;
      pendingFrame?.(0);

      expect(cancelAnimationFrame).toHaveBeenCalledWith(7);
      expect(useCanvasStore.getState().nodes[0]?.position).toEqual({ x: 80, y: 120 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("evaluates a grouped position producer only once with the latest frame state", () => {
    const anchor = createCanvasNode("text", { x: 0, y: 0 });
    anchor.id = "group-anchor";
    const follower = createCanvasNode("text", { x: 40, y: 20 });
    follower.id = "group-follower";
    let queuedFrame: FrameRequestCallback | null = null;
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      queuedFrame = callback;
      return 11;
    });
    vi.stubGlobal("window", { requestAnimationFrame, cancelAnimationFrame: vi.fn() });

    try {
      useCanvasStore.setState({ nodes: [anchor, follower], edges: [], groups: [] });
      let latest = { x: 70, y: 50 };
      const producer = vi.fn(() => [
        {
          id: follower.id,
          type: "position" as const,
          position: latest,
        },
      ]);

      queueCanvasNodePositionChanges("group:anchor", producer);
      latest = { x: 110, y: 90 };
      queueCanvasNodePositionChanges("group:anchor", producer);

      expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
      expect(producer).not.toHaveBeenCalled();
      const pendingFrame = queuedFrame as FrameRequestCallback | null;
      pendingFrame?.(0);
      expect(producer).toHaveBeenCalledTimes(1);
      expect(
        useCanvasStore.getState().nodes.find((node) => node.id === follower.id)?.position,
      ).toEqual({ x: 110, y: 90 });
    } finally {
      useCanvasStore.getState().resetProject();
      vi.unstubAllGlobals();
    }
  });

  it("keeps a custom fitted size for media whose aspect ratio is clamped", () => {
    const original = createCanvasNode("image", { x: 0, y: 0 });
    original.width = 920;
    original.height = 360;
    original.data.media = {
      id: "ultrawide-media",
      name: "ultrawide.png",
      mimeType: "image/png",
      size: 1,
      source: "local",
      serverId: null,
      width: 10_000,
      height: 1_000,
      durationMs: null,
    };
    original.data.status = "success";
    const project = { ...selectProject(useCanvasStore.getState()), nodes: [original], edges: [] };

    useCanvasStore.getState().replaceProject(project);

    expect(useCanvasStore.getState().nodes[0]).toMatchObject({ width: 920, height: 360 });
  });

  it("applies a validated Agent action batch as one undo transaction", () => {
    const seed = createCanvasNode("text", { x: 0, y: 0 }, { body: "开场" });
    seed.id = "seed-node";
    seed.selected = false;
    useCanvasStore.setState({ nodes: [seed] });

    const result = useCanvasStore.getState().applyAgentActions([
      {
        type: "canvas_add_node",
        clientId: "next",
        kind: "text",
        body: "冲突升级",
        position: { x: 360, y: 0 },
      },
      { type: "canvas_connect_nodes", sourceNodeId: "seed-node", targetNodeId: "next" },
      { type: "canvas_group_nodes", nodeIds: ["seed-node", "next"], name: "第一场" },
      { type: "canvas_set_viewport", viewport: { x: 40, y: 60, zoom: 1.1 } },
    ]);

    expect(result).toMatchObject({ applied: 4, skipped: 0 });
    expect(result.createdNodeIds.next).toBeTruthy();
    expect(useCanvasStore.getState().nodes.map((node) => node.data.body)).toEqual([
      "开场",
      "冲突升级",
    ]);
    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().groups[0]).toMatchObject({
      name: "第一场",
      nodeIds: ["seed-node", result.createdNodeIds.next],
    });
    expect(useCanvasStore.getState().viewport).toEqual({ x: 40, y: 60, zoom: 1.1 });
    expect(useCanvasStore.getState().past).toHaveLength(1);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes).toHaveLength(1);
  });

  it("does not return to saving when an edit transaction commits after persistence", () => {
    const node = createCanvasNode("text", { x: 0, y: 0 });
    useCanvasStore.setState({ nodes: [node] });
    useCanvasStore.getState().beginTransaction();
    useCanvasStore.getState().updateNodeData(node.id, { body: "已编辑" }, false);

    useCanvasStore.getState().setSaveState("saved", Date.now());
    useCanvasStore.getState().commitTransaction();

    expect(useCanvasStore.getState().saveState).toBe("saved");
    expect(useCanvasStore.getState().past).toHaveLength(1);
  });

  it("skips full graph snapshots for non-recorded hot-path updates", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });
    useCanvasStore.setState({ nodes: [node] });
    const clone = vi.spyOn(globalThis, "structuredClone");

    useCanvasStore.getState().updateNodeData(node.id, { body: "draft" }, false);
    useCanvasStore.getState().setNodeMedia(
      node.id,
      {
        id: "draft-media",
        name: "draft.png",
        mimeType: "image/png",
        size: 1,
        source: "local",
        serverId: null,
        width: 1,
        height: 1,
        durationMs: null,
      },
      false,
    );

    expect(clone).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().nodes[0]?.data.body).toBe("draft");
    expect(useCanvasStore.getState().nodes[0]?.data.media?.id).toBe("draft-media");
    expect(useCanvasStore.getState().past).toHaveLength(0);
    clone.mockRestore();
  });

  it("defers history cloning until a changed gesture commits", () => {
    const node = createCanvasNode("text", { x: 0, y: 0 });
    useCanvasStore.setState({ nodes: [node] });
    const clone = vi.spyOn(globalThis, "structuredClone");

    useCanvasStore.getState().beginTransaction();
    expect(clone).not.toHaveBeenCalled();

    useCanvasStore.getState().updateNodeData(node.id, { body: "gesture draft" }, false);
    useCanvasStore.getState().commitTransaction();

    expect(clone).toHaveBeenCalledTimes(1);
    expect(useCanvasStore.getState().past).toHaveLength(1);
    clone.mockRestore();
  });

  it("ignores transient selection changes when a gesture commits", () => {
    const node = createCanvasNode("text", { x: 0, y: 0 });
    useCanvasStore.setState({ nodes: [node] });

    useCanvasStore.getState().beginTransaction();
    useCanvasStore.getState().onNodesChange([{ id: node.id, type: "select", selected: true }]);
    useCanvasStore.getState().commitTransaction();

    expect(useCanvasStore.getState().past).toHaveLength(0);
    expect(useCanvasStore.getState().transactionBase).toBeNull();
  });

  it("commits and undoes a position gesture without serializing the full graph", () => {
    const node = createCanvasNode("text", { x: 0, y: 0 });
    useCanvasStore.setState({ nodes: [node] });
    const stringify = vi.spyOn(JSON, "stringify");

    useCanvasStore.getState().beginTransaction();
    useCanvasStore.getState().onNodesChange([
      {
        id: node.id,
        type: "position",
        position: { x: 80, y: 48 },
        dragging: true,
      },
    ]);
    expect(useCanvasStore.getState().nodes[0]?.position).toEqual({ x: 0, y: 0 });
    useCanvasStore.getState().commitTransaction();

    expect(stringify).not.toHaveBeenCalled();
    expect(useCanvasStore.getState().past).toHaveLength(1);
    expect(useCanvasStore.getState().nodes[0]?.position).toEqual({ x: 80, y: 48 });
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes[0]?.position).toEqual({ x: 0, y: 0 });
    stringify.mockRestore();
  });

  it("keeps undo history references stable during repeated generation progress", () => {
    const node = createCanvasNode("image", { x: 0, y: 0 });
    node.id = "progress-node";
    node.data.status = "running";
    node.data.generation = {
      ...node.data.generation,
      jobId: "progress-job",
      jobStatus: "running",
    };
    const historySnapshot = { nodes: [structuredClone(node)], edges: [], groups: [] };
    const history = [historySnapshot];
    const futureSnapshot = { nodes: [structuredClone(node)], edges: [], groups: [] };
    const future = [futureSnapshot];
    let historyWasRead = false;
    let futureWasRead = false;
    // 读取索引即表示热路径错误地扫描了历史栈。
    Object.defineProperty(history, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        historyWasRead = true;
        return historySnapshot;
      },
    });
    Object.defineProperty(future, 0, {
      configurable: true,
      enumerable: true,
      get: () => {
        futureWasRead = true;
        return futureSnapshot;
      },
    });
    useCanvasStore.setState({ nodes: [node], past: history, future });

    useCanvasStore.getState().applyGenerationUpdate(node.id, { progress: 42 });
    const afterFirstProgress = useCanvasStore.getState();
    useCanvasStore.getState().applyGenerationUpdate(node.id, { progress: 43 });

    expect(afterFirstProgress.past).toBe(history);
    expect(useCanvasStore.getState().past).toBe(history);
    expect(useCanvasStore.getState().future).toBe(future);
    expect(useCanvasStore.getState().nodes[0]?.data.progress).toBe(43);
    expect(historyWasRead).toBe(false);
    expect(futureWasRead).toBe(false);
  });

  it("does not reconcile graph bindings for edge selection changes", () => {
    const source = createCanvasNode("text", { x: 0, y: 0 });
    const target = createCanvasNode("text", { x: 360, y: 0 });
    const edge = { id: "selection-edge", source: source.id, target: target.id, selected: false };
    useCanvasStore.setState({ nodes: [source, target], edges: [edge] });
    const nodesBefore = useCanvasStore.getState().nodes;

    useCanvasStore.getState().onEdgesChange([{ id: edge.id, type: "select", selected: true }]);

    expect(useCanvasStore.getState().nodes).toBe(nodesBefore);
    expect(useCanvasStore.getState().edges[0]?.selected).toBe(true);
  });

  it("prioritizes a selected connection so deletion keeps both endpoint nodes", () => {
    const source = createCanvasNode("text", { x: 0, y: 0 });
    const target = createCanvasNode("image", { x: 360, y: 0 });
    source.selected = true;
    const edge = { id: "selection-edge", source: source.id, target: target.id, selected: true };
    useCanvasStore.setState({ nodes: [source, target], edges: [edge] });

    useCanvasStore.getState().deleteSelection();

    expect(useCanvasStore.getState().nodes).toHaveLength(2);
    expect(useCanvasStore.getState().edges).toEqual([]);
  });

  it("groups only ungrouped selections and can ungroup from any selected member", () => {
    const first = createCanvasNode("text", { x: 0, y: 0 });
    const second = createCanvasNode("image", { x: 360, y: 0 });
    const third = createCanvasNode("video", { x: 720, y: 0 });
    first.selected = true;
    second.selected = true;
    useCanvasStore.setState({ nodes: [first, second, third] });

    const groupId = useCanvasStore.getState().groupSelection();
    expect(groupId).toBeTruthy();
    expect(useCanvasStore.getState().groups).toHaveLength(1);

    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({
        ...node,
        selected: node.id === first.id || node.id === third.id,
      })),
    }));
    expect(useCanvasStore.getState().groupSelection()).toBeNull();

    useCanvasStore.setState((state) => ({
      nodes: state.nodes.map((node) => ({ ...node, selected: node.id === first.id })),
    }));
    useCanvasStore.getState().ungroupSelection();
    expect(useCanvasStore.getState().groups).toHaveLength(0);
    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().groups).toHaveLength(1);
  });

  it("clears the graph as one undoable operation", () => {
    const first = createCanvasNode("text", { x: 0, y: 0 });
    const second = createCanvasNode("image", { x: 360, y: 0 });
    useCanvasStore.setState({ nodes: [first, second] });

    useCanvasStore.getState().clearCanvas();
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    expect(useCanvasStore.getState().past).toHaveLength(1);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes).toHaveLength(2);
  });

  it("keeps a newer primary result while appending late older artifacts once", () => {
    const origin = createCanvasNode("image", { x: 0, y: 0 });
    origin.id = "origin";
    useCanvasStore.setState({ nodes: [origin], projectId: "project-test" });

    const newer = generationJob("job-new", "2026-07-15T10:00:02.000Z", [imageArtifact("new")]);
    const older = generationJob("job-old", "2026-07-15T10:00:01.000Z", [
      imageArtifact("old-1"),
      imageArtifact("old-2"),
    ]);

    useCanvasStore.getState().applyGenerationJob(newer);
    useCanvasStore.getState().applyGenerationJob(older);
    useCanvasStore.getState().applyGenerationJob(older);

    const state = useCanvasStore.getState();
    expect(state.nodes.find((node) => node.id === "origin")?.data.media?.id).toBe("new");
    expect(
      state.nodes
        .map((node) => node.data.media?.id)
        .filter(Boolean)
        .sort(),
    ).toEqual(["new", "old-1", "old-2"]);
    expect(state.edges).toHaveLength(2);
  });

  it("shows an ambiguous submission as an explicit error while it is reconciled", () => {
    const origin = createCanvasNode("image", { x: 0, y: 0 });
    origin.id = "origin";
    useCanvasStore.setState({ nodes: [origin], projectId: "project-test" });
    const unknown: PublicGenerationJob = {
      ...generationJob("job-unknown", "2026-07-15T10:00:00.000Z", []),
      status: "submission_unknown",
      progress: 0,
      error: {
        code: "GENERATION_SUBMISSION_UNCONFIRMED",
        message: "任务提交结果待确认，请勿重复生成",
        retryable: false,
      },
      completedAt: null,
    };

    useCanvasStore.getState().applyGenerationJob(unknown);

    const node = useCanvasStore.getState().nodes.find((item) => item.id === origin.id);
    expect(node?.data.status).toBe("error");
    expect(node?.data.progress).toBeNull();
    expect(node?.data.generation).toMatchObject({
      jobId: unknown.id,
      jobStatus: "submission_unknown",
      error: "任务提交结果待确认，请勿重复生成",
    });
  });

  it("does not revive an explicitly deleted generation while undoing another transaction", () => {
    const origin = createCanvasNode("image", { x: 0, y: 0 });
    origin.id = "origin";
    const companion = createCanvasNode("text", { x: 360, y: 0 }, { body: "原始文本" });
    companion.id = "companion";
    useCanvasStore.setState({ nodes: [origin, companion], projectId: "project-test" });

    useCanvasStore.getState().applyGenerationUpdate(origin.id, {
      status: "running",
      generation: {
        ...origin.data.generation,
        jobId: "job-hidden",
        jobStatus: "running",
      },
    });
    useCanvasStore.getState().deleteNode(origin.id);
    useCanvasStore.getState().beginTransaction();
    const transactionBase = useCanvasStore.getState().transactionBase;
    useCanvasStore.getState().updateNodeData(companion.id, { body: "拖动后的编辑" }, false);
    useCanvasStore
      .getState()
      .applyGenerationJob(
        generationJob("job-hidden", "2026-07-15T10:00:00.000Z", [imageArtifact("hidden")]),
      );
    expect(useCanvasStore.getState().transactionBase).toBe(transactionBase);
    useCanvasStore.getState().commitTransaction();

    useCanvasStore.getState().undo();

    const state = useCanvasStore.getState();
    expect(state.nodes.some((node) => node.id === origin.id)).toBe(false);
    expect(state.nodes.find((node) => node.id === companion.id)?.data.body).toBe("原始文本");
  });
});

describe("empty new-project invariant", () => {
  it("resetProject creates a schema-valid empty project with clean history", () => {
    const seed = createCanvasNode("text", { x: 0, y: 0 }, { body: "旧内容" });
    seed.id = "seed";
    useCanvasStore.setState({
      projectId: "old-project",
      projectName: "旧画布",
      createdAt: 1,
      nodes: [seed],
      edges: [{ id: "old-edge", source: "seed", target: "seed" }],
      groups: [
        {
          id: "old-group",
          name: "旧组合",
          color: "#7dd3a8",
          nodeIds: ["seed"],
          frame: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      past: [{ nodes: [seed], edges: [], groups: [] }],
      future: [{ nodes: [], edges: [], groups: [] }],
      transactionBase: { nodes: [seed], edges: [], groups: [] },
      viewport: { x: 10, y: 20, zoom: 1.5 },
    });

    useCanvasStore.getState().resetProject();

    const state = useCanvasStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.transactionBase).toBeNull();
    expect(state.projectId).not.toBe("old-project");
    expect(state.projectName).toBe("纬线 1");
    expect(state.createdAt).toBeGreaterThan(0);
    expect(state.viewport).toEqual({ x: 720, y: 450, zoom: 0.7 });
    expect(state.saveState).toBe("saving");

    const project = selectProject(state);
    expect(project).toMatchObject({
      id: state.projectId,
      name: "纬线 1",
      nodes: [],
      edges: [],
      groups: [],
      viewport: { x: 720, y: 450, zoom: 0.7 },
    });
    expect(project.schemaVersion).toBe(1);
  });

  it("resetProject accepts an explicit project name", () => {
    useCanvasStore.getState().resetProject("我的新画布");

    const state = useCanvasStore.getState();
    expect(state.nodes).toEqual([]);
    expect(state.edges).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(state.projectName).toBe("我的新画布");
  });

  it("addNode keeps working from the empty project without a starter anchor", () => {
    useCanvasStore.getState().resetProject("空画布");

    const nodeId = useCanvasStore.getState().addNode("text", { x: 320, y: 180 });

    const state = useCanvasStore.getState();
    expect(state.nodes).toHaveLength(1);
    expect(state.nodes[0]?.id).toBe(nodeId);
    expect(state.nodes[0]?.position).toEqual({ x: 320, y: 180 });
    expect(state.nodes[0]?.selected).toBe(true);
    expect(state.nodes[0]?.data.kind).toBe("text");
    expect(state.edges).toEqual([]);
    expect(state.groups).toEqual([]);
    expect(state.past).toHaveLength(1);
    expect(state.future).toEqual([]);
  });

  it("uses the neutral 0.7 empty-project viewport centered on the flow origin", () => {
    const viewport = useCanvasStore.getState().viewport;
    expect(viewport.zoom).toBe(0.7);
    expect(viewport.x).toBe(Math.round(1440 / 2));
    expect(viewport.y).toBe(Math.round(900 / 2));

    useCanvasStore.getState().resetProject();
    expect(useCanvasStore.getState().viewport).toEqual({ x: 720, y: 450, zoom: 0.7 });
  });

  it("preserves the saved viewport and intentionally resized dimensions of existing projects exactly", () => {
    const legacy = createCanvasNode(
      "image",
      { x: 0, y: 0 },
      {
        status: "success",
        media: {
          id: "legacy-media",
          name: "legacy.png",
          mimeType: "image/png",
          size: 1,
          source: "local",
          serverId: null,
          width: 1920,
          height: 1080,
          durationMs: null,
        },
      },
      "16:9",
      6,
    );
    legacy.id = "legacy-node";
    useCanvasStore.getState().replaceProject({
      schemaVersion: 1,
      id: "legacy-project",
      name: "旧画布",
      nodes: [legacy],
      edges: [],
      groups: [],
      viewport: { x: 185, y: 138, zoom: 0.9 },
      createdAt: 1,
      updatedAt: 1,
    });

    const state = useCanvasStore.getState();
    expect(state.viewport).toEqual({ x: 185, y: 138, zoom: 0.9 });
    expect(state.nodes[0]).toMatchObject({ width: 2040, height: 1146, position: { x: 0, y: 0 } });
  });

  it("captures director images at stable intrinsic dimensions at an overview viewport", () => {
    useCanvasStore.getState().setViewport({ x: 0, y: 0, zoom: 0.1 });
    const [captureId] = useCanvasStore.getState().addCapturedImages([
      {
        position: { x: 0, y: 0 },
        body: "镜头一",
        media: {
          id: "capture-media",
          name: "shot.png",
          mimeType: "image/png",
          size: 1,
          source: "local",
          serverId: null,
          width: 1280,
          height: 720,
          durationMs: null,
        },
        directorCapture: {
          shotId: "shot-1",
          slot: 1,
          prompt: "",
        },
      },
    ]);

    expect(useCanvasStore.getState().nodes.find((node) => node.id === captureId)).toMatchObject({
      width: 360,
      height: 203,
    });
  });
});

function targetRatio(id: string) {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === id)!;
  return node.width! / node.height!;
}

function referenceGraph(): WeftcanvasNode[] {
  const reference = createCanvasNode(
    "image",
    { x: 0, y: 0 },
    {
      media: {
        id: "reference-media",
        name: "reference.png",
        mimeType: "image/png",
        size: 1,
        source: "server",
        serverId: null,
        width: 1,
        height: 1,
        durationMs: null,
      },
    },
  );
  reference.id = "reference";
  const target = createCanvasNode("video", { x: 400, y: 0 });
  target.id = "target";
  target.data.body = "@图片1";
  target.data.generation.referenceMode = "explicit";
  target.data.generation.referenceNodeIds = [reference.id];
  target.data.generation.referenceImagePurposes = { "reference-media": "styleImages" };
  reference.selected = false;
  target.selected = false;
  return [reference, target];
}

function expectSelectedCopyToReferenceSelectedImage() {
  const selected = useCanvasStore.getState().nodes.filter((node) => node.selected);
  const selectedImage = selected.find((node) => node.data.kind === "image");
  const selectedVideo = selected.find((node) => node.data.kind === "video");
  expect(selected).toHaveLength(2);
  expect(selectedImage?.id).toBeTruthy();
  expect(selectedVideo?.data.generation.referenceNodeIds).toEqual([selectedImage?.id]);
  expect(selectedVideo?.data.generation.referenceImagePurposes).toEqual({
    "reference-media": "styleImages",
  });
}

function assertReusableGraph({ expectTwoCopies }: { expectTwoCopies: boolean }) {
  const state = useCanvasStore.getState();
  const selected = state.nodes.filter((node) => node.selected);
  expect(selected).toHaveLength(2);
  const sourceCopies = selected.filter((node) => node.data.body === "image prompt");
  const targetCopies = selected.filter((node) => node.data.body === "video prompt");
  expect(sourceCopies).toHaveLength(1);
  expect(targetCopies).toHaveLength(1);
  const sourceCopy = sourceCopies[0]!;
  const targetCopy = targetCopies[0]!;
  expect(sourceCopy.data.status).toBe("idle");
  expect(sourceCopy.data.media).toBeNull();
  expect(sourceCopy.data.progress).toBeNull();
  expect(sourceCopy.data.generation).toMatchObject({
    modelId: "image-model",
    parameters: { aspect_ratio: "16:9" },
    referenceImagePurposes: { "old-media": "styleImages" },
    maxOutputTokens: 2048,
    referenceMode: "explicit",
    referenceNodeIds: [targetCopy.id],
    jobId: null,
    jobVersion: null,
    jobCreatedAt: null,
    jobStatus: null,
    error: null,
  });
  expect((sourceCopy.data.generation as Record<string, unknown>).artifactId).toBeUndefined();
  expect((sourceCopy.data.generation as Record<string, unknown>).submissionKey).toBeUndefined();
  expect(
    state.edges.filter((edge) => edge.source === sourceCopy.id && edge.target === targetCopy.id),
  ).toHaveLength(1);
  if (expectTwoCopies) {
    expect(state.nodes).toHaveLength(4);
    expect(state.edges).toHaveLength(2);
  }
}

function generationJob(
  id: string,
  createdAt: string,
  artifacts: PublicGenerationJob["artifacts"],
): PublicGenerationJob {
  return {
    schemaVersion: 1,
    version: 2,
    id,
    projectId: "project-test",
    nodeId: "origin",
    modelId: "image-model",
    modelLabel: "图片模型",
    modality: "image",
    status: "completed",
    progress: 100,
    quote: {
      id: `quote-${id}`,
      modelId: "image-model",
      modelLabel: "图片模型",
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
      expiresAt: "2026-07-15T11:00:00.000Z",
    },
    artifacts,
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: createdAt,
  };
}

function imageArtifact(id: string): PublicGenerationJob["artifacts"][number] {
  return {
    id: `artifact-${id}`,
    kind: "image",
    mediaId: id,
    name: `${id}.png`,
    mimeType: "image/png",
    size: 1,
    width: 1,
    height: 1,
    createdAt: "2026-07-15T10:00:00.000Z",
  };
}
