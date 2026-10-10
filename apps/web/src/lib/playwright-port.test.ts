import { describe, expect, it } from "vitest";

import { DEFAULT_PLAYWRIGHT_PORT, resolvePlaywrightPort } from "../../playwright-port";

describe("playwright port override", () => {
  it("keeps the default port without an override", () => {
    expect(resolvePlaywrightPort(undefined)).toBe(DEFAULT_PLAYWRIGHT_PORT);
    expect(resolvePlaywrightPort("")).toBe(DEFAULT_PLAYWRIGHT_PORT);
  });

  it("uses a validated numeric override for the local web server", () => {
    expect(resolvePlaywrightPort("4174")).toBe(4174);
  });

  it("rejects non-numeric and out-of-range overrides", () => {
    expect(resolvePlaywrightPort("vite")).toBe(DEFAULT_PLAYWRIGHT_PORT);
    expect(resolvePlaywrightPort("0")).toBe(DEFAULT_PLAYWRIGHT_PORT);
    expect(resolvePlaywrightPort("-1")).toBe(DEFAULT_PLAYWRIGHT_PORT);
    expect(resolvePlaywrightPort("65536")).toBe(DEFAULT_PLAYWRIGHT_PORT);
    expect(resolvePlaywrightPort("4173.5")).toBe(DEFAULT_PLAYWRIGHT_PORT);
  });
});
