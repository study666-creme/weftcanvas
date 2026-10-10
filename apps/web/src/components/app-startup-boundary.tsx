import { Component, type ErrorInfo, type ReactNode } from "react";

type AppStartupBoundaryProps = {
  children: ReactNode;
};

type AppStartupBoundaryState = {
  failed: boolean;
  error: unknown;
  componentStack: string | null;
};

export class AppStartupBoundary extends Component<AppStartupBoundaryProps, AppStartupBoundaryState> {
  state: AppStartupBoundaryState = { failed: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): AppStartupBoundaryState {
    return { failed: true, error, componentStack: null };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[canvas-startup] React failed to mount the workspace", error, info.componentStack);
    // getDerivedStateFromError 阶段拿不到组件栈，这里补记后刷新展示
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    if (!this.state.failed) return this.props.children;

    const detail = this.state.error instanceof Error
      ? `${this.state.error.name}: ${this.state.error.message}\n${this.state.error.stack?.split("\n").slice(1, 6).join("\n") ?? ""}`
      : String(this.state.error ?? "未知错误");
    const stack = (this.state.componentStack ?? "")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-14)
      .join("\n");

    return (
      <main className="kc-startup-error" role="alert">
        <div>
          <h1>画布启动没有完成</h1>
          <p>本地项目仍保存在当前浏览器中。重新载入后会再次恢复工作区。</p>
          <pre className="kc-startup-error-detail">{detail}{stack ? `\n\n-- 组件栈 --\n${stack}` : ""}</pre>
          <button type="button" onClick={() => window.location.reload()}>重新载入</button>
        </div>
      </main>
    );
  }
}
