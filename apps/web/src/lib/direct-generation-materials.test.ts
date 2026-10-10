import { describe, expect, it } from "vitest";

import { planMaterialBatch } from "./direct-generation-materials";

describe("planMaterialBatch", () => {
  it("accepts every file while slot capacity remains", () => {
    expect(planMaterialBatch(0, 3, 2)).toEqual({ accepted: 2, overflow: 0, full: false });
    expect(planMaterialBatch(1, 3, 2)).toEqual({ accepted: 2, overflow: 0, full: false });
  });

  it("slices to the remaining capacity and reports the overflow", () => {
    expect(planMaterialBatch(2, 3, 5)).toEqual({ accepted: 1, overflow: 4, full: false });
    expect(planMaterialBatch(3, 3, 2)).toEqual({ accepted: 0, overflow: 2, full: true });
  });

  it("is full when the model starts with zero capacity", () => {
    expect(planMaterialBatch(0, 0, 1)).toEqual({ accepted: 0, overflow: 1, full: true });
  });

  it("never accepts a negative gap", () => {
    expect(planMaterialBatch(5, 3, 4)).toEqual({ accepted: 0, overflow: 4, full: true });
  });
});
