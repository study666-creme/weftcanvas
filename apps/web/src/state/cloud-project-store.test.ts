import type { CanvasDocument, CanvasProject, CloudProject } from "@kachang/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCloudProject: vi.fn(),
  deleteCloudProject: vi.fn(),
  fetchCloudProject: vi.fn(),
  listCloudProjects: vi.fn(),
  saveCloudProject: vi.fn(),
  prepareProjectMediaForCloud: vi.fn(),
}));

vi.mock("../lib/api-client", async (importActual) => ({
  ...await importActual<typeof import("../lib/api-client")>(),
  createCloudProject: mocks.createCloudProject,
  deleteCloudProject: mocks.deleteCloudProject,
  fetchCloudProject: mocks.fetchCloudProject,
  listCloudProjects: mocks.listCloudProjects,
  saveCloudProject: mocks.saveCloudProject,
}));
vi.mock("../lib/cloud-project-media", async (importActual) => ({
  ...await importActual<typeof import("../lib/cloud-project-media")>(),
  prepareProjectMediaForCloud: mocks.prepareProjectMediaForCloud,
}));

import { CanvasApiError } from "../lib/api-client";
import { readAllProjects, readProject, writeProject } from "../lib/project-library";
import { useCanvasStore } from "./canvas-store";
import {
  CLOUD_QUOTA_LOCAL_MESSAGE,
  CLOUD_SIZE_LOCAL_MESSAGE,
  useCloudProjectStore,
} from "./cloud-project-store";
import { useIdentityStore } from "./identity-store";
import { useProjectLibraryStore } from "./project-library-store";
import { useToastStore } from "./toast-store";

const OWNER = "99999999-9999-4999-8999-999999999999";
const OTHER_OWNER = "88888888-8888-4888-8888-888888888888";

describe("cloud project store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("localStorage", new MemoryStorage());
    vi.stubGlobal("window", {
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
    });
    mocks.createCloudProject.mockReset();
    mocks.deleteCloudProject.mockReset();
    mocks.fetchCloudProject.mockReset();
    mocks.listCloudProjects.mockReset();
    mocks.saveCloudProject.mockReset();
    mocks.prepareProjectMediaForCloud.mockReset();
    mocks.prepareProjectMediaForCloud.mockImplementation(async (project: CanvasProject) => project);
    mocks.listCloudProjects.mockResolvedValue({
      projects: [],
      usage: {
        projectCount: 0,
        projectStorageBytes: 0,
        mediaStorageBytes: 0,
        entitlements: {
          tier: "free",
          cloudProjectLimit: 3,
          projectStorageBytes: 10_000_000,
          mediaStorageBytes: 1_000_000_000,
          revisionRetentionCount: 3,
          multiDeviceSync: true,
        },
      },
    });
    authenticate(OWNER);
    useCloudProjectStore.getState().reset();
    useToastStore.setState({ items: [] });
    useProjectLibraryStore.setState({ projects: [] });
  });

  it("deletes a cloud project from the list and clears its link", async () => {
    const project = fixtureProject("Remove me");
    let deleted = false;
    mocks.listCloudProjects.mockImplementation(async () => ({
      projects: deleted ? [] : [cloudProject(project, 2)],
      sharedProjects: [],
      usage: {
        projectCount: deleted ? 0 : 1,
        projectStorageBytes: 0,
        mediaStorageBytes: 0,
        entitlements: {
          tier: "free",
          cloudProjectLimit: 3,
          projectStorageBytes: 10_000_000,
          mediaStorageBytes: 1_000_000_000,
          revisionRetentionCount: 3,
          multiDeviceSync: true,
        },
      },
    }));
    mocks.deleteCloudProject.mockImplementation(async () => { deleted = true; return { ok: true }; });
    await useCloudProjectStore.getState().refresh(OWNER);
    expect(useCloudProjectStore.getState().projects.map((item) => item.id)).toEqual([project.id]);

    const ok = await useCloudProjectStore.getState().deleteProject(OWNER, project.id);
    expect(ok).toBe(true);
    expect(mocks.deleteCloudProject).toHaveBeenCalledWith(project.id, 2);
    expect(useCloudProjectStore.getState().projects.map((item) => item.id)).toEqual([]);
    expect(useToastStore.getState().items.at(-1)?.tone).toBe("success");
  });

  it("reports delete failures without dropping the local list", async () => {
    const project = fixtureProject("Keep me");
    mocks.listCloudProjects.mockImplementation(async () => ({
      projects: [cloudProject(project, 3)],
      sharedProjects: [],
      usage: {
        projectCount: 1,
        projectStorageBytes: 0,
        mediaStorageBytes: 0,
        entitlements: {
          tier: "free",
          cloudProjectLimit: 3,
          projectStorageBytes: 10_000_000,
          mediaStorageBytes: 1_000_000_000,
          revisionRetentionCount: 3,
          multiDeviceSync: true,
        },
      },
    }));
    mocks.deleteCloudProject.mockRejectedValue(new CanvasApiError(409, "REVISION_CONFLICT", "stale"));
    await useCloudProjectStore.getState().refresh(OWNER);

    const ok = await useCloudProjectStore.getState().deleteProject(OWNER, project.id);
    expect(ok).toBe(false);
    expect(useCloudProjectStore.getState().projects.map((item) => item.id)).toEqual([project.id]);
    expect(useToastStore.getState().items.at(-1)?.tone).toBe("error");
  });

  it("stores only a compact fingerprint and advances revisions after a debounced save", async () => {
    const project = fixtureProject("Local");
    const first = cloudProject(project, 1);
    mocks.createCloudProject.mockResolvedValue(first);
    mocks.saveCloudProject.mockResolvedValue(cloudProject({ ...project, name: "Edited", updatedAt: 2 }, 2));
    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, project);

    const rawLink = [...(localStorage as MemoryStorage).values.values()][0];
    expect(rawLink?.length).toBeLessThan(400);
    expect(JSON.parse(rawLink ?? "{}").lastSyncedFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(rawLink ?? "{}").projectOwnerId).toBe(OWNER);

    useCloudProjectStore.getState().scheduleSync(OWNER, { ...project, name: "Edited", updatedAt: 2 });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[project.id]?.revision).toBe(2));
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);
    expect(mocks.saveCloudProject.mock.calls[0]?.[1]).toMatchObject({ baseRevision: 1 });
  });

  it("silently enables cloud sync on first edit for an unlinked project", async () => {
    const project = fixtureProject("Auto");
    const first = cloudProject(project, 1);
    mocks.createCloudProject.mockResolvedValue(first);
    await useCloudProjectStore.getState().refresh(OWNER);

    useCloudProjectStore.getState().ensureAutoSync(OWNER, project);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[project.id]?.revision).toBe(1));

    // 静默开通：无成功 toast，状态为 synced。
    expect(useToastStore.getState().items.filter((item) => item.tone === "success")).toHaveLength(0);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("synced");
    expect(mocks.createCloudProject).toHaveBeenCalledTimes(1);
  });

  it("suspends silently when auto-enable hits the cloud project limit", async () => {
    const project = fixtureProject("Auto limited");
    mocks.createCloudProject.mockRejectedValue(new CanvasApiError(403, "CLOUD_PROJECT_LIMIT_REACHED", "limit"));
    await useCloudProjectStore.getState().refresh(OWNER);

    useCloudProjectStore.getState().ensureAutoSync(OWNER, project);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only"));

    // 配额满：转入 local-only（贴士可见），但不弹任何 toast 打扰。
    expect(useCloudProjectStore.getState().errorByProject[project.id]).toBe(CLOUD_QUOTA_LOCAL_MESSAGE);
    expect(useToastStore.getState().items).toHaveLength(0);
  });

  it.each([
    "MEDIA_STORAGE_LIMIT_REACHED",
    "CLOUD_PROJECT_LIMIT_REACHED",
    "CLOUD_PROJECT_STORAGE_LIMIT_REACHED",
  ])("keeps local work and suspends automatic sync for quota error %s", async (code) => {
    const project = fixtureProject("Local");
    const edited = { ...project, name: "Local edit", updatedAt: 2 };
    mocks.createCloudProject.mockResolvedValue(cloudProject(project, 1));
    mocks.saveCloudProject.mockRejectedValue(new CanvasApiError(413, code, "quota reached"));
    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, project);
    writeProject(edited);

    useCloudProjectStore.getState().scheduleSync(OWNER, edited, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only"));

    expect(useCloudProjectStore.getState().errorByProject[project.id]).toBe(CLOUD_QUOTA_LOCAL_MESSAGE);
    expect(readProject(project.id)?.name).toBe("Local edit");
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);

    useCloudProjectStore.getState().scheduleSync(OWNER, { ...edited, name: "Newer local edit", updatedAt: 3 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);

    useCloudProjectStore.getState().reset();
    await useCloudProjectStore.getState().refresh(OWNER, true);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only");
    expect(useCloudProjectStore.getState().errorByProject[project.id]).toBe(CLOUD_QUOTA_LOCAL_MESSAGE);

    useCloudProjectStore.getState().scheduleSync(OWNER, { ...edited, name: "Edit after reload", updatedAt: 4 }, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);
  });

  it.each([
    "CLOUD_PROJECT_DOCUMENT_TOO_LARGE",
    "MEDIA_TOO_LARGE",
  ])("persists terminal local saving for hard size error %s", async (code) => {
    const project = fixtureProject("Hard size limit");
    const edited = { ...project, name: "Oversized cloud content", updatedAt: 2 };
    mocks.createCloudProject.mockResolvedValue(cloudProject(project, 1));
    mocks.saveCloudProject.mockRejectedValue(new CanvasApiError(413, code, "too large"));

    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, project);
    useCloudProjectStore.getState().scheduleSync(OWNER, edited, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only"));
    expect(useCloudProjectStore.getState().errorByProject[project.id]).toBe(CLOUD_SIZE_LOCAL_MESSAGE);
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);

    useCloudProjectStore.getState().reset();
    await useCloudProjectStore.getState().refresh(OWNER, true);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only");
    expect(useCloudProjectStore.getState().errorByProject[project.id]).toBe(CLOUD_SIZE_LOCAL_MESSAGE);
    useCloudProjectStore.getState().scheduleSync(OWNER, { ...edited, updatedAt: 3 }, true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);
  });

  it("creates and links the project before media upload, then resumes only after an explicit retry", async () => {
    const project = fixtureProjectWithLocalMedia("Local media");
    const callOrder: string[] = [];
    writeProject(project);
    mocks.createCloudProject.mockImplementation(async (value: { document: CanvasDocument }) => {
      callOrder.push("create");
      return {
        ...cloudProject(project, 1),
        document: value.document,
        localMediaCount: 1,
      };
    });
    mocks.prepareProjectMediaForCloud.mockImplementationOnce(async () => {
      callOrder.push("prepare-media");
      throw new CanvasApiError(413, "MEDIA_STORAGE_LIMIT_REACHED", "quota reached");
    });
    await useCloudProjectStore.getState().refresh(OWNER);

    await expect(useCloudProjectStore.getState().enableProject(OWNER, project)).resolves.toBe(false);

    expect(callOrder).toEqual(["create", "prepare-media"]);
    expect(mocks.createCloudProject.mock.calls[0]?.[0].document.nodes[0]?.data.media).toMatchObject({
      id: "local-media",
      source: "local",
      serverId: null,
    });
    expect(mocks.saveCloudProject).not.toHaveBeenCalled();
    expect(useCloudProjectStore.getState().links[project.id]?.revision).toBe(1);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only");
    expect(readProject(project.id)?.nodes[0]?.data.media).toMatchObject({
      id: "local-media",
      source: "local",
      serverId: null,
    });

    const edited = { ...project, name: "Latest local edit", updatedAt: 2 };
    writeProject(edited);
    useCloudProjectStore.getState().scheduleSync(OWNER, edited, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.prepareProjectMediaForCloud).toHaveBeenCalledTimes(1);

    mocks.prepareProjectMediaForCloud.mockImplementation(async (value: CanvasProject) => {
      const prepared = structuredClone(value);
      prepared.nodes[0]!.data.media!.serverId = "11111111-1111-4111-8111-111111111111";
      return prepared;
    });
    mocks.saveCloudProject.mockImplementation(async (_projectId: string, value: { document: CanvasDocument }) => ({
      ...cloudProject(edited, 2),
      title: value.document.title,
      document: value.document,
    }));

    useCloudProjectStore.getState().retrySync(OWNER, edited);
    useCloudProjectStore.getState().retrySync(OWNER, edited);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("syncing");
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("synced"));

    expect(mocks.prepareProjectMediaForCloud).toHaveBeenCalledTimes(2);
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);
    expect(useCloudProjectStore.getState().links[project.id]?.revision).toBe(2);
    expect(readProject(project.id)?.name).toBe("Latest local edit");
  });

  it("bootstraps a cloud project without an unbound personal media id before saving its bound copy", async () => {
    const project = fixtureProjectWithLocalMedia("Personal generation");
    const personalMediaId = "55555555-5555-4555-8555-555555555555";
    project.nodes[0]!.data.media = {
      ...project.nodes[0]!.data.media!,
      id: personalMediaId,
      source: "server",
      serverId: personalMediaId,
    };
    const boundMediaId = "66666666-6666-4666-8666-666666666666";
    mocks.createCloudProject.mockImplementation(async (value: { document: CanvasDocument }) => ({
      ...cloudProject(project, 1),
      document: value.document,
      localMediaCount: 1,
    }));
    mocks.prepareProjectMediaForCloud.mockImplementation(async (value: CanvasProject) => {
      expect(value.nodes[0]?.data.media).toMatchObject({
        id: personalMediaId,
        source: "server",
        serverId: personalMediaId,
      });
      const prepared = structuredClone(value);
      prepared.nodes[0]!.data.media!.serverId = boundMediaId;
      return prepared;
    });
    mocks.saveCloudProject.mockImplementation(async (_projectId: string, value: { document: CanvasDocument }) => ({
      ...cloudProject(project, 2),
      document: value.document,
    }));

    await useCloudProjectStore.getState().refresh(OWNER);
    await expect(useCloudProjectStore.getState().enableProject(OWNER, project)).resolves.toBe(true);

    expect(mocks.createCloudProject.mock.calls[0]?.[0].document.nodes[0]?.data.media).toMatchObject({
      id: personalMediaId,
      source: "local",
      serverId: null,
    });
    expect(mocks.saveCloudProject.mock.calls[0]?.[1].document.nodes[0]?.data.media).toMatchObject({
      id: boundMediaId,
      source: "server",
      serverId: boundMediaId,
    });
    expect(useCloudProjectStore.getState().links[project.id]?.revision).toBe(2);
  });

  it("preserves local work as a copy before accepting a newer remote revision", async () => {
    const local = fixtureProject("Local edit");
    const remote = fixtureProject("Remote edit");
    remote.updatedAt = 3;
    writeProject(local);
    useCanvasStore.getState().replaceProject(local);
    mocks.createCloudProject.mockResolvedValue(cloudProject(fixtureProject("Base"), 1));
    mocks.saveCloudProject.mockRejectedValue(new CanvasApiError(
      409,
      "CLOUD_PROJECT_REVISION_CONFLICT",
      "conflict",
      null,
      2,
    ));
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(remote, 2));
    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, fixtureProject("Base"));

    useCloudProjectStore.getState().scheduleSync(OWNER, local, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(2));

    const projects = readAllProjects();
    expect(projects.some((project) => project.name.includes("冲突副本"))).toBe(true);
    expect(projects.find((project) => project.id === local.id)?.name).toBe("Remote edit");
    expect(useCanvasStore.getState().projectName).toBe("Remote edit");
  });

  it("retries a revision-only conflict against the current remote revision", async () => {
    const base = fixtureProject("Base");
    const local = fixtureProject("Local edit");
    const remoteBaseline = fixtureProject("Base");
    mocks.createCloudProject.mockResolvedValue(cloudProject(base, 1));
    mocks.saveCloudProject
      .mockRejectedValueOnce(new CanvasApiError(409, "CLOUD_PROJECT_REVISION_CONFLICT", "conflict"))
      .mockResolvedValueOnce(cloudProject(local, 3));
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(remoteBaseline, 2));

    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, base);
    useCloudProjectStore.getState().scheduleSync(OWNER, local, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(3));

    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(2);
    expect(mocks.saveCloudProject.mock.calls[1]?.[1]).toMatchObject({ baseRevision: 2 });
    expect(readAllProjects().filter((project) => project.name.includes("冲突副本"))).toHaveLength(0);
  });

  it("adopts an identical remote document after a conflict without copying it", async () => {
    const base = fixtureProject("Base");
    const local = fixtureProject("Local edit");
    mocks.createCloudProject.mockResolvedValue(cloudProject(base, 1));
    mocks.saveCloudProject.mockRejectedValue(new CanvasApiError(409, "CLOUD_PROJECT_REVISION_CONFLICT", "conflict"));
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(local, 2));

    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, base);
    useCloudProjectStore.getState().scheduleSync(OWNER, local, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(2));

    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);
    expect(readAllProjects().filter((project) => project.name.includes("冲突副本"))).toHaveLength(0);
    expect(useCloudProjectStore.getState().statusByProject[local.id]).toBe("synced");
  });

  it("preserves at most one conflict copy when the same conflict recurs", async () => {
    const local = fixtureProject("Local edit");
    const remote = fixtureProject("Remote edit");
    remote.updatedAt = 3;
    writeProject(local);
    useCanvasStore.getState().replaceProject(local);
    mocks.createCloudProject.mockResolvedValue(cloudProject(fixtureProject("Base"), 1));
    mocks.saveCloudProject.mockRejectedValue(new CanvasApiError(
      409,
      "CLOUD_PROJECT_REVISION_CONFLICT",
      "conflict",
      null,
      2,
    ));
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(remote, 2));
    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, fixtureProject("Base"));

    useCloudProjectStore.getState().scheduleSync(OWNER, local, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(2));

    expect(readAllProjects().filter((project) => project.name.includes("冲突副本"))).toHaveLength(1);

    useCloudProjectStore.getState().scheduleSync(OWNER, { ...local, updatedAt: 5 }, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().statusByProject[local.id]).toBe("conflict"));

    expect(readAllProjects().filter((project) => project.name.includes("冲突副本"))).toHaveLength(1);
  });

  it("keeps the conflict copy offline without a cloud link or generation runtime state", async () => {
    const local = fixtureProjectWithLocalMedia("Local edit");
    local.nodes[0]!.data.generation.jobId = "job-active";
    local.nodes[0]!.data.generation.jobStatus = "running";
    local.nodes[0]!.data.status = "running";
    const remote = fixtureProject("Remote edit");
    remote.updatedAt = 3;
    writeProject(local);
    useCanvasStore.getState().replaceProject(local);
    mocks.createCloudProject.mockResolvedValue(cloudProject(fixtureProject("Base"), 1));
    mocks.saveCloudProject.mockRejectedValue(new CanvasApiError(
      409,
      "CLOUD_PROJECT_REVISION_CONFLICT",
      "conflict",
      null,
      2,
    ));
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(remote, 2));
    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, fixtureProject("Base"));

    useCloudProjectStore.getState().scheduleSync(OWNER, local, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(2));

    const copies = readAllProjects().filter((project) => project.name.includes("冲突副本"));
    expect(copies).toHaveLength(1);
    const copy = copies[0]!;
    expect(copy.id).not.toBe(local.id);
    expect(useCloudProjectStore.getState().links[copy.id]).toBeUndefined();
    expect(copy.nodes[0]?.data.generation.jobId).toBeNull();
    expect(copy.nodes[0]?.data.generation.jobStatus).toBeNull();
    expect(copy.nodes[0]?.data.status).toBe("success");

    useCloudProjectStore.getState().scheduleSync(OWNER, copy);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);
    expect(useCloudProjectStore.getState().statusByProject[copy.id]).toBeUndefined();
  });

  it("drops stale pending snapshots after a remote replacement so they cannot re-sync", async () => {
    const local = fixtureProject("Local edit");
    const remote = fixtureProject("Remote edit");
    remote.updatedAt = 3;
    writeProject(local);
    useCanvasStore.getState().replaceProject(local);
    mocks.createCloudProject.mockResolvedValue(cloudProject(fixtureProject("Base"), 1));
    mocks.saveCloudProject.mockRejectedValue(new CanvasApiError(
      409,
      "CLOUD_PROJECT_REVISION_CONFLICT",
      "conflict",
      null,
      2,
    ));
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(remote, 2));
    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, fixtureProject("Base"));

    useCloudProjectStore.getState().scheduleSync(OWNER, local, true);
    useCloudProjectStore.getState().scheduleSync(OWNER, { ...local, name: "Stale queued edit", updatedAt: 4 }, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(2));
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1);
    expect(readAllProjects().filter((project) => project.name.includes("冲突副本"))).toHaveLength(1);
  });

  it("saves the next real local edit to a new revision after a conflict", async () => {
    const local = fixtureProject("Local edit");
    const remote = fixtureProject("Remote edit");
    remote.updatedAt = 3;
    writeProject(local);
    useCanvasStore.getState().replaceProject(local);
    mocks.createCloudProject.mockResolvedValue(cloudProject(fixtureProject("Base"), 1));
    mocks.saveCloudProject
      .mockRejectedValueOnce(new CanvasApiError(409, "CLOUD_PROJECT_REVISION_CONFLICT", "conflict", null, 2))
      .mockResolvedValueOnce(cloudProject({ ...remote, name: "Next edit", updatedAt: 4 }, 3));
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(remote, 2));
    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, fixtureProject("Base"));

    useCloudProjectStore.getState().scheduleSync(OWNER, local, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(2));

    const nextEdit = { ...remote, name: "Next edit", updatedAt: 4 };
    writeProject(nextEdit);
    useCloudProjectStore.getState().scheduleSync(OWNER, nextEdit, true);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(useCloudProjectStore.getState().links[local.id]?.revision).toBe(3));
    expect(useCloudProjectStore.getState().statusByProject[local.id]).toBe("synced");
    expect(useCloudProjectStore.getState().errorByProject[local.id]).toBeNull();
  });

  it("keeps a remote open idempotent for identical local content", async () => {
    const local = fixtureProject("Local edit");
    const remote = fixtureProject("Remote edit");
    remote.updatedAt = 3;
    writeProject(local);
    useCanvasStore.getState().replaceProject(local);
    mocks.fetchCloudProject.mockResolvedValue(cloudProject(remote, 2));
    await useCloudProjectStore.getState().refresh(OWNER);

    await useCloudProjectStore.getState().openRemoteProject(OWNER, local.id);
    expect(readAllProjects().filter((project) => project.name.includes("冲突副本"))).toHaveLength(1);

    writeProject(local);
    await useCloudProjectStore.getState().openRemoteProject(OWNER, local.id);
    expect(readAllProjects().filter((project) => project.name.includes("冲突副本"))).toHaveLength(1);
  });

  it("ignores an old owner's deferred open response after the account changes", async () => {
    const current = { ...fixtureProject("Current local"), id: "project-current-local" };
    const remote = { ...fixtureProject("Owner A remote"), id: "project-owner-a-remote" };
    writeProject(current);
    useCanvasStore.getState().replaceProject(current);
    const request = deferred<CloudProject>();
    mocks.fetchCloudProject.mockReturnValueOnce(request.promise);
    await useCloudProjectStore.getState().refresh(OWNER);

    const opening = useCloudProjectStore.getState().openRemoteProject(OWNER, remote.id);
    authenticate(OTHER_OWNER);
    await useCloudProjectStore.getState().refresh(OTHER_OWNER, true);
    request.resolve(cloudProject(remote, 1));

    await expect(opening).resolves.toBe(false);
    expect(useCloudProjectStore.getState()).toMatchObject({
      ownerId: OTHER_OWNER,
      links: {},
      statusByProject: {},
    });
    expect(useCanvasStore.getState().projectId).toBe(current.id);
    expect(readAllProjects().some((project) => project.id === remote.id)).toBe(false);
    expect(useToastStore.getState().items).toEqual([]);
  });

  it("ignores an old owner's deferred enable response after the account changes", async () => {
    const project = fixtureProject("Owner A local");
    const request = deferred<CloudProject>();
    mocks.createCloudProject.mockReturnValueOnce(request.promise);
    await useCloudProjectStore.getState().refresh(OWNER);

    const enabling = useCloudProjectStore.getState().enableProject(OWNER, project);
    await vi.waitFor(() => expect(mocks.createCloudProject).toHaveBeenCalledTimes(1));
    authenticate(OTHER_OWNER);
    await useCloudProjectStore.getState().refresh(OTHER_OWNER, true);
    request.resolve(cloudProject(project, 1));

    await expect(enabling).resolves.toBe(false);
    expect(useCloudProjectStore.getState()).toMatchObject({
      ownerId: OTHER_OWNER,
      links: {},
      projects: [],
      statusByProject: {},
    });
    expect([...((localStorage as MemoryStorage).values.keys())].some((key) => key.includes("cloud-link"))).toBe(false);
    expect(useToastStore.getState().items).toEqual([]);
  });

  it("does not expire the new session when an old request later returns 401", async () => {
    const request = deferred<CloudProject>();
    mocks.fetchCloudProject.mockReturnValueOnce(request.promise);
    await useCloudProjectStore.getState().refresh(OWNER);

    const opening = useCloudProjectStore.getState().openRemoteProject(OWNER, "project-owner-a-remote");
    authenticate(OTHER_OWNER);
    await useCloudProjectStore.getState().refresh(OTHER_OWNER, true);
    request.reject(new CanvasApiError(401, "UNAUTHENTICATED", "expired"));

    await expect(opening).resolves.toBe(false);
    expect(useIdentityStore.getState()).toMatchObject({
      status: "authenticated",
      dialogOpen: false,
    });
    expect(useIdentityStore.getState().session?.user.id).toBe(OTHER_OWNER);
    expect(useCloudProjectStore.getState().statusByProject).toEqual({});
  });

  it("switches to local-only when media quota is exhausted without changing local data", async () => {
    const project = fixtureProject("Local quota");
    writeProject(project);
    const before = readProject(project.id);
    mocks.createCloudProject.mockResolvedValue(cloudProject(project, 1));
    mocks.prepareProjectMediaForCloud.mockRejectedValue(new CanvasApiError(
      403,
      "MEDIA_STORAGE_LIMIT_REACHED",
      "media quota reached",
    ));

    await useCloudProjectStore.getState().refresh(OWNER);
    await expect(useCloudProjectStore.getState().enableProject(OWNER, project)).resolves.toBe(false);

    expect(readProject(project.id)).toEqual(before);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only");
    expect(useCloudProjectStore.getState().errorByProject[project.id]).toBe(
      "云空间已满，当前内容仍保存在本地",
    );
    expect(useCloudProjectStore.getState().links[project.id]?.revision).toBe(1);
  });

  it("does not retry autosaves after a quota failure until explicitly retried", async () => {
    const project = fixtureProject("Local only");
    mocks.createCloudProject.mockResolvedValue(cloudProject(project, 1));
    mocks.prepareProjectMediaForCloud.mockRejectedValueOnce(new CanvasApiError(
      403,
      "CLOUD_PROJECT_STORAGE_LIMIT_REACHED",
      "project quota reached",
    ));

    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, project);
    mocks.prepareProjectMediaForCloud.mockClear();
    mocks.saveCloudProject.mockClear();

    useCloudProjectStore.getState().scheduleSync(OWNER, { ...project, name: "Changed locally" });
    await vi.advanceTimersByTimeAsync(3_000);

    expect(mocks.prepareProjectMediaForCloud).not.toHaveBeenCalled();
    expect(mocks.saveCloudProject).not.toHaveBeenCalled();
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only");
  });

  it("allows an explicit retry after quota recovery", async () => {
    const project = fixtureProject("Retry me");
    const edited = { ...project, name: "Retry me after upgrade", updatedAt: 2 };
    mocks.createCloudProject.mockResolvedValue(cloudProject(project, 1));
    mocks.prepareProjectMediaForCloud.mockRejectedValueOnce(new CanvasApiError(
      403,
      "MEDIA_STORAGE_LIMIT_REACHED",
      "media quota reached",
    ));
    mocks.saveCloudProject.mockResolvedValue(cloudProject(edited, 2));

    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, project);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only");

    mocks.prepareProjectMediaForCloud.mockResolvedValue(edited);
    useCloudProjectStore.getState().retrySync(OWNER, edited);
    await vi.advanceTimersByTimeAsync(0);
    await vi.waitFor(() => expect(mocks.saveCloudProject).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("synced"));

    expect(mocks.saveCloudProject.mock.calls[0]?.[0]).toBe(project.id);
    expect(mocks.saveCloudProject.mock.calls[0]?.[1]).toMatchObject({ baseRevision: 1 });
    expect(useCloudProjectStore.getState().links[project.id]?.revision).toBe(2);

    useCloudProjectStore.getState().reset();
    await useCloudProjectStore.getState().refresh(OWNER, true);
    expect(useCloudProjectStore.getState().statusByProject[project.id]).not.toBe("local-only");
  });

  it("checks project quota before attempting any media upload", async () => {
    const project = fixtureProject("Project quota");
    mocks.createCloudProject.mockRejectedValue(new CanvasApiError(
      403,
      "CLOUD_PROJECT_LIMIT_REACHED",
      "project quota reached",
    ));

    await useCloudProjectStore.getState().refresh(OWNER);
    await expect(useCloudProjectStore.getState().enableProject(OWNER, project)).resolves.toBe(false);

    expect(mocks.prepareProjectMediaForCloud).not.toHaveBeenCalled();
    expect(useCloudProjectStore.getState().statusByProject[project.id]).toBe("local-only");
    expect(useCloudProjectStore.getState().links[project.id]).toBeUndefined();
  });

  it("keeps the cloud link when media quota fails after project creation", async () => {
    const project = fixtureProject("Linked local-only");
    mocks.createCloudProject.mockResolvedValue(cloudProject(project, 1));
    mocks.prepareProjectMediaForCloud.mockRejectedValue(new CanvasApiError(
      403,
      "MEDIA_STORAGE_LIMIT_REACHED",
      "media quota reached",
    ));

    await useCloudProjectStore.getState().refresh(OWNER);
    await useCloudProjectStore.getState().enableProject(OWNER, project);

    expect(mocks.createCloudProject).toHaveBeenCalledTimes(1);
    expect(mocks.prepareProjectMediaForCloud).toHaveBeenCalledTimes(1);
    expect(useCloudProjectStore.getState().links[project.id]).toMatchObject({
      ownerId: OWNER,
      projectId: project.id,
      revision: 1,
    });
    expect(readProject(project.id)).toBeNull();
  });
});

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() { return this.values.size; }
  clear() { this.values.clear(); }
  getItem(key: string) { return this.values.get(key) ?? null; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, String(value)); }
}

function cloudProject(project: CanvasProject, revision: number): CloudProject {
  return {
    schemaVersion: 1,
    id: project.id,
    title: project.name,
    revision,
    documentBytes: 100,
    localMediaCount: 0,
    document: document(project),
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: new Date(project.updatedAt).toISOString(),
  };
}

function document(project: CanvasProject): CanvasDocument {
  return {
    schemaVersion: 1,
    projectId: project.id,
    title: project.name,
    nodes: [],
    edges: [],
    groups: [],
    viewport: project.viewport,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function fixtureProject(name: string): CanvasProject {
  return {
    schemaVersion: 1,
    id: "project-cloud-sync",
    name,
    nodes: [],
    edges: [],
    groups: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: 1,
    updatedAt: 1,
  };
}

function fixtureProjectWithLocalMedia(name: string): CanvasProject {
  return {
    ...fixtureProject(name),
    nodes: [{
      id: "node-local-media",
      type: "kachang",
      position: { x: 10, y: 20 },
      data: {
        kind: "image",
        body: "",
        accent: "jade",
        status: "success",
        progress: null,
        media: {
          id: "local-media",
          name: "frame.png",
          mimeType: "image/png",
          size: 128,
          source: "local",
          serverId: null,
          width: 640,
          height: 360,
          durationMs: null,
        },
        directorCapture: null,
        config: null,
      edit: null,
      music: null,
        generation: {
          modelId: null,
          parameters: {},
          referenceImagePurposes: {},
          maxOutputTokens: null,
          referenceMode: "auto",
          referenceNodeIds: [],
          jobId: null,
          jobVersion: null,
          jobCreatedAt: null,
          jobStatus: null,
          error: null,
        },
        createdAt: 1,
        updatedAt: 1,
      },
    }],
  };
}

function authenticate(ownerId: string) {
  useIdentityStore.setState({
    status: "authenticated",
    session: {
      user: {
        id: ownerId,
        email: `${ownerId}@example.com`,
        displayName: "Tester",
        createdAt: "2026-07-24T00:00:00.000Z",
      },
      expiresAt: "2026-08-24T00:00:00.000Z",
    },
    dialogOpen: false,
    busy: false,
    error: null,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
