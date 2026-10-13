import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { AppStartupBoundary } from "./components/app-startup-boundary";
import { installCanvasReleaseFreshnessGuard } from "./lib/canvas-release-freshness";
// 外观包在样式之前注册：注册表就绪后偏好 normalize 才认得扩展档位。
import "./appearance-packs/amber-edge";
// 入口 CSS 只保留登录首屏/游客入口与全局壳层真正需要的基础样式。
// 画布/生成台专属样式（节点主题、光标、特效、钱包、资源抽屉与 xyflow 基础
// 样式）由 canvas-route.tsx / direct-generation-page.tsx 经 workbench-styles.css
// 懒加载，登录首屏不再下载它们。
import "./styles.css";
import "./entry-gate.css";
import "./canvas-entry-loader.css";
import "./ui-polish.css";

installCanvasReleaseFreshnessGuard();

// 服务端素材延时释放恢复：补跑上次会话遗留的删除队列，避免素材永久占配额。
// 动态导入，不把 api-client/媒体库拉进登录首屏的入口包。
void import("./lib/server-media-deletion").then((module) =>
  module.installServerMediaDeletionRecovery(),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppStartupBoundary>
      <App />
    </AppStartupBoundary>
  </StrictMode>,
);
