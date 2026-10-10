import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readAgentCreativeGuidance, readProfessionalBaselineStatus, writeAgentCreativeGuidance } from "./agent-creative-guidance";

describe("agent creative guidance", () => {
  beforeEach(() => installMemoryStorage());

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("defaults each project to freeform collaboration", () => {
    expect(readAgentCreativeGuidance("project-1")).toEqual({
      mode: "freeform",
      baseline: { aspectRatio: null, visualStyle: null, targetDuration: null, locked: false },
    });
  });

  it("keeps a professional baseline independent for each project", () => {
    writeAgentCreativeGuidance("project-1", {
      mode: "professional",
      baseline: { aspectRatio: "9:16", visualStyle: "手绘水彩", targetDuration: "30 秒", locked: true },
    });

    expect(readAgentCreativeGuidance("project-1")).toMatchObject({
      mode: "professional",
      baseline: { aspectRatio: "9:16", locked: true },
    });
    expect(readAgentCreativeGuidance("project-2").mode).toBe("freeform");
  });

  it("normalizes the legacy baseline mode to professional", () => {
    localStorage.setItem("kachang-canvas:agent-creative-guidance:v1:project-1", JSON.stringify({
      mode: "baseline",
      baseline: { aspectRatio: "16:9", visualStyle: "电影写实", targetDuration: "60 秒", locked: true },
    }));

    expect(readAgentCreativeGuidance("project-1")).toMatchObject({
      mode: "professional",
      baseline: { aspectRatio: "16:9", visualStyle: "电影写实", targetDuration: "60 秒", locked: true },
    });
    expect(JSON.parse(localStorage.getItem("kachang-canvas:agent-creative-guidance:v1:project-1")!).mode)
      .toBe("professional");
    expect(writeAgentCreativeGuidance("project-2", {
      mode: "baseline",
      baseline: { aspectRatio: null, visualStyle: null, targetDuration: null, locked: false },
    }).mode).toBe("professional");
  });

  it("does not reuse malformed saved guidance", () => {
    localStorage.setItem("kachang-canvas:agent-creative-guidance:v1:project-1", "{not-json");
    expect(readAgentCreativeGuidance("project-1").mode).toBe("freeform");
  });

  it("requires a complete locked baseline only in professional mode", () => {
    expect(readProfessionalBaselineStatus({
      mode: "professional",
      baseline: { aspectRatio: "16:9", visualStyle: null, targetDuration: null, locked: false },
    })).toEqual({
      required: true,
      ready: false,
      missing: ["画风", "目标时长", "确认并锁定基线"],
    });
    expect(readProfessionalBaselineStatus({
      mode: "professional",
      baseline: { aspectRatio: "16:9", visualStyle: "电影写实", targetDuration: "30 秒", locked: true },
    })).toEqual({ required: true, ready: true, missing: [] });
    expect(readProfessionalBaselineStatus({
      mode: "freeform",
      baseline: { aspectRatio: null, visualStyle: null, targetDuration: null, locked: false },
    })).toEqual({ required: false, ready: true, missing: [] });
  });
});

function installMemoryStorage() {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() { return entries.size; },
    clear: () => entries.clear(),
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => [...entries.keys()][index] ?? null,
    removeItem: (key) => { entries.delete(key); },
    setItem: (key, value) => { entries.set(key, value); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
}
