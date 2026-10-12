import type { WeftcanvasEdge, WeftcanvasNode } from "../types";

type CanvasContentGraph = {
  nodes: WeftcanvasNode[];
  edges: WeftcanvasEdge[];
};

let cachedGraph: CanvasContentGraph | null = null;
let lastInputNodes: WeftcanvasNode[] | null = null;
let lastInputEdges: WeftcanvasEdge[] | null = null;
let lastResult: CanvasContentGraph | null = null;

/**
 * 只投影影响节点内容和连线拓扑的字段，拖拽坐标与选中态变化不会让下游面板重复计算。
 */
export function selectCanvasContentGraph(state: CanvasContentGraph): CanvasContentGraph {
  if (state.nodes === lastInputNodes && state.edges === lastInputEdges && lastResult) {
    return lastResult;
  }

  lastInputNodes = state.nodes;
  lastInputEdges = state.edges;
  if (
    cachedGraph &&
    sameNodeContent(state.nodes, cachedGraph.nodes) &&
    sameEdgeTopology(state.edges, cachedGraph.edges)
  ) {
    lastResult = cachedGraph;
    return lastResult;
  }
  cachedGraph = { nodes: state.nodes, edges: state.edges };
  lastResult = cachedGraph;
  return lastResult;
}

/**
 * 节点位置、尺寸和选中状态属于布局信息；这里仅比较会改变创作内容的节点标识与数据引用。
 */
function sameNodeContent(current: WeftcanvasNode[], previous: WeftcanvasNode[]) {
  if (current === previous) return true;
  if (current.length !== previous.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    const currentNode = current[index]!;
    const previousNode = previous[index]!;
    if (currentNode.id !== previousNode.id || currentNode.data !== previousNode.data) return false;
  }
  return true;
}

/**
 * 连线展示状态变化不影响配置来源，只有端点和句柄变化才需要刷新内容图。
 */
function sameEdgeTopology(current: WeftcanvasEdge[], previous: WeftcanvasEdge[]) {
  if (current === previous) return true;
  if (current.length !== previous.length) return false;
  for (let index = 0; index < current.length; index += 1) {
    const currentEdge = current[index]!;
    const previousEdge = previous[index]!;
    if (
      currentEdge.id !== previousEdge.id ||
      currentEdge.source !== previousEdge.source ||
      currentEdge.target !== previousEdge.target ||
      currentEdge.sourceHandle !== previousEdge.sourceHandle ||
      currentEdge.targetHandle !== previousEdge.targetHandle
    )
      return false;
  }
  return true;
}
