import { describe, expect, it } from "vitest";

import { createCanvasNode } from "./node-factory";
import { findConnectedNodeColumnPositions, findConnectedNodePosition, findOpenNodePosition } from "./node-placement";

describe("connected node placement", () => {
  it("keeps the first branch centered when the side is empty", () => {
    const anchor = createCanvasNode("text", { x: 400, y: 80 });
    const draft = createCanvasNode("text", { x: 0, y: 0 });

    expect(findConnectedNodePosition(anchor, draft, "right", [anchor])).toEqual({ x: 772, y: 80 });
  });

  it("moves a second branch vertically instead of overlapping an existing node", () => {
    const anchor = createCanvasNode("text", { x: 400, y: 80 });
    const occupied = createCanvasNode("image", { x: 772, y: 61 });
    const draft = createCanvasNode("text", { x: 0, y: 0 });
    const position = findConnectedNodePosition(anchor, draft, "right", [anchor, occupied]);

    expect(position.x).toBe(772);
    expect(position.y).toBeGreaterThan(occupied.position.y + (occupied.height ?? 0));
  });

  it("moves a center-created node to the nearest open column", () => {
    const occupied = createCanvasNode("image", { x: 400, y: 200 });
    const preferred = { x: 410, y: 210 };
    const position = findOpenNodePosition(preferred, { width: 340, height: 192 }, [occupied]);

    expect(position.x).toBeGreaterThan(occupied.position.x + (occupied.width ?? 0));
    expect(position.y).toBe(preferred.y);
  });

  it("keeps four generated results in one centered, non-overlapping column", () => {
    const anchor = createCanvasNode("image", { x: 0, y: 0 });
    const drafts = [0, 1, 2].map(() => createCanvasNode("image", { x: 0, y: 0 }));
    const positions = findConnectedNodeColumnPositions(anchor, drafts, [anchor, ...drafts]);

    expect(new Set(positions.map((position) => position.x)).size).toBe(1);
    expect(positions[0]?.x).toBe(anchor.position.x + (anchor.width ?? 0) + 64);
    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index]!.y).toBeGreaterThanOrEqual(
        positions[index - 1]!.y + (drafts[index - 1]!.height ?? 0) + 30,
      );
    }
  });

  it("shifts the whole result column when an unrelated node occupies its first slot", () => {
    const anchor = createCanvasNode("image", { x: 0, y: 0 });
    const drafts = [0, 1, 2, 3].map(() => createCanvasNode("image", { x: 0, y: 0 }));
    const first = findConnectedNodeColumnPositions(anchor, drafts, [anchor, ...drafts]);
    const blocker = createCanvasNode("image", first[0]!);
    const positions = findConnectedNodeColumnPositions(anchor, drafts, [anchor, blocker, ...drafts]);

    expect(new Set(positions.map((position) => position.x)).size).toBe(1);
    expect(positions[0]!.y).not.toBe(first[0]!.y);
    expect(positions.every((position, index) => position.y >= first[0]!.y || index === 0)).toBe(true);
  });
});
