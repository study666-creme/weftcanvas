import type { CloudProjectSummary } from "@weftcanvas/contracts";
import {
  ArrowRight,
  Check,
  Cloud,
  CloudOff,
  Copy,
  Download,
  House,
  LoaderCircle,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { useCanvasStore } from "../state/canvas-store";
import { useCloudResourceStore } from "../state/cloud-resource-store";
import {
  CLOUD_QUOTA_LOCAL_MESSAGE,
  useCloudProjectStore,
  type CloudSyncStatus,
} from "../state/cloud-project-store";
import { useIdentityStore } from "../state/identity-store";
import { parseProjectImportText, PROJECT_IMPORT_MAX_BYTES } from "../lib/project-library";
import { exportProjectBackup, importProjectBackup } from "../lib/project-backup";
import { readMedia, validateBackupMediaBlob, writeRestoredMediaRecord } from "../lib/media-store";
import { useProjectLibraryStore } from "../state/project-library-store";
import { useToastStore } from "../state/toast-store";

export const ProjectSidebar = memo(function ProjectSidebar() {
  const open = useProjectLibraryStore((state) => state.open);
  const query = useProjectLibraryStore((state) => state.query);
  const projects = useProjectLibraryStore((state) => state.projects);
  const setOpen = useProjectLibraryStore((state) => state.setOpen);
  const setQuery = useProjectLibraryStore((state) => state.setQuery);
  const createProject = useProjectLibraryStore((state) => state.createProject);
  const switchProject = useProjectLibraryStore((state) => state.switchProject);
  const renameProject = useProjectLibraryStore((state) => state.renameProject);
  const duplicateProject = useProjectLibraryStore((state) => state.duplicateProject);
  const deleteProject = useProjectLibraryStore((state) => state.deleteProject);
  const importProject = useProjectLibraryStore((state) => state.importProject);
  const persistCurrent = useProjectLibraryStore((state) => state.persistCurrent);
  const activeProjectId = useCanvasStore((state) => state.projectId);
  const identityStatus = useIdentityStore((state) => state.status);
  const identityUserId = useIdentityStore((state) => state.session?.user.id ?? null);
  const openAccount = useIdentityStore((state) => state.openDialog);
  const cloudProjects = useCloudProjectStore((state) => state.projects);
  const cloudUsage = useCloudProjectStore((state) => state.usage);
  const cloudLinks = useCloudProjectStore((state) => state.links);
  const cloudLoading = useCloudProjectStore((state) => state.loading);
  const cloudStatus = useCloudProjectStore(
    (state) => state.statusByProject[activeProjectId] ?? "idle",
  );
  const cloudError = useCloudProjectStore((state) => state.errorByProject[activeProjectId]);
  const refreshCloud = useCloudProjectStore((state) => state.refresh);
  const enableCloud = useCloudProjectStore((state) => state.enableProject);
  const retryCloudSync = useCloudProjectStore((state) => state.retrySync);
  const openRemoteProject = useCloudProjectStore((state) => state.openRemoteProject);
  const deleteCloudProject = useCloudProjectStore((state) => state.deleteProject);
  const showToast = useToastStore((state) => state.show);
  const openCloudResources = useCloudResourceStore((state) => state.openDialog);
  const importInput = useRef<HTMLInputElement>(null);
  const renameInput = useRef<HTMLInputElement>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteCandidate, setDeleteCandidate] = useState<{ id: string; name: string } | null>(null);
  const [cloudDeleteCandidate, setCloudDeleteCandidate] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [cloudDeleting, setCloudDeleting] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (cloudDeleteCandidate) {
        setCloudDeleteCandidate(null);
        return;
      }
      if (deleteCandidate) setDeleteCandidate(null);
      else if (renamingId) setRenamingId(null);
      else if (menuId) setMenuId(null);
      else setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [cloudDeleteCandidate, deleteCandidate, menuId, open, renamingId, setOpen]);

  useEffect(() => {
    if (renamingId) renameInput.current?.focus();
  }, [renamingId]);

  useEffect(() => {
    if (open && identityStatus === "authenticated" && identityUserId)
      void refreshCloud(identityUserId);
  }, [identityStatus, identityUserId, open, refreshCloud]);

  const filtered = useMemo(() => {
    const term = query.trim().toLocaleLowerCase("zh-CN");
    return term
      ? projects.filter((project) => project.name.toLocaleLowerCase("zh-CN").includes(term))
      : projects;
  }, [projects, query]);
  const cloudOpenCandidates = useMemo(
    () => selectCloudOpenCandidates(cloudProjects, projects, cloudLinks),
    [cloudLinks, cloudProjects, projects],
  );
  const activeCloudLinked = Boolean(cloudLinks[activeProjectId]);
  const cloudBusy = cloudStatus === "syncing";

  const commitRename = () => {
    if (!renamingId) return;
    if (renameProject(renamingId, renameValue)) setRenamingId(null);
  };

  const exportCurrent = () => {
    const project = persistCurrent();
    if (!project) return;
    const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.name || "纬线"}.weftcanvas.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast("项目文件已导出", "success");
  };

  const exportBackup = async () => {
    const project = persistCurrent();
    if (!project) return;
    showToast("正在打包完整备份（含本地媒体）…", "info");
    const result = await exportProjectBackup(project);
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    const url = URL.createObjectURL(result.blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${project.name || "纬线"}.weftcanvas-backup.zip`;
    anchor.click();
    URL.revokeObjectURL(url);
    const external = result.manifest.externalMedia.length;
    const media = result.manifest.media.length;
    showToast(
      external
        ? `已导出：画布 + ${media} 个本地媒体；${external} 个云端素材不在备份里`
        : `已导出完整备份：画布 + ${media} 个本地媒体`,
      external ? "info" : "success",
    );
  };

  /** 完整备份恢复：媒体按原 ID 落库，项目按新副本导入（永不覆盖已有项目）。 */
  const restoreBackup = async (file: File) => {
    showToast("正在恢复完整备份…", "info");
    const result = await importProjectBackup(file, {
      readMedia,
      writeMedia: writeRestoredMediaRecord,
      validateBlob: validateBackupMediaBlob,
    });
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    importProject(result.project);
    const restoredCount = result.reusedMediaIds.length + result.remappedMediaIds.length;
    const parts = [
      `已恢复「${result.manifest.summary.name}」：节点 ${result.manifest.summary.nodeCount}、媒体 ${restoredCount}`,
    ];
    if (result.skipped.length) parts.push(`${result.skipped.length} 个媒体损坏已跳过`);
    if (result.externalMedia.length)
      parts.push(`${result.externalMedia.length} 个云端素材需要重新拉取`);
    showToast(
      `${parts.join(" · ")}${result.complete ? "（完整恢复）" : "（部分恢复）"}`,
      result.complete ? "success" : "info",
    );
  };

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      // 完整备份（ZIP）走媒体恢复管线；JSON 仍是纯画布文件的老路径。
      if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
        await restoreBackup(file);
        return;
      }
      // File.size 是真实字节数：超大文件在读成文本之前就拦掉，别先吃掉内存。
      if (file.size > PROJECT_IMPORT_MAX_BYTES) {
        showToast("项目文件过大，无法导入", "error");
        return;
      }
      const outcome = parseProjectImportText(await file.text());
      if (!outcome.ok) {
        showToast(
          outcome.reason === "too-large" ? "项目文件过大，无法导入" : "项目文件无效或版本不兼容",
          "error",
        );
        return;
      }
      importProject(outcome.project);
    } catch {
      showToast("项目文件无效或版本不兼容", "error");
    } finally {
      if (importInput.current) importInput.current.value = "";
    }
  };

  const saveCurrentToCloud = async () => {
    if (identityStatus !== "authenticated" || !identityUserId) {
      openAccount("login");
      return;
    }
    const project = persistCurrent();
    if (!project) return;
    if (cloudLinks[project.id]) retryCloudSync(identityUserId, project);
    else await enableCloud(identityUserId, project);
  };

  return (
    <>
      <div
        className={`wc-project-scrim ${open ? "is-open" : ""}`}
        aria-hidden="true"
        onPointerDown={() => setOpen(false)}
      />
      <aside
        className={`wc-project-sidebar ${open ? "is-open" : ""}`}
        aria-hidden={!open}
        aria-label="项目库"
        inert={open ? undefined : true}
      >
        <header className="wc-project-sidebar-header">
          <div>
            <strong>项目库</strong>
            <span>{projects.length} 个项目</span>
          </div>
          <a
            className="wc-project-home-link"
            href="/"
            aria-label="返回项目首页"
            title="返回项目首页"
            onClick={() => {
              persistCurrent();
            }}
          >
            <House aria-hidden="true" />
            <span>首页</span>
          </a>
          <button
            type="button"
            className="wc-project-new-button"
            aria-label="新建项目"
            title="新建项目"
            onClick={createProject}
          >
            <Plus aria-hidden="true" />
            <span>新建</span>
          </button>
          <button type="button" aria-label="关闭项目栏" title="关闭" onClick={() => setOpen(false)}>
            <X aria-hidden="true" />
          </button>
        </header>

        <label className="wc-project-search">
          <Search aria-hidden="true" />
          <input
            value={query}
            aria-label="搜索项目"
            placeholder="搜索项目"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" aria-label="清空搜索" title="清空" onClick={() => setQuery("")}>
              <X aria-hidden="true" />
            </button>
          ) : null}
        </label>

        <div className="wc-project-list" role="list">
          {filtered.map((project) => {
            const active = project.id === activeProjectId;
            return (
              <div
                key={project.id}
                className={`wc-project-row ${active ? "is-active" : ""}`}
                role="listitem"
              >
                <div className="wc-project-row-main">
                  {renamingId === project.id ? (
                    <input
                      ref={renameInput}
                      className="wc-project-rename"
                      value={renameValue}
                      maxLength={64}
                      aria-label="项目名称"
                      onChange={(event) => setRenameValue(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                        if (event.key === "Escape") setRenamingId(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="wc-project-open"
                      aria-current={active ? "page" : undefined}
                      onClick={() => switchProject(project.id)}
                    >
                      <span className="wc-project-active-mark" aria-hidden="true">
                        {active ? <Check /> : null}
                      </span>
                      <span className="wc-project-copy">
                        <strong>{project.name}</strong>
                        <small>
                          {project.nodeCount} 个节点 · {formatProjectTime(project.updatedAt)}
                        </small>
                      </span>
                      <span className="wc-project-enter-cue" aria-hidden="true">
                        <ArrowRight />
                      </span>
                    </button>
                  )}
                  <button
                    type="button"
                    className="wc-project-more"
                    aria-label={`${project.name}的更多操作`}
                    title="更多操作"
                    aria-expanded={menuId === project.id}
                    onClick={() => setMenuId((value) => (value === project.id ? null : project.id))}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </button>
                </div>
                {menuId === project.id ? (
                  <div className="wc-project-row-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setRenameValue(project.name);
                        setRenamingId(project.id);
                        setMenuId(null);
                      }}
                    >
                      <Pencil aria-hidden="true" />
                      重命名
                    </button>
                    <button type="button" onClick={() => duplicateProject(project.id)}>
                      <Copy aria-hidden="true" />
                      创建副本
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      onClick={() => {
                        setDeleteCandidate({ id: project.id, name: project.name });
                        setMenuId(null);
                      }}
                    >
                      <Trash2 aria-hidden="true" />
                      删除
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
          {!filtered.length ? <div className="wc-project-empty">没有匹配的项目</div> : null}
          {identityStatus === "authenticated" && cloudOpenCandidates.length ? (
            <section className="wc-project-cloud-section" aria-label="云端项目">
              <header>
                <span>云端项目</span>
                <small>{cloudOpenCandidates.length}</small>
              </header>
              {cloudOpenCandidates.map((project) => (
                <div className="wc-project-cloud-row-wrap" key={project.id}>
                  <button
                    type="button"
                    className="wc-project-cloud-row"
                    onClick={() =>
                      identityUserId && void openRemoteProject(identityUserId, project.id)
                    }
                  >
                    <Cloud aria-hidden="true" />
                    <span>
                      <strong>{project.title}</strong>
                      <small>{formatProjectTime(Date.parse(project.updatedAt))}</small>
                    </span>
                    <ArrowRight aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="wc-project-cloud-delete"
                    aria-label={`删除云端项目：${project.title}`}
                    title="删除云端项目"
                    disabled={cloudDeleting}
                    onClick={() =>
                      setCloudDeleteCandidate({ id: project.id, title: project.title })
                    }
                  >
                    <Trash2 aria-hidden="true" />
                  </button>
                </div>
              ))}
            </section>
          ) : null}
        </div>

        <div className="wc-project-cloud-bar">
          <button
            type="button"
            className={cloudStatus === "local-only" ? "is-local-only" : undefined}
            disabled={cloudBusy || cloudLoading}
            title={cloudError ?? undefined}
            onClick={() => void saveCurrentToCloud()}
          >
            {cloudBusy || cloudLoading ? (
              <LoaderCircle className="is-spinning" aria-hidden="true" />
            ) : cloudStatus === "unavailable" ||
              cloudStatus === "error" ||
              cloudStatus === "local-only" ? (
              <CloudOff aria-hidden="true" />
            ) : (
              <Cloud aria-hidden="true" />
            )}
            <span>
              {cloudButtonLabel(identityStatus, activeCloudLinked, cloudStatus, cloudError)}
            </span>
          </button>
          {identityStatus === "authenticated" && cloudUsage ? (
            <small
              data-quota-level={
                cloudUsage.entitlements.mediaStorageBytes
                  ? cloudUsage.mediaStorageBytes > cloudUsage.entitlements.mediaStorageBytes
                    ? "over"
                    : cloudUsage.mediaStorageBytes / cloudUsage.entitlements.mediaStorageBytes >=
                        0.95
                      ? "critical"
                      : cloudUsage.mediaStorageBytes / cloudUsage.entitlements.mediaStorageBytes >=
                          0.8
                        ? "nearing"
                        : "ok"
                  : "ok"
              }
            >
              <span>
                项目 {cloudUsage.projectCount}/{cloudUsage.entitlements.cloudProjectLimit}
              </span>
              <span>
                文档 {formatStorageBytes(cloudUsage.projectStorageBytes)}/
                {formatStorageBytes(cloudUsage.entitlements.projectStorageBytes)}
              </span>
              <span>
                素材 {formatStorageBytes(cloudUsage.mediaStorageBytes)}/
                {formatStorageBytes(cloudUsage.entitlements.mediaStorageBytes)}
              </span>
            </small>
          ) : null}
          {identityStatus === "authenticated" ? (
            <button
              type="button"
              className="wc-project-cloud-clean"
              aria-label="清理云端资源"
              title="清理云端资源"
              onClick={openCloudResources}
            >
              <Trash2 aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <footer className="wc-project-sidebar-footer">
          <input
            ref={importInput}
            type="file"
            hidden
            accept="application/json,.json,.weftcanvas,application/zip,.zip"
            onChange={(event) => void importFile(event.target.files?.[0])}
          />
          <button type="button" onClick={() => importInput.current?.click()}>
            <Upload aria-hidden="true" />
            导入
          </button>
          <button type="button" onClick={exportCurrent}>
            <Download aria-hidden="true" />
            导出当前
          </button>
          <button
            type="button"
            onClick={() => void exportBackup()}
            title="含本地媒体的完整备份（ZIP）"
          >
            <Package aria-hidden="true" />
            完整备份
          </button>
        </footer>
      </aside>

      {deleteCandidate ? (
        <div
          className="wc-project-delete-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="删除项目"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setDeleteCandidate(null);
          }}
        >
          <section className="wc-project-delete-dialog">
            <header>
              <strong>删除项目</strong>
              <button type="button" aria-label="关闭" onClick={() => setDeleteCandidate(null)}>
                <X aria-hidden="true" />
              </button>
            </header>
            <p>{deleteCandidate.name}</p>
            <footer>
              <button type="button" onClick={() => setDeleteCandidate(null)}>
                取消
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => {
                  deleteProject(deleteCandidate.id);
                  setDeleteCandidate(null);
                }}
              >
                删除
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      {cloudDeleteCandidate ? (
        <div
          className="wc-project-delete-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="删除云端项目"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget && !cloudDeleting)
              setCloudDeleteCandidate(null);
          }}
        >
          <section className="wc-project-delete-dialog">
            <header>
              <strong>删除云端项目</strong>
              <button
                type="button"
                aria-label="关闭"
                onClick={() => setCloudDeleteCandidate(null)}
                disabled={cloudDeleting}
              >
                <X aria-hidden="true" />
              </button>
            </header>
            <p>{cloudDeleteCandidate.title}</p>
            <small>将彻底删除云端副本，无法恢复；本地的同名项目不受影响。</small>
            <footer>
              <button
                type="button"
                onClick={() => setCloudDeleteCandidate(null)}
                disabled={cloudDeleting}
              >
                取消
              </button>
              <button
                type="button"
                className="is-danger"
                disabled={cloudDeleting}
                onClick={() => {
                  if (!identityUserId || !cloudDeleteCandidate) return;
                  setCloudDeleting(true);
                  void deleteCloudProject(identityUserId, cloudDeleteCandidate.id).finally(() => {
                    setCloudDeleting(false);
                    setCloudDeleteCandidate(null);
                  });
                }}
              >
                {cloudDeleting ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : null}
                删除
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
});

function formatProjectTime(timestamp: number) {
  const elapsed = Math.max(0, Date.now() - timestamp);
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  if (elapsed < 7 * 24 * 60 * 60_000) return `${Math.floor(elapsed / 86_400_000)} 天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(timestamp);
}

export function cloudButtonLabel(
  identityStatus: ReturnType<typeof useIdentityStore.getState>["status"],
  linked: boolean,
  status: CloudSyncStatus,
  error: string | null = null,
) {
  if (identityStatus !== "authenticated") return "登录后保存云端";
  if (status === "syncing") return "正在同步";
  if (status === "conflict") return "已保留冲突副本";
  if (status === "local-only") return `${error || CLOUD_QUOTA_LOCAL_MESSAGE}，点击重试`;
  if (status === "unavailable" || status === "error") return "云端同步失败";
  if (linked && status === "synced") return "已同步到云端";
  return linked ? "立即同步" : "保存到云端";
}

function formatStorageBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
  const gigabytes = bytes / (1024 * 1024 * 1024);
  return `${Number.isInteger(gigabytes) ? gigabytes : gigabytes.toFixed(1)} GB`;
}

export function selectCloudOpenCandidates(
  cloudProjects: CloudProjectSummary[],
  localProjects: Array<{ id: string }>,
  cloudLinks: Readonly<Record<string, unknown>>,
) {
  const localIds = new Set(localProjects.map((project) => project.id));
  return cloudProjects.filter((project) => !localIds.has(project.id) || !cloudLinks[project.id]);
}
