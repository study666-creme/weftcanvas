import { describe, expect, it } from "vitest";

import {
  formatAnnouncementTime,
  isSafeAnnouncementUrl,
  parseAnnouncementBody,
} from "./announcement-content";

describe("announcement body parsing", () => {
  it("splits blank lines into paragraphs and keeps soft line breaks", () => {
    expect(parseAnnouncementBody("第一行\n第二行\n\n第二段")).toEqual([
      {
        kind: "paragraph",
        lines: [[{ kind: "text", text: "第一行" }], [{ kind: "text", text: "第二行" }]],
      },
      { kind: "paragraph", lines: [[{ kind: "text", text: "第二段" }]] },
    ]);
  });

  it("recognises bold and links inside a paragraph", () => {
    expect(parseAnnouncementBody("看 **这里** 和 [仓库](https://example.com/a)")).toEqual([
      {
        kind: "paragraph",
        lines: [
          [
            { kind: "text", text: "看 " },
            { kind: "strong", text: "这里" },
            { kind: "text", text: " 和 " },
            { kind: "link", label: "仓库", href: "https://example.com/a" },
          ],
        ],
      },
    ]);
  });

  it("turns a standalone image line into an image block", () => {
    expect(parseAnnouncementBody("说明文字\n![群二维码](/media/group.png)\n更多")).toEqual([
      { kind: "paragraph", lines: [[{ kind: "text", text: "说明文字" }]] },
      { kind: "image", src: "/media/group.png", alt: "群二维码" },
      { kind: "paragraph", lines: [[{ kind: "text", text: "更多" }]] },
    ]);
  });

  it("promotes a line that is exactly one link to an emphasised link row", () => {
    expect(
      parseAnnouncementBody("[去仓库看看](https://github.com/study666-creme/weftcanvas)"),
    ).toEqual([
      {
        kind: "linkRow",
        label: "去仓库看看",
        href: "https://github.com/study666-creme/weftcanvas",
      },
    ]);
  });

  it("keeps unsafe urls as literal text instead of links", () => {
    // 不允许的地址不变成链接：字符原样落在文本里（可能被切分成相邻文本段，
    // 渲染结果一致），断言"拼起来等于原文、且没有链接节点"。
    const asText = (body: string, lineIndex = 0) =>
      parseAnnouncementBody(body).flatMap((block) =>
        block.kind === "paragraph"
          ? block.lines[lineIndex]!.map((span) =>
              span.kind === "text" ? span.text : `<${span.kind}>`,
            )
          : [],
      );

    expect(asText("[点我](javascript:alert(1))").join("")).toBe("[点我](javascript:alert(1))");
    expect(asText("[点我](javascript:alert(1))").join("")).not.toContain("<link>");
    expect(asText("![x](javascript:void)").join("")).toBe("![x](javascript:void)");
  });

  it("accepts https, http and site-relative urls only", () => {
    expect(isSafeAnnouncementUrl("https://example.com")).toBe(true);
    expect(isSafeAnnouncementUrl("http://127.0.0.1:3000/x")).toBe(true);
    expect(isSafeAnnouncementUrl("/assets/qr.png")).toBe(true);
    expect(isSafeAnnouncementUrl("//evil.example.com")).toBe(false);
    expect(isSafeAnnouncementUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeAnnouncementUrl("data:text/html,x")).toBe(false);
    expect(isSafeAnnouncementUrl("")).toBe(false);
  });

  it("returns no blocks for an empty body", () => {
    expect(parseAnnouncementBody("\n\n")).toEqual([]);
  });
});

describe("announcement time formatting", () => {
  const now = new Date("2026-10-16T12:00:00+08:00");

  it("uses the same relative-plus-absolute shape as the reference design", () => {
    expect(formatAnnouncementTime("2026-10-06T15:10:00+08:00", now)).toBe(
      "1 周前 2026-10-06 15:10",
    );
    expect(formatAnnouncementTime("2026-10-16T11:58:00+08:00", now)).toBe(
      "2 分钟前 2026-10-16 11:58",
    );
    expect(formatAnnouncementTime("2026-10-16T11:59:40+08:00", now)).toBe("刚刚 2026-10-16 11:59");
  });

  it("renders nothing for an unusable timestamp", () => {
    expect(formatAnnouncementTime("not-a-date", now)).toBe("");
  });
});
