import { describe, expect, it } from "vitest";

import { CanvasApiError } from "../lib/api-client";
import {
  COLLABORATION_ACCESS_LABEL,
  COLLABORATION_SEAT_LIMIT_MESSAGE,
  COLLABORATION_SEAT_POLICY_LABEL,
  collaborationApiMessage,
} from "./collaboration-dialog";

describe("collaboration seat messaging", () => {
  it("explains the free five-person account-wide collaboration limit", () => {
    expect(COLLABORATION_ACCESS_LABEL).toBe("协作最多 5 人");
    expect(COLLABORATION_SEAT_POLICY_LABEL).toContain("最多 4 名协作者");
    expect(COLLABORATION_SEAT_POLICY_LABEL).toContain("当前限免");
    expect(COLLABORATION_SEAT_POLICY_LABEL).toContain("跨项目复用");
  });

  it("replaces the seat-limit API detail with a stable actionable message", () => {
    const error = new CanvasApiError(
      409,
      "COLLABORATION_SEAT_LIMIT_REACHED",
      "opaque backend detail",
    );

    expect(collaborationApiMessage(error, "邀请发送失败")).toBe(COLLABORATION_SEAT_LIMIT_MESSAGE);
    expect(COLLABORATION_SEAT_LIMIT_MESSAGE).toContain("5 人上限");
    expect(COLLABORATION_SEAT_LIMIT_MESSAGE).toContain("取消待处理邀请");
  });

  it("keeps API messages for other known failures and fallbacks for unknown errors", () => {
    expect(collaborationApiMessage(
      new CanvasApiError(403, "COLLABORATION_PRO_REQUIRED", "需要专业会员"),
      "邀请发送失败",
    )).toBe("需要专业会员");
    expect(collaborationApiMessage(new Error("network"), "邀请发送失败")).toBe("邀请发送失败");
  });
});
