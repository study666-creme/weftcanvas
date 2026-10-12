import { Component, type ReactNode } from "react";

/**
 * 插件节点体的 ErrorBoundary（docs/PLUGIN-ROADMAP.md §6 验收②）：
 * 插件抛错只影响这一张卡面，绝不击穿画布。这是与参考实现的直接差异点——
 * 它没有边界，插件渲染错误会让整棵画布白屏。
 */
export class PluginBodyBoundary extends Component<
  { children: ReactNode; pluginKind: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown) {
    console.error(`[plugin-host] 插件节点体渲染失败（${this.props.pluginKind}）`, error);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          className="wc-plugin-body-error"
          role="status"
          data-plugin-kind={this.props.pluginKind}
        >
          插件面板暂时不可用，画布不受影响
        </div>
      );
    }
    return this.props.children;
  }
}
