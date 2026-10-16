import { describe, expect, it } from "vitest";

import {
  isAllowedMediaHost,
  parseCanvasImportReference,
  parseLibTVReference,
  parseTapNowReference,
  parseUpDreamReference,
} from "./reference.js";

describe("LibTV 画布标识", () => {
  it("接受 32 位 UUID、裸 UUID 链接与画布链接", () => {
    const uuid = "0123456789abcdef0123456789ABCDEF";
    expect(parseLibTVReference(uuid)).toBe(uuid.toLowerCase());
    expect(parseLibTVReference(`https://www.liblib.tv/canvas?projectId=${uuid}`)).toBe(
      uuid.toLowerCase(),
    );
    expect(parseLibTVReference(`https://www.liblib.tv/canvas?uuid=${uuid}&mode=editor`)).toBe(
      uuid.toLowerCase(),
    );
    expect(parseLibTVReference(`https://www.liblib.tv/canvas/${uuid}`)).toBe(uuid.toLowerCase());
  });

  it("拒绝非 UUID、别家链接与空输入", () => {
    expect(parseLibTVReference("")).toBe("");
    expect(parseLibTVReference("not-a-uuid")).toBe("");
    expect(
      parseLibTVReference(
        "https://evil.example.com/canvas?projectId=0123456789abcdef0123456789abcdef",
      ),
    ).toBe("");
  });
});

describe("TapNow 分享标识", () => {
  it("接受分享链接与裸分享 ID", () => {
    expect(parseTapNowReference("AbC-123_x")).toBe("AbC-123_x");
    expect(parseTapNowReference("https://app.tapnow.media/tapflow/view/AbC123")).toBe("AbC123");
  });

  it("拒绝别家主机、非分享路径与非法字符", () => {
    expect(parseTapNowReference("https://evil.tapnow.media/tapflow/view/AbC123")).toBe("");
    expect(parseTapNowReference("https://app.tapnow.media/project/AbC123")).toBe("");
    expect(parseTapNowReference("bad id!")).toBe("");
  });
});

describe("UpDream 分享口令", () => {
  it("从整段口令文本里取出标识", () => {
    expect(parseUpDreamReference("share://abc123")).toBe("abc123");
    expect(parseUpDreamReference("复制分享口令 share://AbC_9-x，打开【updream】粘贴查看～")).toBe(
      "AbC_9-x",
    );
    expect(parseUpDreamReference("123:node:share")).toBe("123:node:share");
  });

  it("拒绝空输入与含空白的口令", () => {
    expect(parseUpDreamReference("")).toBe("");
    expect(parseUpDreamReference("bad code")).toBe("");
  });
});

describe("按来源分发解析", () => {
  it("每个来源只认自己的标识形态", () => {
    const uuid = "0123456789abcdef0123456789abcdef";
    expect(parseCanvasImportReference("libtv", uuid)).toBe(uuid);
    expect(parseCanvasImportReference("tapnow", uuid)).toBe(uuid);
    expect(parseCanvasImportReference("updream", `share://${uuid}`)).toBe(uuid);
    expect(parseCanvasImportReference("updream", uuid)).toBe(uuid);
  });
});

describe("素材域名白名单", () => {
  it("只放行各来源自己的媒体域及其子域", () => {
    expect(isAllowedMediaHost("libtv", "libtv-res.liblib.art")).toBe(true);
    expect(isAllowedMediaHost("libtv", "evil-liblib.art")).toBe(false);
    expect(isAllowedMediaHost("tapnow", "files.tapnow.media")).toBe(true);
    expect(isAllowedMediaHost("tapnow", "files.tapnow.media.evil.com")).toBe(false);
    expect(isAllowedMediaHost("updream", "s1.hdslb.com")).toBe(true);
    expect(isAllowedMediaHost("updream", "hdslb.com.evil.com")).toBe(false);
    expect(isAllowedMediaHost("updream", "127.0.0.1")).toBe(false);
  });
});
