import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AssetLibraryItem } from "../../lib/asset-library-store";
import {
  digestProject,
  mergeWorks,
  worksFromLibraryItems,
  worksFromWorkbenchJobs,
  type HomeWork,
  type ProjectDigest,
} from "../../lib/home-data";
import {
  ACTIVE_PROJECT_STORAGE_KEY,
  readProjectSummaryIndex,
  type ProjectSummary,
} from "../../lib/project-summary-storage";

const PROJECT_KEY_PREFIX = "weftcanvas:project-data:v1:";
const DIGEST_BATCH = 6;

/** 摘要缓存跨挂载复用：键含 updatedAt，项目一改就失效。 */
const digestCache = new Map<string, ProjectDigest>();

function digestKey(project: ProjectSummary) {
  return `${project.id}@${project.updatedAt}`;
}

function readDigest(project: ProjectSummary) {
  const key = digestKey(project);
  const cached = digestCache.get(key);
  if (cached) return cached;
  let raw: unknown = null;
  try {
    raw = JSON.parse(
      localStorage.getItem(`${PROJECT_KEY_PREFIX}${encodeURIComponent(project.id)}`) ?? "null",
    );
  } catch {
    raw = null;
  }
  const digest = digestProject(raw, { id: project.id, name: project.name });
  digestCache.set(key, digest);
  return digest;
}

function readActiveProjectId() {
  try {
    return localStorage.getItem(ACTIVE_PROJECT_STORAGE_KEY);
  } catch {
    return null;
  }
}

function scheduleIdle(callback: () => void) {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(callback, { timeout: 600 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 16);
  return () => window.clearTimeout(id);
}

export type StorageEstimate = { usage: number; quota: number } | null;

/**
 * 主页数据：项目摘要（同步）+ 项目封面与作品（空闲时分批解析）+ 工作台历史
 * + 资产库（异步）+ 浏览器存储用量。全部来自本机真实数据，读不到就为空。
 */
export function useHomeLibrary(identityUserId: string | null) {
  const [projects, setProjects] = useState<ProjectSummary[]>(readProjectSummaryIndex);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(readActiveProjectId);
  const [digests, setDigests] = useState<ReadonlyMap<string, ProjectDigest>>(() => {
    const ready = new Map<string, ProjectDigest>();
    for (const project of readProjectSummaryIndex()) {
      const cached = digestCache.get(digestKey(project));
      if (cached) ready.set(project.id, cached);
    }
    return ready;
  });
  const [digestsComplete, setDigestsComplete] = useState(false);
  const [workbenchWorks, setWorkbenchWorks] = useState<HomeWork[]>([]);
  const [assets, setAssets] = useState<AssetLibraryItem[] | null>(null);
  const [assetsError, setAssetsError] = useState(false);
  const [storage, setStorage] = useState<StorageEstimate>(null);
  const generation = useRef(0);

  const refreshProjects = useCallback(() => {
    setProjects(readProjectSummaryIndex());
    setActiveProjectId(readActiveProjectId());
  }, []);

  // 项目摘要：按最近编辑顺序分批在空闲时解析，先出现的是最近项目的封面。
  useEffect(() => {
    const run = ++generation.current;
    const queue = projects.filter((project) => !digestCache.has(digestKey(project)));
    setDigests(() => {
      const next = new Map<string, ProjectDigest>();
      for (const project of projects) {
        const cached = digestCache.get(digestKey(project));
        if (cached) next.set(project.id, cached);
      }
      return next;
    });
    if (!queue.length) {
      setDigestsComplete(true);
      return;
    }
    setDigestsComplete(false);
    let cancel = () => undefined as void;
    const step = () => {
      if (run !== generation.current) return;
      const batch = queue.splice(0, DIGEST_BATCH);
      const results = batch.map((project) => [project.id, readDigest(project)] as const);
      setDigests((current) => {
        const next = new Map(current);
        for (const [id, digest] of results) next.set(id, digest);
        return next;
      });
      if (queue.length) cancel = scheduleIdle(step);
      else setDigestsComplete(true);
    };
    cancel = scheduleIdle(step);
    return () => cancel();
  }, [projects]);

  // 工作台历史只在已登录时存在（按账号分区落在本机）。
  useEffect(() => {
    if (!identityUserId) {
      setWorkbenchWorks([]);
      return;
    }
    let active = true;
    void import("../../lib/direct-generation-history").then((module) => {
      if (!active) return;
      const history = module.readDirectGenerationHistory(identityUserId);
      const hidden = module.readDirectGenerationHiddenArtifacts(identityUserId);
      setWorkbenchWorks(
        worksFromWorkbenchJobs([...history.image, ...history.video, ...history.audio], hidden),
      );
    });
    return () => {
      active = false;
    };
  }, [identityUserId]);

  const refreshAssets = useCallback(() => {
    let active = true;
    void import("../../lib/asset-library-store")
      .then((module) => module.listAssetLibraryItems())
      .then((items) => {
        if (!active) return;
        setAssets(items);
        setAssetsError(false);
      })
      .catch(() => {
        if (!active) return;
        setAssets([]);
        setAssetsError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => refreshAssets(), [refreshAssets]);

  useEffect(() => {
    let active = true;
    void navigator.storage
      ?.estimate?.()
      .then((estimate) => {
        if (!active || !estimate.quota) return;
        setStorage({ usage: estimate.usage ?? 0, quota: estimate.quota });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  // 其他标签页改了项目库（新建/重命名/删除）时同步刷新。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith("weftcanvas:project")) refreshProjects();
      if (event.key === ACTIVE_PROJECT_STORAGE_KEY) setActiveProjectId(readActiveProjectId());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [refreshProjects]);

  const works = useMemo(() => {
    const projectWorks: HomeWork[] = [];
    for (const project of projects) {
      const digest = digests.get(project.id);
      if (digest) projectWorks.push(...digest.works);
    }
    return mergeWorks(projectWorks, workbenchWorks, worksFromLibraryItems(assets ?? []));
  }, [assets, digests, projects, workbenchWorks]);

  return {
    projects,
    activeProjectId,
    digests,
    digestsComplete,
    works,
    worksLoading: !digestsComplete || assets === null,
    assets,
    assetsError,
    storage,
    refreshProjects,
    refreshAssets,
  };
}

export type HomeLibrary = ReturnType<typeof useHomeLibrary>;
