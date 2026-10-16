import { beforeEach, describe, expect, it } from "vitest";

import { useCanvasStore } from "./canvas-store";
import { useUiPreferencesStore } from "./ui-preferences-store";

/**
 * 整块插入（第三方画布导入）：节点与连线一次落盘、id 由 store 分配、
 * 连线按下标接回新节点，整块只占一条撤销记录。
 */
describe("addImportedGraph", () => {
  beforeEach(() => {
    useUiPreferencesStore.getState().setDefaultNodeAspectRatio("16:9");
    useCanvasStore.setState({
      projectId: "import-project",
      projectName: "导入测试",
      nodes: [],
      edges: [],
      groups: [],
      past: [],
      future: [],
      transactionBase: null,
      clipboard: null,
      activeToolbarNodeId: null,
      saveState: "saved",
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it("一次插入节点与连线，尺寸按来源保留", () => {
    const ids = useCanvasStore.getState().addImportedGraph(
      [
        {
          kind: "text",
          position: { x: 100, y: 100 },
          width: 300,
          height: 180,
          data: { body: "深夜的医院走廊" },
        },
        {
          kind: "image",
          position: { x: 500, y: 100 },
          width: 360,
          height: 540,
          data: { body: "深夜医院" },
        },
      ],
      [{ sourceIndex: 0, targetIndex: 1 }],
    );

    const state = useCanvasStore.getState();
    expect(ids).toHaveLength(2);
    expect(state.nodes.map((node) => node.id)).toEqual(ids);
    expect(state.nodes[0]).toMatchObject({ position: { x: 100, y: 100 }, width: 300, height: 180 });
    expect(state.nodes[1]).toMatchObject({ width: 360, height: 540 });
    expect(state.nodes[0]?.data.body).toBe("深夜的医院走廊");
    expect(state.edges).toHaveLength(1);
    expect(state.edges[0]).toMatchObject({ source: ids[0], target: ids[1] });
    expect(state.saveState).toBe("saving");
  });

  it("越界下标、自连与重复连线都被丢掉", () => {
    const ids = useCanvasStore.getState().addImportedGraph(
      [
        { kind: "text", position: { x: 0, y: 0 } },
        { kind: "image", position: { x: 400, y: 0 } },
      ],
      [
        { sourceIndex: 0, targetIndex: 1 },
        { sourceIndex: 0, targetIndex: 1 },
        { sourceIndex: 0, targetIndex: 0 },
        { sourceIndex: 0, targetIndex: 7 },
        { sourceIndex: 5, targetIndex: 1 },
      ],
    );
    expect(ids).toHaveLength(2);
    expect(useCanvasStore.getState().edges).toHaveLength(1);
  });

  it("空输入不产生历史记录，一次撤销整块回退", () => {
    expect(useCanvasStore.getState().addImportedGraph([], [])).toEqual([]);
    expect(useCanvasStore.getState().past).toHaveLength(0);

    const ids = useCanvasStore.getState().addImportedGraph(
      [
        { kind: "text", position: { x: 0, y: 0 } },
        { kind: "text", position: { x: 300, y: 0 } },
      ],
      [{ sourceIndex: 0, targetIndex: 1 }],
    );
    expect(ids).toHaveLength(2);
    expect(useCanvasStore.getState().past).toHaveLength(1);
    expect(useCanvasStore.getState().edges).toHaveLength(1);

    useCanvasStore.getState().undo();
    expect(useCanvasStore.getState().nodes).toHaveLength(0);
    expect(useCanvasStore.getState().edges).toHaveLength(0);
  });
});
