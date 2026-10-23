import type { CanvasMedia } from "@weftcanvas/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./media-store", () => ({
  storeMedia: vi.fn(),
  uploadMediaToServer: vi.fn(),
}));

const cloud = vi.hoisted(() => ({
  projectId: "project-local",
  links: {} as Record<string, unknown>,
}));

vi.mock("../state/canvas-store", () => ({
  useCanvasStore: { getState: () => ({ projectId: cloud.projectId }) },
}));

vi.mock("../state/cloud-project-store", () => ({
  useCloudProjectStore: { getState: () => ({ links: cloud.links }) },
}));

import { storeMedia, uploadMediaToServer } from "./media-store";
import { uploadCanvasFile } from "./canvas-media-upload";
import { useUiPreferencesStore } from "../state/ui-preferences-store";

const LOCAL_MEDIA: CanvasMedia = {
  id: "local-media-1",
  name: "tone.mp3",
  mimeType: "audio/mpeg",
  size: 3,
  source: "local",
  serverId: null,
  width: null,
  height: null,
  durationMs: null,
};

const SERVER_MEDIA: CanvasMedia = {
  ...LOCAL_MEDIA,
  id: "server-media-1",
  source: "server",
  serverId: "server-media-1",
};

const audioFile = () => new File([new Uint8Array([1, 2, 3])], "tone.mp3", { type: "" });

describe("uploadCanvasFile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiPreferencesStore.setState({ localMediaOnly: false });
    cloud.projectId = "project-local";
    cloud.links = {};
  });

  it("uploads audio to the server first", async () => {
    vi.mocked(uploadMediaToServer).mockResolvedValue(SERVER_MEDIA);

    await expect(uploadCanvasFile(audioFile(), "audio")).resolves.toEqual(SERVER_MEDIA);
    expect(uploadMediaToServer).toHaveBeenCalledWith(expect.any(File), "audio", undefined);
    expect(storeMedia).not.toHaveBeenCalled();
  });

  it("scopes the upload to the cloud project so the node can read it back", async () => {
    cloud.projectId = "project-cloud";
    cloud.links = { "project-cloud": { projectId: "project-cloud" } };
    vi.mocked(uploadMediaToServer).mockResolvedValue(SERVER_MEDIA);

    await uploadCanvasFile(audioFile(), "audio");

    // 读取渠道带 projectId 时只认已绑定素材；上传不带项目会让回显先 404。
    expect(uploadMediaToServer).toHaveBeenCalledWith(expect.any(File), "audio", "project-cloud");
  });

  it("keeps local projects on the account scope", async () => {
    cloud.projectId = "project-local";
    vi.mocked(uploadMediaToServer).mockResolvedValue(SERVER_MEDIA);

    await uploadCanvasFile(audioFile(), "audio");

    expect(uploadMediaToServer).toHaveBeenCalledWith(expect.any(File), "audio", undefined);
  });

  it("falls back to the local media library when the server is unavailable", async () => {
    vi.mocked(uploadMediaToServer).mockRejectedValue(new Error("offline"));
    vi.mocked(storeMedia).mockResolvedValue(LOCAL_MEDIA);

    await expect(uploadCanvasFile(audioFile(), "audio")).resolves.toEqual(LOCAL_MEDIA);
    expect(storeMedia).toHaveBeenCalledWith(expect.any(File), "audio");
  });

  it("never touches the server when only-local saving is on", async () => {
    useUiPreferencesStore.setState({ localMediaOnly: true });
    vi.mocked(storeMedia).mockResolvedValue(LOCAL_MEDIA);

    await expect(uploadCanvasFile(audioFile(), "audio")).resolves.toEqual(LOCAL_MEDIA);
    expect(uploadMediaToServer).not.toHaveBeenCalled();
  });

  it("surfaces the local failure when only-local saving is on", async () => {
    useUiPreferencesStore.setState({ localMediaOnly: true });
    vi.mocked(storeMedia).mockRejectedValue(new Error("浏览器存储空间不足"));

    await expect(uploadCanvasFile(audioFile(), "audio")).rejects.toThrow("浏览器存储空间不足");
    expect(uploadMediaToServer).not.toHaveBeenCalled();
  });
});
