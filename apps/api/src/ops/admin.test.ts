import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { WeftcanvasCatalogAdapter } from "../catalog/adapter.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { buildNonMjSourceCatalog } from "../catalog/nonmj-catalog-fixture.js";
import { MemoryModelOverrideStore } from "../catalog/overrides.js";
import { CanvasOpsService } from "./service.js";
import type { OpsStore } from "./store.js";

const NOW = Date.parse("2026-10-13T12:00:00.000Z");

const store: OpsStore = {
  async countUsers() {
    return 3;
  },
  async countProjects() {
    return 1;
  },
  async mediaTotals() {
    return { count: 4, bytes: 1234 };
  },
  async jobCounts() {
    return {
      completed: 2,
      failed: 1,
      inFlight: 0,
      staleInFlight: 0,
      oldestInFlightUpdatedAt: null,
    };
  },
  async recentJobs(status, limit) {
    return [
      {
        id: "job-1",
        ownerId: "owner-1",
        modelId: "m-1",
        modality: "image",
        status: "failed",
        errorCode: "UPSTREAM_TIMEOUT",
        createdAt: new Date(NOW).toISOString(),
        updatedAt: new Date(NOW).toISOString(),
      },
    ].slice(0, limit);
  },
};

function appWith(options: { opsAdminSecret?: string } = {}) {
  const adapter = new WeftcanvasCatalogAdapter({
    sourceUrl: "https://catalog.test/models",
    store: new MemoryCatalogSnapshotStore(),
    overrides: new MemoryModelOverrideStore(),
    now: () => NOW,
    fetch: async () =>
      new Response(JSON.stringify(buildNonMjSourceCatalog()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  });
  return createApiApp({
    catalog: adapter,
    quotes: new GenerationQuoteService(adapter, { now: () => NOW }),
    ops: new CanvasOpsService({
      store,
      readCatalogStatus: async () => ({ version: "v", quoteAvailable: true, expiresAt: null }),
      now: () => NOW,
    }),
    ...(options.opsAdminSecret ? { opsAdminSecret: options.opsAdminSecret } : {}),
  });
}

describe("canvas ops admin routes", () => {
  it("is invisible without the secret header", async () => {
    const app = appWith({ opsAdminSecret: "s3cret" });
    expect((await app.request("/api/v1/admin/ops/overview")).status).toBe(404);
    expect((await app.request("/api/v1/admin/ops/jobs")).status).toBe(404);
    expect(
      (
        await app.request("/api/v1/admin/ops/overview", {
          headers: { "x-canvas-ops-secret": "nope" },
        })
      ).status,
    ).toBe(404);
  });

  it("is invisible when no ops secret is configured at all", async () => {
    const app = appWith();
    expect(
      (await app.request("/api/v1/admin/ops/overview", { headers: { "x-canvas-ops-secret": "" } }))
        .status,
    ).toBe(404);
  });

  it("serves overview and job rows behind the secret", async () => {
    const app = appWith({ opsAdminSecret: "s3cret" });
    const headers = { "x-canvas-ops-secret": "s3cret" };

    const overviewResponse = await app.request("/api/v1/admin/ops/overview", { headers });
    expect(overviewResponse.status).toBe(200);
    expect(overviewResponse.headers.get("cache-control")).toBe("no-store");
    const overview = (await overviewResponse.json()) as { ok: boolean; data: { users: number } };
    expect(overview.data.users).toBe(3);

    const jobs = (await (
      await app.request("/api/v1/admin/ops/jobs?status=failed&limit=10", { headers })
    ).json()) as { data: { jobs: Array<{ errorCode: string }> } };
    expect(jobs.data.jobs[0]?.errorCode).toBe("UPSTREAM_TIMEOUT");
  });

  it("serves the console page for humans without leaking it to crawlers", async () => {
    const app = appWith({ opsAdminSecret: "s3cret" });
    const page = await app.request("/admin/ops");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await page.text()).toContain("画布运营后台");
  });
});
