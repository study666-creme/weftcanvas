import { describe, expect, it } from "vitest";

import { createNodeBodyConnection } from "./node-body-connection";

describe("node body connections", () => {
  it("connects a dragged source to the target side of the dropped node", () => {
    expect(createNodeBodyConnection(
      { nodeId: "source", handleId: "right-source", handleType: "source" },
      "target",
      [],
    )).toEqual({
      source: "source",
      target: "target",
      sourceHandle: "right-source",
      targetHandle: "left-target",
    });
  });

  it("connects the source side of the dropped node to a dragged target", () => {
    expect(createNodeBodyConnection(
      { nodeId: "target", handleId: "left-target", handleType: "target" },
      "source",
      [],
    )).toEqual({
      source: "source",
      target: "target",
      sourceHandle: "right-source",
      targetHandle: "left-target",
    });
  });

  it("rejects self connections and existing directed connections", () => {
    const start = { nodeId: "source", handleId: "right-source", handleType: "source" } as const;

    expect(createNodeBodyConnection(start, "source", [])).toBeNull();
    expect(createNodeBodyConnection(start, "target", [{ source: "source", target: "target" }])).toBeNull();
  });
});
