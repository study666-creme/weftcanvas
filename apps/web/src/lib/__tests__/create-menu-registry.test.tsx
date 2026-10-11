import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FileText } from "lucide-react";
import type { CanvasNodeKind } from "@kachang/contracts";

import { registerNode, type NodeDefinition } from "../node-registry";
import "../builtin-nodes";
import { ConnectionCreateMenu } from "../../components/connection-create-menu";

beforeEach(() => {
  vi.stubGlobal("window", { innerWidth: 1600, innerHeight: 900 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const pending = {
  anchorId: "anchor",
  side: "right" as const,
  flowPosition: { x: 0, y: 0 },
  clientPosition: { x: 100, y: 100 },
  zoom: 1,
};

const demoDefinition: NodeDefinition = {
  kind: "spec-menu-demo" as CanvasNodeKind,
  label: () => "演示节点",
  icon: FileText,
  accent: "jade",
  createDraft: () => ({ kind: "spec-menu-demo" as CanvasNodeKind, width: 100, height: 80 }),
};

describe("create menu reads the node registry", () => {
  it("shows a node only while it is registered", () => {
    const unregister = registerNode(demoDefinition);
    const withDemo = renderToStaticMarkup(
      <ConnectionCreateMenu pending={pending} onCreate={() => {}} onClose={() => {}} />,
    );
    expect(withDemo).toContain("演示节点");
    unregister();

    const withoutDemo = renderToStaticMarkup(
      <ConnectionCreateMenu pending={pending} onCreate={() => {}} onClose={() => {}} />,
    );
    expect(withoutDemo).not.toContain("演示节点");
  });

  it("still lists every builtin kind", () => {
    const markup = renderToStaticMarkup(
      <ConnectionCreateMenu pending={pending} onCreate={() => {}} onClose={() => {}} />,
    );
    for (const label of ["文本", "图片", "视频", "音频", "配置", "剪辑"]) {
      expect(markup).toContain(label);
    }
  });
});
