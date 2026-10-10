import { LayoutGrid, MousePointerClick, Waypoints } from "lucide-react";
import { memo } from "react";

import { useCanvasStore } from "../state/canvas-store";

/**
 * Quiet first-run guidance for an empty canvas. Renders only while the
 * project has no nodes, edges, or groups, never intercepts pointer input,
 * and disappears as soon as the user adds the first piece of content.
 */
export const EmptyCanvasHint = memo(function EmptyCanvasHint() {
  const isEmpty = useCanvasStore(
    (state) => state.nodes.length === 0 && state.edges.length === 0 && state.groups.length === 0,
  );
  if (!isEmpty) return null;
  return (
    <section className="kc-empty-canvas-hint" role="note" aria-label="空白画布提示">
      <strong>画布还是空的</strong>
      <p>在空白处双击即可创建节点，也可以从左侧「创建工具」加入；拖动节点两侧的圆点就能连成关系。</p>
      <div className="kc-empty-canvas-hint-steps" aria-hidden="true">
        <span><MousePointerClick />双击创建</span>
        <i />
        <span><Waypoints />连接关系</span>
        <i />
        <span><LayoutGrid />拖动布局</span>
      </div>
    </section>
  );
});
