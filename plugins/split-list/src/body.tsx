import { useMemo } from "react";

import type { PluginNodeBodyProps } from "@weftcanvas/plugin-sdk";

const MAX_ROWS = 20;

function splitLines(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 节点是预览：这里只读展示清单 + 一个安静的动作键。宿主保证本组件运行在
 * ErrorBoundary 内，抛错只影响这一张卡面。
 */
export function SplitListBody({ data, nodeId, ops }: PluginNodeBodyProps) {
  const rows = useMemo(() => splitLines(data.body).slice(0, MAX_ROWS), [data.body]);
  const overflow = splitLines(data.body).length - rows.length;

  const handleSplit = () => {
    const lines = splitLines(data.body);
    if (lines.length < 2) return;
    void ops.apply([
      ...lines.map((line, index) => ({
        type: "canvas_add_node",
        clientId: `SplitList_${nodeId.slice(-6)}_${index}`,
        kind: "text",
        body: line,
      })),
      ...lines.slice(1).map((_, index) => ({
        type: "canvas_connect_nodes",
        sourceNodeId: `SplitList_${nodeId.slice(-6)}_${index}`,
        targetNodeId: `SplitList_${nodeId.slice(-6)}_${index + 1}`,
      })),
    ]);
  };

  // DEV 环境的错误演练开关：body 含标记时故意抛错，验证宿主 ErrorBoundary。
  if (import.meta.env.DEV && data.body.includes("触发插件错误")) {
    throw new Error("split-list: 测试触发的插件错误");
  }

  return (
    <div className="wc-plugin-split-list" data-node-body="split-list-board">
      {rows.length ? (
        <ol className="wc-plugin-split-list-rows">
          {rows.map((row, index) => (
            <li key={`${index}:${row}`}>{row}</li>
          ))}
        </ol>
      ) : (
        <p className="wc-plugin-split-list-empty">
          选中节点后在下方的创作框里输入多行文本，每行拆成一个节点。
        </p>
      )}
      {overflow > 0 ? (
        <p className="wc-plugin-split-list-overflow">还有 {overflow} 行未显示</p>
      ) : null}
      <button
        type="button"
        className="wc-plugin-split-list-action"
        disabled={rows.length < 2}
        title={rows.length < 2 ? "至少需要两行文本" : "把每一行拆成一个相连的文本节点"}
        onClick={handleSplit}
      >
        拆分为节点
      </button>
    </div>
  );
}

export { splitLines };
