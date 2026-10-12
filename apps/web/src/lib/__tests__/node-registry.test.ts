import { describe, expect, it } from "vitest";

import { builtinCanvasNodeKinds, type CanvasNodeKind } from "@weftcanvas/contracts";
import { FileText } from "lucide-react";

import "../builtin-nodes";
import { connectionPolicyAllows } from "../canvas-connection-rules";
import { createCanvasNode, nodeDefaultDimensions } from "../node-factory";
import {
  getNodeDefinition,
  listCreatableNodes,
  listNodes,
  nodeLabel,
  registerNode,
  type NodeDefinition,
} from "../node-registry";
import type { WeftcanvasNode } from "../../types";

/** 测试用演示定义：kind 不在闭合枚举里，注册表/菜单层面的行为与正式节点一致。 */
function demoDefinition(kind: string, overrides: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    kind: kind as CanvasNodeKind,
    label: () => "演示节点",
    icon: FileText,
    accent: "jade",
    createDraft: () => ({ kind: kind as CanvasNodeKind, width: 100, height: 80 }),
    ...overrides,
  };
}

function nodeFixture(id: string, kind: CanvasNodeKind): WeftcanvasNode {
  return { id, data: { kind } } as WeftcanvasNode;
}

describe("node registry builtins", () => {
  it("registers every contracts node kind", () => {
    for (const kind of builtinCanvasNodeKinds) {
      expect(getNodeDefinition(kind), kind).not.toBeNull();
    }
  });

  it("keeps builtin labels identical to the contracts labels", () => {
    for (const definition of listNodes()) {
      expect(definition.label()).toBe(nodeLabel(definition.kind));
    }
    expect(nodeLabel("text")).toBe("文本节点");
    expect(nodeLabel("not-a-kind")).toBe("not-a-kind");
  });

  it("keeps builtin creation drafts behavior-compatible with the old factory defaults", () => {
    expect(nodeDefaultDimensions("text", "16:9")).toEqual({ width: 308, height: 176 });
    expect(nodeDefaultDimensions("text", "large")).toEqual({ width: 370, height: 211 });
    expect(nodeDefaultDimensions("image", "16:9")).toEqual({ width: 340, height: 191 });
    expect(nodeDefaultDimensions("image", "9:16")).toEqual({ width: 191, height: 340 });
    expect(nodeDefaultDimensions("video", "1:1")).toEqual({ width: 340, height: 340 });
    expect(nodeDefaultDimensions("audio", "16:9")).toEqual({ width: 340, height: 164 });
    expect(nodeDefaultDimensions("config", "16:9")).toEqual({ width: 308, height: 176 });
    expect(nodeDefaultDimensions("edit", "16:9")).toEqual({ width: 340, height: 192 });

    const text = createCanvasNode("text", { x: 0, y: 0 });
    expect(text.data).toMatchObject({ kind: "text", accent: "jade", config: null, edit: null });
    const image = createCanvasNode("image", { x: 0, y: 0 });
    expect(image.data).toMatchObject({ kind: "image", accent: "blue", config: null, edit: null });
    const config = createCanvasNode("config", { x: 0, y: 0 });
    expect(config.data).toMatchObject({
      kind: "config",
      accent: "jade",
      config: { modality: "image" },
      edit: null,
    });
    const edit = createCanvasNode("edit", { x: 0, y: 0 });
    expect(edit.data).toMatchObject({
      kind: "edit",
      accent: "blue",
      config: null,
      edit: { clips: [] },
    });
  });

  it("marks the edit node creatable while the clip editor flag is on", () => {
    const creatableKinds = listCreatableNodes().map((definition) => definition.kind);
    expect(creatableKinds).toContain("edit");
  });
});

describe("node registry dynamics", () => {
  it("unregistering removes the definition from both lists", () => {
    const unregister = registerNode(demoDefinition("spec-removable"));
    expect(getNodeDefinition("spec-removable")).not.toBeNull();
    expect(
      listCreatableNodes().some((definition) => (definition.kind as string) === "spec-removable"),
    ).toBe(true);
    unregister();
    expect(getNodeDefinition("spec-removable")).toBeNull();
    expect(
      listCreatableNodes().some((definition) => (definition.kind as string) === "spec-removable"),
    ).toBe(false);
  });

  it("rejects duplicate kind registration instead of silently overriding", () => {
    const unregister = registerNode(demoDefinition("spec-duplicate"));
    expect(() => registerNode(demoDefinition("spec-duplicate"))).toThrow(/spec-duplicate/);
    unregister();
    expect(() => registerNode(demoDefinition("spec-duplicate"))).not.toThrow();
  });

  it("honours creatable: false without touching rendering eligibility", () => {
    const unregister = registerNode(demoDefinition("spec-hidden", { creatable: false }));
    expect(getNodeDefinition("spec-hidden")).not.toBeNull();
    expect(
      listCreatableNodes().some((definition) => (definition.kind as string) === "spec-hidden"),
    ).toBe(false);
    expect(listNodes().some((definition) => (definition.kind as string) === "spec-hidden")).toBe(
      true,
    );
    unregister();
  });
});

describe("connection policy", () => {
  it("falls back to the global rule when no definition declares a policy", () => {
    const nodes = [nodeFixture("a", "text"), nodeFixture("b", "image")];
    expect(
      connectionPolicyAllows(
        { sourceId: "a", targetId: "b", sourceHandle: null, targetHandle: null },
        nodes,
      ),
    ).toBe(true);
  });

  it("consults the source and target definition policies", () => {
    const sourceUnregister = registerNode(
      demoDefinition("spec-policy-source", {
        connectionPolicy: (ctx) => ctx.targetKind !== ("spec-policy-forbidden" as CanvasNodeKind),
      }),
    );
    const targetUnregister = registerNode(demoDefinition("spec-policy-forbidden"));
    const nodes = [
      nodeFixture("a", "spec-policy-source" as CanvasNodeKind),
      nodeFixture("b", "spec-policy-forbidden" as CanvasNodeKind),
      nodeFixture("c", "text"),
    ];
    expect(
      connectionPolicyAllows(
        { sourceId: "a", targetId: "b", sourceHandle: null, targetHandle: null },
        nodes,
      ),
    ).toBe(false);
    expect(
      connectionPolicyAllows(
        { sourceId: "a", targetId: "c", sourceHandle: null, targetHandle: null },
        nodes,
      ),
    ).toBe(true);
    sourceUnregister();
    targetUnregister();
  });

  it("skips policy checks when an endpoint is missing from the graph", () => {
    expect(
      connectionPolicyAllows(
        { sourceId: "ghost", targetId: "a", sourceHandle: null, targetHandle: null },
        [nodeFixture("a", "text")],
      ),
    ).toBe(true);
  });
});
