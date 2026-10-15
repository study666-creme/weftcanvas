import { describe, expect, it } from "vitest";

import { createApiApp } from "../app.js";
import { WeftcanvasCatalogAdapter } from "../catalog/adapter.js";
import { MemoryCatalogSnapshotStore } from "../catalog/store.js";
import { GenerationQuoteService } from "../catalog/quote.js";
import { buildNonMjSourceCatalog } from "../catalog/nonmj-catalog-fixture.js";
import { MemoryModelOverrideStore } from "../catalog/overrides.js";
import { CanvasOpsService } from "./service.js";
import type { OpsStore, OpsUserQuery } from "./store.js";

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
  async recentUsers(input: OpsUserQuery) {
    return {
      total: 1,
      users: [
        {
          id: "owner-1",
          email: "ops@example.com",
          displayName: "运营",
          status: "active" as const,
          createdAt: new Date(NOW).toISOString(),
          lastLoginAt: new Date(NOW).toISOString(),
          credits: 12.5,
          projects: 2,
          mediaCount: 4,
          mediaBytes: 1234,
          jobs: 3,
          jobsCompleted: 2,
          jobsFailed: 1,
        },
      ]
        .filter((u) => !input.query || u.email.includes(input.query))
        .slice(0, input.limit),
    };
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
    expect((await app.request("/api/v1/admin/ops/users")).status).toBe(404);
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

  it("serves the user directory behind the secret", async () => {
    const app = appWith({ opsAdminSecret: "s3cret" });
    const headers = { "x-canvas-ops-secret": "s3cret" };

    const response = await app.request("/api/v1/admin/ops/users?limit=10", { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const payload = (await response.json()) as {
      data: { total: number; users: Array<{ email: string; credits: number }> };
    };
    expect(payload.data.total).toBe(1);
    expect(payload.data.users[0]?.email).toBe("ops@example.com");
    expect(payload.data.users[0]?.credits).toBe(12.5);
  });

  it("serves the console page for humans without leaking it to crawlers", async () => {
    const app = appWith({ opsAdminSecret: "s3cret" });
    const page = await app.request("/admin/ops");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const html = await page.text();
    expect(html).toContain("画布运营后台");
    // 四个分区都在，且带画布同款配色切换（石墨 / 墨黑）。
    for (const tab of ["概览", "用户", "任务", "模型运营"]) expect(html).toContain(tab);
    expect(html).toContain('data-wc-theme-set="light"');
    expect(html).toContain('data-wc-theme-set="dark"');
    expect(html).toContain("--wc-canvas: #e7e8e5");
    expect(html).toContain("--wc-canvas: #141414");
    expect(html).toContain("/api/v1/admin/ops/users");
  });
});
