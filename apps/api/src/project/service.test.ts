import { describe, expect, it } from "vitest";

import { CloudProjectService } from "./service.js";
import type { CloudProjectMediaValidator } from "./media-access.js";
import type {
  CloudProjectRecord,
  CloudProjectStore,
  CreateCloudProjectStoreResult,
  DeleteCloudProjectStoreResult,
  SaveCloudProjectStoreResult,
} from "./types.js";

const OWNER = "owner-1";
const PROJECT = "project-a";
const NOW = 1_750_000_000_000;
const MEDIA_1 = "11111111-1111-4111-8111-111111111111";
const CLIP_MEDIA = "99999999-9999-4999-8999-999999999999";

function serverMediaNode(id: string, serverId: string) {
  return {
    id,
    kind: "image" as const,
    position: { x: 0, y: 0 },
    data: {
      body: "",
      media: {
        id: serverId,
        name: `${serverId}.png`,
        mimeType: "image/png",
        size: 10,
        source: "server" as const,
        serverId,
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function documentWith(nodes: unknown[]) {
  return {
    schemaVersion: 1,
    projectId: PROJECT,
    title: "测试画布",
    nodes,
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

class MemoryProjectStore implements CloudProjectStore {
  projects = new Map<string, CloudProjectRecord>();

  async list() {
    return [];
  }

  async get(ownerId: string, projectId: string) {
    const found = this.projects.get(`${ownerId}/${projectId}`);
    return found ? structuredClone(found) : null;
  }

  async usage() {
    return { projectCount: 0, projectStorageBytes: 0, mediaStorageBytes: 0 };
  }

  async create(project: CloudProjectRecord): Promise<CreateCloudProjectStoreResult> {
    this.projects.set(`${project.ownerId}/${project.id}`, structuredClone(project));
    return { kind: "created", project: structuredClone(project) };
  }

  async save({ project }: { project: CloudProjectRecord }): Promise<SaveCloudProjectStoreResult> {
    this.projects.set(`${project.ownerId}/${project.id}`, structuredClone(project));
    return { kind: "saved", project: structuredClone(project) };
  }

  async delete(): Promise<DeleteCloudProjectStoreResult> {
    return { kind: "deleted" };
  }
}

class RecordingMediaValidator implements CloudProjectMediaValidator {
  validated: string[][] = [];
  reconciled: Array<{ projectId: string; keep: string[] }> = [];
  reconcileFails = false;

  async validateReadyMedia(_ownerId: string, _projectId: string, mediaIds: readonly string[]) {
    this.validated.push([...mediaIds]);
    return true;
  }

  async reconcileBindings(_ownerId: string, projectId: string, keepMediaIds: readonly string[]) {
    if (this.reconcileFails) throw new Error("db down");
    this.reconciled.push({ projectId, keep: [...keepMediaIds] });
  }
}

function seedProject(store: MemoryProjectStore) {
  store.projects.set(`${OWNER}/${PROJECT}`, {
    schemaVersion: 1,
    id: PROJECT,
    title: "测试画布",
    revision: 1,
    documentBytes: 10,
    localMediaCount: 0,
    document: documentWith([]) as CloudProjectRecord["document"],
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    ownerId: OWNER,
  });
}

function setup(options: { reconcile?: boolean } = {}) {
  const store = new MemoryProjectStore();
  seedProject(store);
  const validator: CloudProjectMediaValidator | undefined =
    options.reconcile === false
      ? {
          // 旧式校验器：只有 validateReadyMedia，没有收敛能力。
          async validateReadyMedia() {
            return true;
          },
        }
      : new RecordingMediaValidator();
  const service = new CloudProjectService(store, undefined, { mediaValidator: validator });
  return { store, validator: validator as RecordingMediaValidator | undefined, service };
}

describe("CloudProjectService binding reconcile", () => {
  it("reconciles bindings to the document's referenced media after a save", async () => {
    const { service, validator } = setup();
    const document = documentWith([
      serverMediaNode("node-1", MEDIA_1),
      {
        id: "node-2",
        kind: "edit" as const,
        position: { x: 0, y: 0 },
        data: {
          body: "",
          edit: {
            clips: [
              {
                id: "clip-1",
                track: "video" as const,
                nodeId: "node-1",
                mediaId: CLIP_MEDIA,
                name: "clip",
                kind: "video" as const,
                sourceDurationMs: 1000,
                inMs: 0,
                outMs: 500,
              },
            ],
          },
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
      {
        id: "node-3",
        kind: "image" as const,
        position: { x: 0, y: 0 },
        data: {
          body: "",
          media: { id: "local-1", name: "b.png", mimeType: "image/png", size: 10 },
          createdAt: NOW,
          updatedAt: NOW,
        },
      },
    ]);

    const result = await service.save(OWNER, PROJECT, { baseRevision: 1, document });
    expect(result.data.revision).toBe(2);

    // 校验仍只看 serverId；收敛的保留集合额外包含剪辑素材，不含本地素材。
    expect(validator?.validated).toEqual([[MEDIA_1]]);
    expect(validator?.reconciled).toEqual([{ projectId: PROJECT, keep: [MEDIA_1, CLIP_MEDIA] }]);
  });

  it("a reconcile failure never fails the successful save", async () => {
    const { service, validator } = setup();
    if (validator) validator.reconcileFails = true;
    const result = await service.save(OWNER, PROJECT, {
      baseRevision: 1,
      document: documentWith([serverMediaNode("node-1", MEDIA_1)]),
    });
    expect(result.data.revision).toBe(2);
  });

  it("saves work unchanged when the validator has no reconcile capability", async () => {
    const { service } = setup({ reconcile: false });
    const result = await service.save(OWNER, PROJECT, {
      baseRevision: 1,
      document: documentWith([serverMediaNode("node-1", MEDIA_1)]),
    });
    expect(result.data.revision).toBe(2);
  });
});
