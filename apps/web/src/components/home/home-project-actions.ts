import { requestConfirmation } from "../../lib/confirmation";
import { readProjectSummaryIndex } from "../../lib/project-summary-storage";
import { useToastStore } from "../../state/toast-store";

/**
 * 主页上的项目操作。项目库 store 依赖整个画布 store（体积大），所以全部按需
 * 动态加载：只有真正打开/改动项目时才下载，主页首屏不为它们付费。
 *
 * 语义与画布内项目侧栏一致——打开前先保存当前项目、删除当前项目时自动切到
 * 下一个、导入一律作为新副本（永不覆盖已有项目）。
 */

const toast = (message: string, tone: "info" | "success" | "error" = "info") =>
  useToastStore.getState().show(message, tone);

async function libraryStore() {
  return (await import("../../state/project-library-store")).useProjectLibraryStore;
}

/** 预热画布路由分包：用户即将进入画布（悬停项目/按钮）时提前下载，点开更快。 */
let canvasPrefetched = false;
export function prefetchCanvas() {
  if (canvasPrefetched) return;
  canvasPrefetched = true;
  void import("../../state/project-library-store").catch(() => {
    canvasPrefetched = false;
  });
}

export async function openProject(projectId: string, onEnter: () => void) {
  const store = await libraryStore();
  store.getState().switchProject(projectId);
  let active: string | null = null;
  try {
    active = localStorage.getItem("weftcanvas:active-project:v1");
  } catch {
    active = null;
  }
  if (active !== projectId) return false;
  onEnter();
  return true;
}

export async function createProject(onEnter: () => void, hasProjects: boolean) {
  // 浏览器里还没有任何项目时，画布本身就会以一张空白画布启动；这时再显式
  // 新建会先落一张空的「纬线 1」再建「纬线 2」，凭空多出一个项目。
  if (hasProjects) {
    const store = await libraryStore();
    store.getState().createProject();
  }
  onEnter();
}

export async function renameProject(projectId: string, name: string) {
  const store = await libraryStore();
  return store.getState().renameProject(projectId, name);
}

/** 复制但不切换：主页上复制只是多出一张副本，不打断当前正在编辑的项目。 */
export async function duplicateProject(projectId: string) {
  try {
    const library = await import("../../lib/project-library");
    const source = library.readProject(projectId);
    if (!source) {
      toast("没有找到要复制的项目", "error");
      return null;
    }
    // 起名只需要摘要索引；loadProjectLibrary 会逐个校验全部项目并重写索引与当前项目。
    const name = library.uniqueProjectName(`${source.name} 副本`, readProjectSummaryIndex());
    const duplicate = library.duplicateProjectSnapshot(source, name);
    library.writeProject(duplicate, localStorage, false);
    toast(`已创建副本「${name}」`, "success");
    return duplicate.id;
  } catch {
    toast("项目复制失败，请检查浏览器存储空间", "error");
    return null;
  }
}

export async function deleteProject(projectId: string, name: string) {
  const accepted = await requestConfirmation({
    title: `删除「${name}」？`,
    description: "项目会从这个浏览器的项目库中移除，此操作无法撤销。",
    detail: "已生成的作品仍保留在资产库中；需要保留画布时请先导出项目文件。",
    confirmLabel: "删除项目",
    tone: "danger",
  });
  if (!accepted) return false;
  const store = await libraryStore();
  store.getState().deleteProject(projectId);
  return true;
}

export async function exportProjectFile(projectId: string) {
  const library = await import("../../lib/project-library");
  const project = library.readProject(projectId);
  if (!project) {
    toast("这个项目暂时无法导出", "error");
    return;
  }
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${project.name || "纬线"}.weftcanvas.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  toast("项目文件已导出", "success");
}

/** 导入项目文件（.json）或完整备份（.zip，含本地媒体）。成功返回 true。 */
export async function importProjectFile(file: File) {
  try {
    const store = await libraryStore();
    if (/\.zip$/i.test(file.name) || file.type === "application/zip") {
      toast("正在恢复完整备份…", "info");
      const [{ importProjectBackup }, media] = await Promise.all([
        import("../../lib/project-backup"),
        import("../../lib/media-store"),
      ]);
      const result = await importProjectBackup(file, {
        readMedia: media.readMedia,
        writeMedia: media.writeRestoredMediaRecord,
        validateBlob: media.validateBackupMediaBlob,
      });
      if (!result.ok) {
        toast(result.error, "error");
        return false;
      }
      store.getState().importProject(result.project);
      toast(`已恢复「${result.manifest.summary.name}」`, result.complete ? "success" : "info");
      return true;
    }
    const library = await import("../../lib/project-library");
    if (file.size > library.PROJECT_IMPORT_MAX_BYTES) {
      toast("项目文件过大，无法导入", "error");
      return false;
    }
    const outcome = library.parseProjectImportText(await file.text());
    if (!outcome.ok) {
      toast(
        outcome.reason === "too-large" ? "项目文件过大，无法导入" : "项目文件无效或版本不兼容",
        "error",
      );
      return false;
    }
    store.getState().importProject(outcome.project);
    return true;
  } catch {
    toast("项目文件无效或版本不兼容", "error");
    return false;
  }
}
