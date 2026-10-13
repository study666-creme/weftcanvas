import type { CloudResource } from "@weftcanvas/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cleanupCloudResources: vi.fn(),
  listCloudResources: vi.fn(),
  cacheServerMedia: vi.fn(),
  storeMedia: vi.fn(),
  ensureMediaAsset: vi.fn(),
  refresh: vi.fn(),
  show: vi.fn(),
}));

vi.mock("../lib/api-client", () => ({
  cleanupCloudResources: mocks.cleanupCloudResources,
  listCloudResources: mocks.listCloudResources,
  mediaContentPath: (mediaId: string) => `/api/v1/media/${mediaId}/content`,
}));
vi.mock("../lib/media-store", () => ({
  cacheServerMedia: mocks.cacheServerMedia,
  storeMedia: mocks.storeMedia,
}));
vi.mock("../lib/asset-library-store", () => ({
  ensureMediaAsset: mocks.ensureMediaAsset,
}));
vi.mock("../lib/cloud-media-preference", () => ({
  readSkipCloudUploads: () => false,
  writeSkipCloudUploads: () => undefined,
}));
vi.mock("./cloud-project-store", () => ({
  useCloudProjectStore: { getState: () => ({ refresh: mocks.refresh }) },
}));
vi.mock("./toast-store", () => ({
  useToastStore: { getState: () => ({ show: mocks.show }) },
}));
vi.mock("./identity-store", () => ({
  useIdentityStore: {
    getState: () => ({ status: "authenticated", session: { user: { id: "owner-1" } } }),
  },
}));

import { useCloudResourceStore } from "./cloud-resource-store";

const NOW = "2026-01-01T00:00:00.000Z";

function resource(id: string, overrides: Partial<CloudResource> = {}): CloudResource {
  return {
    id,
    kind: "image",
    name: `${id}.png`,
    mimeType: "image/png",
    size: 100,
    status: "ready",
    source: "upload",
    width: 10,
    height: 10,
    durationMs: null,
    projectIds: [],
    orphaned: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const ORPHAN = resource("orphan-1", { orphaned: true });
const ACTIVE = resource("active-1");
const BOUND = resource("bound-1", { projectIds: ["project-a"] });

function usage() {
  return {
    usedBytes: 300,
    quotaBytes: 1000,
    boundBytes: 100,
    orphanBytes: 100,
    totalCount: 3,
    orphanCount: 1,
  };
}

beforeEach(() => {
  mocks.cleanupCloudResources.mockReset();
  mocks.cacheServerMedia.mockReset();
  mocks.cacheServerMedia.mockResolvedValue(true);
  mocks.refresh.mockReset();
  mocks.show.mockReset();
  useCloudResourceStore.setState({
    open: true,
    busy: false,
    items: [ORPHAN, ACTIVE, BOUND],
    usage: usage(),
    error: null,
    selected: {},
    progress: null,
  });
});

describe("cloud resource cleanup", () => {
  it("cleans orphans without forceUnbound and without local caching", async () => {
    useCloudResourceStore.setState({ selected: { [ORPHAN.id]: true } });
    mocks.cleanupCloudResources.mockResolvedValue({
      deleted: [ORPHAN],
      skipped: [],
      freedBytes: 100,
      usage: usage(),
    });

    await useCloudResourceStore.getState().cleanup({ saveLocally: false });

    expect(mocks.cacheServerMedia).not.toHaveBeenCalled();
    expect(mocks.cleanupCloudResources).toHaveBeenCalledWith({ mediaIds: [ORPHAN.id] });
    expect(useCloudResourceStore.getState().items.map((item) => item.id)).toEqual([
      ACTIVE.id,
      BOUND.id,
    ]);
  });

  it("caches active items locally first and sends forceUnbound", async () => {
    useCloudResourceStore.setState({ selected: { [ACTIVE.id]: true } });
    mocks.cleanupCloudResources.mockResolvedValue({
      deleted: [ACTIVE],
      skipped: [],
      freedBytes: 100,
      usage: usage(),
    });

    await useCloudResourceStore.getState().cleanup({ saveLocally: false });

    expect(mocks.cacheServerMedia).toHaveBeenCalledWith(
      expect.objectContaining({ id: ACTIVE.id, source: "server", serverId: ACTIVE.id }),
    );
    expect(mocks.cleanupCloudResources).toHaveBeenCalledWith({
      mediaIds: [ACTIVE.id],
      forceUnbound: true,
    });
  });

  it("aborts the whole cleanup when a local cache of an active item fails", async () => {
    useCloudResourceStore.setState({ selected: { [ACTIVE.id]: true, [ORPHAN.id]: true } });
    mocks.cacheServerMedia.mockResolvedValue(false);

    await useCloudResourceStore.getState().cleanup({ saveLocally: false });

    expect(mocks.cleanupCloudResources).not.toHaveBeenCalled();
    const state = useCloudResourceStore.getState();
    expect(state.busy).toBe(false);
    expect(state.error).toContain("已取消清理");
  });

  it("never targets media bound to a cloud project", async () => {
    useCloudResourceStore.setState({ selected: { [BOUND.id]: true } });

    await useCloudResourceStore.getState().cleanup({ saveLocally: false });

    expect(mocks.cleanupCloudResources).not.toHaveBeenCalled();
    expect(mocks.show).toHaveBeenCalledWith("请先选择要清理的云端资源", "info");
  });
});
