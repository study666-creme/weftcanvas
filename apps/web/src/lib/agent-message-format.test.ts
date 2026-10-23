import { describe, expect, it } from "vitest";

import { formatAgentMessage } from "./agent-message-format";

describe("formatAgentMessage", () => {
  it("keeps plain prose as paragraphs split by blank lines", () => {
    expect(formatAgentMessage("第一段\n还是第一段。\n\n第二段。")).toEqual([
      { type: "paragraph", text: "第一段\n还是第一段。" },
      { type: "paragraph", text: "第二段。" },
    ]);
  });

  it("groups consecutive ordered items into one list", () => {
    expect(formatAgentMessage("可以先做三件事：\n1. 补环境\n2. 统一风格\n3. 加空镜")).toEqual([
      { type: "paragraph", text: "可以先做三件事：" },
      { type: "list", ordered: true, items: ["补环境", "统一风格", "加空镜"] },
    ]);
  });

  it("treats bullets and numbered items as different lists", () => {
    expect(formatAgentMessage("- 甲\n- 乙\n1. 丙")).toEqual([
      { type: "list", ordered: false, items: ["甲", "乙"] },
      { type: "list", ordered: true, items: ["丙"] },
    ]);
  });

  it("parses headings, quotes and fenced code", () => {
    expect(
      formatAgentMessage("### 下一步\n> 先稳住节奏\n```\nprompt: 雨夜街道\n```\n收尾。"),
    ).toEqual([
      { type: "heading", text: "下一步" },
      { type: "quote", text: "先稳住节奏" },
      { type: "code", text: "prompt: 雨夜街道" },
      { type: "paragraph", text: "收尾。" },
    ]);
  });

  it("leaves inline emphasis for the renderer instead of eating the text", () => {
    expect(formatAgentMessage("建议先补 **环境镜头**，再让 `shot-2` 接上。")).toEqual([
      { type: "paragraph", text: "建议先补 **环境镜头**，再让 `shot-2` 接上。" },
    ]);
  });

  it("does not mistake a bare hash line for a heading", () => {
    expect(formatAgentMessage("#标签在这句话里")).toEqual([
      { type: "paragraph", text: "#标签在这句话里" },
    ]);
  });
});
