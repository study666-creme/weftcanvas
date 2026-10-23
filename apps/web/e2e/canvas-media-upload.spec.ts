import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";

type NetworkState = { unmocked: string[]; external: string[] };

async function installNetworkGuard(page: Page, network: NetworkState) {
  let expectedOrigin: string | null = null;
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expectedOrigin ??= url.origin;
    if (url.origin !== expectedOrigin) {
      network.external.push(`${request.method()} ${url.href}`);
      await route.abort("blockedbyclient");
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      network.unmocked.push(`${request.method()} ${url.pathname}${url.search}`);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

const NOW = new Date().toISOString();
const EXPIRES_AT = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const USER_ID = "66666666-6666-4666-8666-666666666666";
const AUDIO_BYTES = readFileSync(fileURLToPath(new URL("./audio-tone.mp3", import.meta.url)));

const session = {
  user: { id: USER_ID, email: "upload@example.com", displayName: "上传创作者", createdAt: NOW },
  expiresAt: EXPIRES_AT,
};

function catalog() {
  return {
    version: "upload-catalog",
    capabilityVersion: "upload-capability",
    pricingVersion: "upload-pricing",
    fetchedAt: NOW,
    expiresAt: EXPIRES_AT,
    quoteAvailable: true,
    models: [],
  };
}

function walletSummary(credits: number) {
  return {
    credits,
    creditsPermanent: credits,
    dailyCredits: 0,
    creditGrantMode: "bundle" as const,
    dailyCreditsNote: "",
    membership: { tier: null, until: null, active: false, genDiscount: null },
    lifetimeCreditsSpent: 0,
  };
}

/**
 * 音频上传回归：拖入/导入的音频要落成音频节点；节点「上传音频」要接受
 * file.type 为空的文件（Windows 上很常见）；打开「只保存本地」后这些
 * 路径都不应再发任何云端素材请求。
 */
test("画布可上传音频，且「只保存本地」时不上传云端", async ({ page }) => {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("wc-e2e-seeded") !== "1") {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem("wc-e2e-seeded", "1");
    }
    localStorage.setItem("weftcanvas:onboarding:v1", "done");
    localStorage.setItem("weftcanvas:ui-preferences:v1", JSON.stringify({ localMediaOnly: true }));
    const popup = {
      closed: false,
      opener: null,
      location: { replace: () => undefined },
      close: () => undefined,
    };
    Object.defineProperty(window, "open", {
      configurable: true,
      value: () => popup as unknown as Window,
    });
  });

  const network: NetworkState = { unmocked: [], external: [] };
  await installNetworkGuard(page, network);
  await mockAuthenticatedBackgroundApis(page);

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: session } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({ json: { ok: true, data: catalog() } }),
  );
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({ json: { ok: true, data: walletSummary(100) } }),
  );
  await page.route("**/api/v1/generation-jobs*", (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );
  await page.route(/\/api\/v1\/announcements(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ok: true, data: { items: [] } } }),
  );
  await page.route(/\/api\/v1\/agent\/connectors(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );

  await page.goto("/canvas");
  await expect(page.locator("[data-save-state]")).toBeVisible();

  // 1) 画布导入素材：MIME 为空的 mp3（Windows 下载常见）必须落成音频节点。
  const createTools = page.getByRole("navigation", { name: "创建工具" });
  const chooser = page.waitForEvent("filechooser");
  await createTools.getByRole("button", { name: "导入素材" }).click();
  await (await chooser).setFiles([{ name: "canvas-tone.mp3", mimeType: "", buffer: AUDIO_BYTES }]);

  const audioNodes = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="audio"])',
  );
  await expect(audioNodes).toHaveCount(1);
  await expect(audioNodes.first().locator(".wc-mini-player")).toBeVisible();
  await expect(audioNodes.first().getByRole("button", { name: "播放" })).toBeVisible();

  // 2) 节点「上传音频」：同一份空 MIME 文件也要被内容识别接住。
  await createTools.locator(".wc-create-rail-plus-wrapper").hover();
  await createTools.getByRole("menuitem", { name: "添加音频节点" }).click();
  await expect(audioNodes).toHaveCount(2);
  const emptyAudioNode = audioNodes.last();
  await emptyAudioNode
    .locator('input[type="file"]')
    .setInputFiles({ name: "node-tone.mp3", mimeType: "", buffer: AUDIO_BYTES });
  await expect(emptyAudioNode.locator(".wc-mini-player")).toBeVisible();

  // 3) 设置 → 本地保存：开关已打开，并且上面的上传没有发出任何云端素材请求。
  await page.getByRole("button", { name: "打开设置" }).click();
  const settings = page.getByRole("dialog", { name: "设置" });
  await settings.getByRole("tab", { name: "本地保存" }).click();
  await expect(settings.getByRole("checkbox", { name: "只保存本地" })).toBeChecked();

  expect(
    network.unmocked.filter((entry) => entry.startsWith("POST ") && entry.includes("/media")),
    `cloud media requests: ${network.unmocked.join(", ")}`,
  ).toEqual([]);
  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
});
