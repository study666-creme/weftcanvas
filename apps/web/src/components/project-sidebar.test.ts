import type { CloudProjectSummary } from "@kachang/contracts";
import { describe, expect, it } from "vitest";

import { CLOUD_QUOTA_LOCAL_MESSAGE, CLOUD_SIZE_LOCAL_MESSAGE } from "../state/cloud-project-store";
import { cloudButtonLabel, selectCloudOpenCandidates } from "./project-sidebar";

describe("cloud project sidebar candidates", () => {
  it("keeps a same-id remote project visible until the local project is linked", () => {
    const shared = cloudSummary("project-shared");
    const remoteOnly = cloudSummary("project-remote-only");
    const localProjects = [{ id: shared.id }];

    expect(selectCloudOpenCandidates([shared, remoteOnly], localProjects, {}).map((project) => project.id))
      .toEqual([shared.id, remoteOnly.id]);
    expect(selectCloudOpenCandidates([shared, remoteOnly], localProjects, { [shared.id]: {} }).map((project) => project.id))
      .toEqual([remoteOnly.id]);
  });

  it("makes local-only persistence and the explicit retry visible in the cloud action", () => {
    const label = cloudButtonLabel("authenticated", true, "local-only");

    expect(label).toContain(CLOUD_QUOTA_LOCAL_MESSAGE);
    expect(label).toContain("重试");
  });

  it("shows the persisted hard-size reason while keeping retry explicit", () => {
    const label = cloudButtonLabel("authenticated", true, "local-only", CLOUD_SIZE_LOCAL_MESSAGE);

    expect(label).toContain(CLOUD_SIZE_LOCAL_MESSAGE);
    expect(label).toContain("重试");
    expect(label).not.toContain(CLOUD_QUOTA_LOCAL_MESSAGE);
  });
});

function cloudSummary(id: string): CloudProjectSummary {
  return {
    schemaVersion: 1,
    id,
    title: id,
    revision: 1,
    documentBytes: 100,
    localMediaCount: 0,
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}
