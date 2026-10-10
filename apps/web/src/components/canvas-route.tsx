import { ReactFlowProvider } from "@xyflow/react";
import { useEffect } from "react";

import type { ThemeMode } from "../App";
import type { CanvasBootIdentityStatus } from "../lib/canvas-boot";
import { selectProject, useCanvasStore } from "../state/canvas-store";
import { useCloudProjectStore } from "../state/cloud-project-store";
import { useGenerationStore } from "../state/generation-store";
import { CanvasEntryLoader } from "./canvas-entry-loader";
import { CanvasWorkspace } from "./canvas-workspace";
import { CustomApiDialogHost } from "./custom-api-dialog-host";

type CanvasRouteProps = {
  theme: ThemeMode;
  identityStatus: CanvasBootIdentityStatus;
  identityUserId: string | null;
  booting: boolean;
  workspaceReady: boolean;
  onToggleTheme: () => void;
  onWorkspaceReady: () => void;
  onBootFinished: () => void;
};

export function CanvasRoute({
  theme,
  identityStatus,
  identityUserId,
  booting,
  workspaceReady,
  onToggleTheme,
  onWorkspaceReady,
  onBootFinished,
}: CanvasRouteProps) {
  const projectName = useCanvasStore((state) => state.projectName);
  const catalogTextStatus = useGenerationStore((state) => state.catalogs.text.status);
  const catalogImageStatus = useGenerationStore((state) => state.catalogs.image.status);
  const catalogVideoStatus = useGenerationStore((state) => state.catalogs.video.status);
  const catalogAudioStatus = useGenerationStore((state) => state.catalogs.audio.status);
  const refreshCloudProjects = useCloudProjectStore((state) => state.refresh);
  const resetCloudProjects = useCloudProjectStore((state) => state.reset);
  const retryCloudSync = useCloudProjectStore((state) => state.retrySync);

  useEffect(() => {
    if (identityStatus === "authenticated" && identityUserId) {
      void refreshCloudProjects(identityUserId);
      return;
    }
    if (identityStatus === "anonymous" || identityStatus === "unavailable") resetCloudProjects();
  }, [identityStatus, identityUserId, refreshCloudProjects, resetCloudProjects]);

  // 防丢兜底：登录会话建立时对当前项目的 local-only 挂起自动重试一次。
  // 配额类挂起重试后仍会回到 local-only（贴士条继续提醒）；暂时性原因
  // （上游 5xx/网络）则自动恢复同步，不再要求用户手动点重试。
  useEffect(() => {
    if (identityStatus !== "authenticated" || !identityUserId) return;
    const cloud = useCloudProjectStore.getState();
    const canvas = useCanvasStore.getState();
    const status = cloud.statusByProject[canvas.projectId];
    if (status !== "local-only") return;
    const project = selectProject(canvas);
    if (project.nodes.length || project.edges.length || project.groups.length) {
      retryCloudSync(identityUserId, project);
    }
  }, [identityStatus, identityUserId, retryCloudSync]);

  useEffect(() => {
    if (identityStatus !== "authenticated" || !identityUserId) return;

    let cancelled = false;
    const warmCardLibrary = () => {
      // 同时预热资源库面板本体。面板是懒加载分包，只预热数据的话，首次点击
      // 「卡片与资产」仍要等分包下载；这几百毫秒里没有任何反馈，用户会以为点了
      // 没反应而再点一次，而纯 toggle 会把第二下当成关闭，面板就永远打不开。
      void import("./resource-drawer");
      void import("../lib/card-library-client").then(({ listCardLibraryCards, listCardLibraryGroups }) => {
        if (cancelled) return;
        void Promise.all([
          listCardLibraryCards({ page: 1, limit: 18, query: "" }, { cacheScope: identityUserId }),
          listCardLibraryGroups({ cacheScope: identityUserId }),
        ]).catch(() => undefined);
      });
    };

    if (typeof window.requestIdleCallback === "function") {
      const idleId = window.requestIdleCallback(warmCardLibrary, { timeout: 1_200 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback(idleId);
      };
    }

    const timerId = window.setTimeout(warmCardLibrary, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timerId);
    };
  }, [identityStatus, identityUserId]);

  return (
    <ReactFlowProvider>
      <CanvasWorkspace theme={theme} onToggleTheme={onToggleTheme} booting={booting} onReady={onWorkspaceReady} />
      {booting ? (
        <CanvasEntryLoader
          projectName={projectName}
          workspaceReady={workspaceReady}
          identityStatus={identityStatus}
          catalogStatuses={[catalogTextStatus, catalogImageStatus, catalogVideoStatus, catalogAudioStatus]}
          onFinished={onBootFinished}
        />
      ) : null}
      <CustomApiDialogHost />
    </ReactFlowProvider>
  );
}
