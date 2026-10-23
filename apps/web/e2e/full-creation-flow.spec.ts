import { expect, test, type Locator, type Page } from "@playwright/test";

import { mockAuthenticatedBackgroundApis } from "./authenticated-background.fixture";
import { skipOnboardingTour } from "./onboarding.fixture";

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

async function dragNodeConnection(page: Page, source: Locator, target: Locator) {
  const sourceCore = source.locator(".wc-node-port-zone--right .wc-node-port-core");
  const targetSurface = target.locator(".wc-node-surface");
  await source.hover();
  await expect(sourceCore).toBeVisible();
  const sourceBox = await sourceCore.boundingBox();
  const targetBox = await targetSurface.boundingBox();
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();

  const sourcePoint = {
    x: sourceBox!.x + sourceBox!.width / 2,
    y: sourceBox!.y + sourceBox!.height / 2,
  };
  const targetPoint = {
    x: targetBox!.x + targetBox!.width / 2,
    y: targetBox!.y + targetBox!.height / 2,
  };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 14 });
  await page.mouse.up();
}

async function panNodeNearTop(
  page: Page,
  node: Locator,
  viewport: { width: number; height: number },
) {
  await page.waitForTimeout(350);
  const targetY = 220;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const box = await node.boundingBox();
    if (!box) return;
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const dx = Math.round(viewport.width / 2 - centerX);
    const dy = Math.round(targetY - centerY);
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
    const paneBox = await page.locator(".react-flow__pane").boundingBox();
    const startX = paneBox ? paneBox.x + paneBox.width / 2 : viewport.width / 2;
    const startY = paneBox ? paneBox.y + paneBox.height / 2 : viewport.height / 2;
    await page.keyboard.down("Space");
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dx, startY + dy, { steps: 12 });
    await page.mouse.up();
    await page.keyboard.up("Space");
    await page.waitForTimeout(100);
  }
}

async function deselectCanvas(page: Page) {
  const blank = await page.evaluate(() => {
    const candidates = [
      { x: 90, y: 130 },
      { x: 240, y: 130 },
      { x: 1_300, y: 130 },
      { x: 1_300, y: 500 },
      { x: 90, y: 700 },
      { x: 1_300, y: 700 },
    ];
    const obscured = (x: number, y: number) => {
      const element = document.elementFromPoint(x, y);
      if (!element) return true;
      return Boolean(
        element.closest(
          ".react-flow__node-weftcanvas, .wc-node-prompt-shell, .wc-node-config-shell, .wc-edit-dock, .wc-create-rail, .wc-project-sidebar, .wc-zoom-control, .wc-resource-drawer, .wc-agent-drawer, .wc-connection-preview",
        ),
      );
    };
    return candidates.find((point) => !obscured(point.x, point.y)) ?? { x: 700, y: 130 };
  });
  await page.mouse.click(blank.x, blank.y);
  await expect(page.locator("[data-node-prompt-composer]")).toHaveCount(0);
}

const NOW = new Date().toISOString();
const EXPIRES_AT = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const USER_ID = "11111111-1111-4111-8111-111111111111";
const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const VIDEO_BYTES = Buffer.from("weftcanvas-e2e-video", "utf8");

const session = {
  user: {
    id: USER_ID,
    email: "creator@example.com",
    displayName: "创作者",
    createdAt: NOW,
  },
  expiresAt: EXPIRES_AT,
};

const capabilities = {
  available: true,
  registration: "external" as const,
  registrationUrl: "https://accounts.example.com/register",
  passwordResetUrl: "https://accounts.example.com/forgot-password",
};

function model(modality: "image" | "video") {
  if (modality === "image") {
    return {
      id: "e2e-image-model",
      label: "画面生成模型",
      description: "平台图片模型",
      modality,
      operation: "generate",
      order: 1,
      input: { textRequired: true, images: { min: 0, max: 2, multiple: true } },
      output: { type: "image", minCount: 1, maxCount: 1 },
      parameters: [
        {
          name: "prompt",
          label: "提示词",
          type: "string",
          required: true,
          mutuallyExclusiveWith: [],
        },
        {
          name: "size",
          label: "画面比例",
          type: "string",
          required: false,
          default: "1:1",
          options: ["1:1", "16:9"],
          mutuallyExclusiveWith: [],
        },
      ],
      pricing: {
        mode: "fixed",
        unit: "image",
        currency: "CNY",
        creditsPerYuan: 100,
        baseCreditMicros: 2_000_000,
        baseYuanMicros: 20_000,
        tiers: [],
      },
    };
  }
  return {
    id: "e2e-video-model",
    label: "镜头生成模型",
    description: "平台视频模型",
    modality,
    operation: "generate",
    order: 1,
    input: { textRequired: true, images: { min: 0, max: 1, multiple: false } },
    output: { type: "video", minCount: 1, maxCount: 1 },
    parameters: [
      {
        name: "prompt",
        label: "提示词",
        type: "string",
        required: true,
        mutuallyExclusiveWith: [],
      },
      {
        name: "seconds",
        label: "时长（秒）",
        type: "integer",
        required: false,
        default: 1,
        options: [1, 2],
        mutuallyExclusiveWith: [],
      },
      {
        name: "aspect_ratio",
        label: "画面比例",
        type: "string",
        required: false,
        default: "16:9",
        options: ["16:9", "9:16"],
        mutuallyExclusiveWith: [],
      },
    ],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 5_000_000,
      baseYuanMicros: 50_000,
      tiers: [],
    },
  };
}

function catalog(modality: "image" | "video") {
  return {
    version: "full-flow-catalog",
    capabilityVersion: "full-flow-capability",
    pricingVersion: "full-flow-pricing",
    fetchedAt: NOW,
    expiresAt: EXPIRES_AT,
    quoteAvailable: true,
    models: [model(modality)],
  };
}

function summary(credits: number) {
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

function quote(modality: "image" | "video", parameters: Record<string, unknown>) {
  return {
    id: `quote-${modality}`,
    modelId: `e2e-${modality}-model`,
    modelLabel: modality === "image" ? "画面生成模型" : "镜头生成模型",
    modality,
    quantity: 1,
    normalizedParameters: parameters,
    creditMicros: modality === "image" ? 2_000_000 : 5_000_000,
    credits: modality === "image" ? "2" : "5",
    yuanMicros: modality === "image" ? 20_000 : 50_000,
    yuan: modality === "image" ? "0.02" : "0.05",
    estimated: false,
    pricingUnit: modality === "image" ? "image" : "request",
    catalogVersion: "full-flow-catalog",
    capabilityVersion: "full-flow-capability",
    pricingVersion: "full-flow-pricing",
    expiresAt: EXPIRES_AT,
  };
}

function mediaArtifact(modality: "image" | "video", mediaId: string) {
  return modality === "image"
    ? {
        id: `artifact-${mediaId}`,
        kind: "image" as const,
        mediaId,
        name: "generated.png",
        mimeType: "image/png",
        size: PIXEL.length,
        width: 1,
        height: 1,
        createdAt: NOW,
      }
    : {
        id: `artifact-${mediaId}`,
        kind: "video" as const,
        mediaId,
        name: "generated.mp4",
        mimeType: "video/mp4",
        size: VIDEO_BYTES.length,
        width: 16,
        height: 9,
        duration: 1,
        createdAt: NOW,
      };
}

async function seedBrowser(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("wc-e2e-seeded") !== "1") {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem("wc-e2e-seeded", "1");
    }
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
}

test("登录后可连续生成图片、视频并完成积分充值", async ({ page }) => {
  await seedBrowser(page);
  const network: NetworkState = { unmocked: [], external: [] };
  await installNetworkGuard(page, network);
  await mockAuthenticatedBackgroundApis(page);
  let activeSession: typeof session | null = null;
  let credits = 100;
  const jobs: Record<string, unknown>[] = [];
  const submittedModalities: string[] = [];
  const unauthorizedResponses: string[] = [];
  let imageReads = 0;
  let videoReads = 0;
  let checkoutBody: unknown = null;
  let orderReads = 0;

  page.on("response", (response) => {
    if (response.status() === 401) unauthorizedResponses.push(response.url());
  });

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: activeSession, capabilities },
    }),
  );
  await page.route("**/api/v1/auth/login", async (route) => {
    activeSession = session;
    return route.fulfill({ json: { ok: true, data: session, capabilities } });
  });
  await page.route("**/api/v1/model-catalog*", (route) => {
    const modality = new URL(route.request().url()).searchParams.get("modality");
    if (modality !== "image" && modality !== "video") {
      return route.fulfill({
        json: {
          ok: true,
          data: { ...catalog("image"), models: [model("image"), model("video")] },
        },
      });
    }
    return route.fulfill({ json: { ok: true, data: catalog(modality) } });
  });
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const body = route.request().postDataJSON() as {
      modality: "image" | "video";
      parameters: Record<string, unknown>;
    };
    return route.fulfill({ json: { ok: true, data: quote(body.modality, body.parameters) } });
  });
  await page.route("**/api/v1/generation-jobs*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET") return route.fulfill({ json: { ok: true, data: jobs } });

    const body = request.postDataJSON() as {
      modality: "image" | "video";
      modelId: string;
      nodeId: string;
      projectId: string;
      parameters: Record<string, unknown>;
    };
    const modality = body.modality;
    const id = `job-${modality}`;
    submittedModalities.push(modality);
    const created = {
      schemaVersion: 1,
      version: 1,
      id,
      projectId: body.projectId,
      nodeId: body.nodeId,
      modelId: body.modelId,
      modelLabel: modality === "image" ? "画面生成模型" : "镜头生成模型",
      modality,
      status: "completed",
      progress: 100,
      quote: quote(modality, body.parameters),
      artifacts: [mediaArtifact(modality, `${modality}-result`)],
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
    };
    jobs.push(created);
    credits -= modality === "image" ? 2 : 5;
    return route.fulfill({ status: 202, json: { ok: true, data: created } });
  });
  await page.route(/\/api\/v1\/media\/image-result\/content(?:\?.*)?$/, (route) => {
    imageReads += 1;
    return route.fulfill({ body: PIXEL, contentType: "image/png" });
  });
  await page.route(/\/api\/v1\/media\/video-result\/content(?:\?.*)?$/, (route) => {
    videoReads += 1;
    return route.fulfill({ body: VIDEO_BYTES, contentType: "video/mp4" });
  });

  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({ json: { ok: true, data: summary(credits) } }),
  );
  await page.route("**/api/v1/wallet/products", (route) =>
    route.fulfill({
      json: { ok: true, data: [{ kind: "credits", id: "credits-500", amount: 49, credits: 500 }] },
    }),
  );
  await page.route("**/api/v1/wallet/ledger*", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: {
          items: [
            {
              id: "ledger-payment",
              delta: 500,
              balanceAfter: credits,
              reason: "payment",
              reasonLabel: "支付到账",
              refId: "PAYFULL001",
              meta: null,
              createdAt: NOW,
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/v1/wallet/checkout", async (route) => {
    checkoutBody = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        data: { orderNo: "PAYFULL001", checkoutUrl: "https://pay.example.test/PAYFULL001" },
      },
    });
  });
  await page.route("**/api/v1/wallet/orders/PAYFULL001", (route) => {
    orderReads += 1;
    credits = 595;
    return route.fulfill({
      json: {
        ok: true,
        data: {
          orderNo: "PAYFULL001",
          status: "paid",
          productKind: "credits",
          productId: "credits-500",
          amount: 49,
          paidAt: NOW,
          createdAt: NOW,
        },
      },
    });
  });

  await page.goto("/canvas");
  await expect(page.locator("[data-save-state]")).toBeVisible();
  await skipOnboardingTour(page);
  await page.goto("/");

  await page.locator(".wc-entry-account-action").click();
  const account = page.getByRole("dialog", { name: "纬线账号" });
  await account.getByLabel("邮箱").fill("creator@example.com");
  await account.getByLabel("密码").fill("correct-password");
  await account.getByRole("button", { name: "进入画布", exact: true }).click();
  await expect(account).toBeHidden();
  await page.goto("/");

  const launcher = page.getByLabel("选择要进入的项目");
  const projectEntry = launcher.locator(".wc-entry-project-item").first();
  if ((await projectEntry.count()) > 0) {
    await projectEntry.click();
  } else {
    await launcher.getByRole("button", { name: /创建第一张画布/ }).click();
  }
  await expect(page).toHaveURL(/\/canvas$/);

  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("button", { name: "添加图片节点" })
    .click();
  const imageNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])')
    .first();
  await imageNode.locator(".wc-node-drag-strip").click();
  const imageComposer = page
    .locator("[data-node-prompt-composer]")
    .filter({ has: page.locator("[data-generation-model-select]") })
    .last();
  await expect(imageComposer.locator("[data-generation-model-select]")).toHaveValue(
    "e2e-image-model",
  );
  await imageComposer.locator("[data-prompt-editor]").fill("雨夜站台，电影感灯光");
  await imageComposer.getByRole("button", { name: "生成", exact: true }).click();
  await expect(imageNode.locator(".wc-node-wrap")).toHaveAttribute("data-node-status", "success");
  await expect(imageNode.locator('img[data-media-id="image-result"]')).toBeVisible();
  await expect.poll(() => imageReads).toBeGreaterThan(0);

  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加视频节点" })
    .click();
  const videoNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  const videoComposer = page
    .locator("[data-node-prompt-composer]")
    .filter({ has: page.locator("[data-generation-model-select]") })
    .last();
  await expect(videoComposer.locator("[data-generation-model-select]")).toHaveValue(
    "e2e-video-model",
  );
  await videoComposer.locator("[data-prompt-editor]").fill("镜头从站台缓慢推进");
  await videoComposer.getByRole("button", { name: "生成", exact: true }).click();
  await expect(videoNode.locator(".wc-node-wrap")).toHaveAttribute("data-node-status", "success");
  await expect(videoNode.locator('video[src*="video-result"]')).toBeVisible();
  await expect.poll(() => videoReads).toBeGreaterThan(0);
  expect(submittedModalities).toEqual(["image", "video"]);
  await expect(page.locator(".wc-credit-trigger")).toContainText("93");

  await page.locator(".wc-account-trigger").click();
  const wallet = page.getByRole("dialog", { name: "纬线账号" });
  await wallet.getByRole("tab", { name: "积分充值" }).click();
  await expect(wallet.getByRole("region", { name: "积分余额" })).toContainText("93");
  await wallet.getByRole("option", { name: /500 积分/ }).click();
  await wallet.getByRole("button", { name: /立即支付/ }).click();
  await expect.poll(() => orderReads).toBeGreaterThan(0);
  await expect(wallet).toContainText("支付成功");
  await expect(wallet.getByRole("region", { name: "积分余额" })).toContainText("595");
  expect(checkoutBody).toEqual({ productId: "credits-500", paymentMethod: "wxpay" });
  expect(unauthorizedResponses).toEqual([]);
  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
});

test("正常创建闭环：新建项目、文本与图片参考连接视频、一次报价与提交、SSE 断开后轮询恢复、刷新保留结果", async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await seedBrowser(page);
  const network: NetworkState = { unmocked: [], external: [] };
  await installNetworkGuard(page, network);
  await mockAuthenticatedBackgroundApis(page);

  let submittedCount = 0;
  let pollReads = 0;
  let listReads = 0;
  let sseReads = 0;
  let uploadIntents = 0;
  let contentPuts = 0;
  let providerReferenceReads = 0;
  let resultContentReads = 0;
  let credits = 100;
  const referenceId = "11111111-1111-4111-8111-111111111111";
  const quotes: Array<{
    modality: string;
    parameters: Record<string, unknown>;
    inputs: Record<string, unknown>;
  }> = [];
  const submittedBodies: Array<Record<string, unknown>> = [];
  const idempotencyKeys: string[] = [];
  const externalRequests: string[] = [];
  const mutatingApiRequests: Array<{ method: string; path: string }> = [];
  let recoveryJobs: unknown[] = [];
  let submittedProjectId = "";
  let submittedNodeId = "";
  let submittedParameters: Record<string, unknown> = {};
  let submittedAt = NOW;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      externalRequests.push(request.url());
    if (
      url.pathname.startsWith("/api/") &&
      ["POST", "PUT", "PATCH", "DELETE"].includes(request.method())
    ) {
      mutatingApiRequests.push({ method: request.method(), path: url.pathname });
    }
  });

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: session, capabilities },
    }),
  );
  await page.route("**/api/v1/model-catalog*", (route) => {
    const modality = new URL(route.request().url()).searchParams.get("modality");
    if (modality !== "image" && modality !== "video") {
      return route.fulfill({
        json: {
          ok: true,
          data: { ...catalog("image"), models: [model("image"), model("video")] },
        },
      });
    }
    return route.fulfill({ json: { ok: true, data: catalog(modality) } });
  });
  await page.route("**/api/v1/generation-quotes", (route) => {
    const body = route.request().postDataJSON() as {
      modality: "image" | "video";
      parameters: Record<string, unknown>;
      inputs: Record<string, unknown>;
    };
    quotes.push({ modality: body.modality, parameters: body.parameters, inputs: body.inputs });
    return route.fulfill({ json: { ok: true, data: quote(body.modality, body.parameters) } });
  });
  const makeJob = (
    version: number,
    status: string,
    progress: number,
    artifacts: unknown[],
    createdAt: string,
  ) => ({
    schemaVersion: 1,
    version,
    id: "job-loop-video",
    projectId: submittedProjectId,
    nodeId: submittedNodeId,
    modelId: "e2e-video-model",
    modelLabel: "镜头生成模型",
    modality: "video",
    status,
    progress,
    quote: quote("video", submittedParameters),
    artifacts,
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: status === "completed" ? createdAt : null,
  });
  const videoArtifact = (createdAt: string) => ({
    id: "artifact-loop-video-result",
    kind: "video",
    mediaId: "video-result",
    name: "loop-result.mp4",
    mimeType: "video/mp4",
    size: VIDEO_BYTES.length,
    width: 16,
    height: 9,
    duration: 1,
    createdAt,
  });
  await page.route("**/api/v1/generation-jobs**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) {
      // SSE connects but never emits a valid job event, then the stream
      // disconnects. The client turns to bounded polling to recover the task.
      sseReads += 1;
      return route.abort("connectionfailed");
    }
    if (request.method() === "POST") {
      submittedCount += 1;
      const body = request.postDataJSON();
      submittedBodies.push(body);
      idempotencyKeys.push(String(body.idempotencyKey));
      submittedProjectId = String(body.projectId);
      submittedNodeId = String(body.nodeId);
      submittedParameters = body.parameters;
      submittedAt = new Date().toISOString();
      credits -= 5;
      return route.fulfill({
        status: 202,
        json: { ok: true, data: makeJob(1, "running", 40, [], submittedAt) },
      });
    }
    if (url.pathname === "/api/v1/generation-jobs") {
      listReads += 1;
      return route.fulfill({ json: { ok: true, data: recoveryJobs } });
    }
    pollReads += 1;
    if (pollReads === 1)
      return route.fulfill({
        json: { ok: true, data: makeJob(2, "running", 45, [], submittedAt) },
      });
    if (pollReads === 2)
      return route.fulfill({
        json: { ok: true, data: makeJob(3, "running", 70, [], submittedAt) },
      });
    if (!recoveryJobs.length) {
      const olderAt = new Date(Date.parse(submittedAt) - 60_000).toISOString();
      const completed = makeJob(4, "completed", 100, [videoArtifact(submittedAt)], submittedAt);
      recoveryJobs = [completed, makeJob(1, "running", 30, [], olderAt), { ...completed }];
    }
    return route.fulfill({ json: { ok: true, data: recoveryJobs[0] } });
  });
  await page.route("**/api/v1/media/uploads", (route) => {
    uploadIntents += 1;
    return route.fulfill({
      status: 201,
      json: {
        ok: true,
        data: {
          media: {
            id: referenceId,
            kind: "image",
            name: "reference.png",
            mimeType: "image/png",
            size: PIXEL.length,
            sha256: null,
            width: 1,
            height: 1,
            durationMs: null,
            status: "ready",
            error: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
          upload: {
            method: "PUT",
            url: `/api/v1/media/${referenceId}/content`,
            headers: {},
            expiresAt: EXPIRES_AT,
            completeUrl: null,
          },
        },
      },
    });
  });
  await page.route(`**/api/v1/media/${referenceId}/content`, (route) => {
    if (route.request().method() === "PUT") {
      contentPuts += 1;
      return route.fulfill({
        json: {
          ok: true,
          data: {
            id: referenceId,
            kind: "image",
            name: "reference.png",
            mimeType: "image/png",
            size: PIXEL.length,
            sha256: null,
            width: 1,
            height: 1,
            durationMs: null,
            status: "ready",
            error: null,
            createdAt: NOW,
            updatedAt: NOW,
          },
        },
      });
    }
    return route.fulfill({ body: PIXEL, contentType: "image/png" });
  });
  await page.route(`**/api/v1/media/${referenceId}/provider-reference`, (route) => {
    providerReferenceReads += 1;
    return route.fulfill({
      json: { ok: true, data: { url: "https://media.provider.local/reference.png" } },
    });
  });
  await page.route(/\/api\/v1\/media\/video-result\/content(?:\?.*)?$/, (route) => {
    resultContentReads += 1;
    return route.fulfill({ body: VIDEO_BYTES, contentType: "video/mp4" });
  });
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({ json: { ok: true, data: summary(credits) } }),
  );

  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await page.getByLabel("项目菜单").click();
  const sidebar = page.locator(".wc-project-sidebar");
  await expect(sidebar).toBeVisible();
  await sidebar.getByLabel("新建项目").click();
  const projectName = page.getByLabel("项目名称");
  await expect(projectName).toBeVisible();
  await projectName.fill("闭环项目");
  await projectName.blur();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();

  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加图片节点" })
    .click();
  const imageRefNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])')
    .last();
  await imageRefNode
    .locator('input[type="file"]')
    .setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: PIXEL });
  await expect(imageRefNode.locator("img")).toBeVisible();

  const textBody = "雨夜站台，低机位跟拍，湿润石板反射零散霓虹";
  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加文本节点" })
    .click();
  const textNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])')
    .last();
  await textNode.locator(".wc-node-drag-strip").click();
  const textComposer = page.locator("[data-node-prompt-composer]").last();
  await textComposer.locator("[data-prompt-editor]").fill(textBody);
  await expect(textComposer.locator("[data-prompt-editor]")).toHaveText(textBody);

  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加视频节点" })
    .click();
  const videoNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  const edges = page.locator(".react-flow__edge");
  await expect(edges).toHaveCount(0);

  // 每个新节点创建时都会把视口定位到该节点，连接前先缩放显示全部节点。
  await page.getByLabel("定位全部内容").click();
  await expect(videoNode).toBeVisible();

  // 校验失败：没有提示词时不会发起报价也不会提交。
  await videoNode.locator(".wc-node-drag-strip").click();
  let videoGeneration = page.locator(
    '[data-node-prompt-composer] [data-generation-modality="video"]',
  );
  await expect(videoGeneration).toBeVisible();
  const submitButton = videoGeneration.locator(".wc-generation-submit");
  await expect(submitButton).toBeDisabled();
  await submitButton.click({ force: true });
  expect(submittedCount).toBe(0);
  expect(quotes.length).toBe(0);
  await deselectCanvas(page);

  // 真实的连接：文本与图片参考连到视频目标，每次拖动恰好新增一条连线。
  const edgesBeforeConnection = await edges.count();
  await dragNodeConnection(page, textNode, videoNode);
  await expect.poll(() => edges.count()).toBe(edgesBeforeConnection + 1);
  await dragNodeConnection(page, imageRefNode, videoNode);
  await expect.poll(() => edges.count()).toBe(edgesBeforeConnection + 2);
  expect(await edges.count()).toBe(2);

  await videoNode.locator(".wc-node-drag-strip").click();
  videoGeneration = page.locator('[data-node-prompt-composer] [data-generation-modality="video"]');
  await expect(videoGeneration.locator("[data-generation-model-select]")).toHaveValue(
    "e2e-video-model",
  );
  await expect(videoGeneration.locator(".wc-generation-compact-status.is-linked")).toContainText(
    "已连接 1 条文本，生成时自动使用",
  );
  const rail = page.locator("[data-node-prompt-composer] .wc-node-reference-chips");
  await expect(rail).toBeVisible();
  await expect(rail.locator(".wc-node-reference-chip")).toHaveCount(1);
  await expect(videoGeneration.getByLabel("时长（秒）")).toBeVisible();
  await expect(videoGeneration.getByLabel("画面比例")).toBeVisible();
  await expect.poll(() => quotes.some((entry) => entry.inputs.images === 1)).toBe(true);
  await expect(videoGeneration.locator(".wc-generation-compact-credit")).toContainText("需 5 积分");

  await videoGeneration.getByLabel("时长（秒）").click();
  await page
    .getByRole("listbox", { name: "时长（秒）" })
    .getByRole("option", { name: "2 秒" })
    .click();
  await expect.poll(() => quotes.some((entry) => entry.parameters.seconds === 2)).toBe(true);
  await expect(submitButton).toBeEnabled();

  const composer = page.locator("[data-node-prompt-composer]");
  const compactBar = videoGeneration.locator(".wc-generation-compact-bar");
  const quickControls = videoGeneration.locator(".wc-generation-quick-controls");
  const credit = videoGeneration.locator(".wc-generation-compact-credit");
  const layouts: string[] = [];
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await deselectCanvas(page);
    await page.getByLabel("定位全部内容").click();
    await panNodeNearTop(page, videoNode, viewport);
    await videoNode.locator(".wc-node-drag-strip").click();
    await expect(composer).toBeVisible();
    const composerBox = await composer.boundingBox();
    expect(composerBox).not.toBeNull();
    expect(composerBox!.x).toBeGreaterThanOrEqual(0);
    expect(composerBox!.y).toBeGreaterThanOrEqual(0);
    expect(composerBox!.x + composerBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(viewport.height + 1);
    await expect(rail).toBeVisible();
    expect(
      await compactBar.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
    ).toBe(true);
    const quickLayout = await quickControls.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controls = [...element.children].map((child) => {
        const box = child.getBoundingClientRect();
        return { left: box.left, right: box.right };
      });
      return {
        left: bounds.left,
        right: bounds.right,
        fits: element.scrollWidth <= element.clientWidth + 1,
        overflowX: getComputedStyle(element).overflowX,
        controls,
      };
    });
    expect(quickLayout.fits).toBe(true);
    expect(quickLayout.overflowX).not.toMatch(/auto|scroll/);
    for (const control of quickLayout.controls) {
      expect(control.left).toBeGreaterThanOrEqual(quickLayout.left - 1);
      expect(control.right).toBeLessThanOrEqual(quickLayout.right + 1);
    }
    const submitBox = await submitButton.boundingBox();
    const creditBox = await credit.boundingBox();
    const afterComposerBox = await composer.boundingBox();
    expect(submitBox).not.toBeNull();
    expect(creditBox).not.toBeNull();
    expect(afterComposerBox).not.toBeNull();
    expect(submitBox!.x + submitBox!.width).toBeLessThanOrEqual(
      afterComposerBox!.x + afterComposerBox!.width + 1,
    );
    expect(creditBox!.x + creditBox!.width).toBeLessThanOrEqual(submitBox!.x + 1);
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      height: document.documentElement.clientHeight,
      scrollHeight: document.documentElement.scrollHeight,
    }));
    expect(dimensions.scrollWidth).toBe(dimensions.width);
    expect(dimensions.scrollHeight).toBe(dimensions.height);
    layouts.push(`composer-${viewport.width}x${viewport.height}`);
    await page.screenshot({
      path: testInfo.outputPath(`loop-composer-${viewport.width}x${viewport.height}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await submitButton.click();
  await expect.poll(() => submittedCount).toBe(1);
  expect(idempotencyKeys).toEqual([expect.stringMatching(/^job:[0-9a-f]{8}-/)]);
  const submitted = submittedBodies[0]!;
  expect(submitted).toMatchObject({ modality: "video", modelId: "e2e-video-model", quantity: 1 });
  expect(submitted.parameters).toMatchObject({ seconds: 2, aspect_ratio: "16:9" });
  expect(String(submitted.parameters.prompt)).toContain(textBody);
  expect(String(submitted.parameters.prompt)).toContain("参考素材按上传顺序：图片1");
  expect(String(submitted.parameters.prompt)).not.toMatch(
    /(?:blob:|data:|https?:\/\/|11111111-1111-4111-8111-111111111111)/,
  );
  expect(submitted.inputs).toEqual({
    images: [referenceId],
    styleImages: [],
    elementImages: [],
    videos: [],
    audios: [],
  });
  expect(submitted.expectedQuote).toMatchObject({ id: "quote-video", modelId: "e2e-video-model" });
  expect(uploadIntents).toBe(1);
  expect(contentPuts).toBe(1);
  // 托管提交只上传参考素材并把媒体 id 交给服务端，浏览器不应直接调用 provider-reference；
  // 该路由已本地拦截，作为防御性断言确保没有任何 provider 调用逃逸到生产环境。
  expect(providerReferenceReads).toBe(0);

  await expect(videoNode.locator(".wc-node-loading")).toHaveAttribute(
    "data-generation-stage",
    "running",
    { timeout: 15_000 },
  );
  await expect(videoNode.locator(".wc-node-wrap")).toHaveAttribute("data-node-status", "success", {
    timeout: 20_000,
  });
  await expect(videoNode.locator('video[src*="video-result"]')).toBeVisible();
  expect(await page.locator('video[src*="video-result"]').count()).toBe(1);
  expect(
    await page
      .locator(
        '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"]:has(video[src*="video-result"]))',
      )
      .count(),
  ).toBe(1);
  expect(pollReads).toBeGreaterThanOrEqual(3);
  expect(sseReads).toBeGreaterThan(0);
  expect(resultContentReads).toBeGreaterThan(0);
  await expect(page.locator(".wc-credit-trigger")).toContainText("95");

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1024, height: 768 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(videoNode.locator('video[src*="video-result"]')).toBeVisible();
    await deselectCanvas(page);
    await page.getByLabel("定位全部内容").click();
    await panNodeNearTop(page, videoNode, viewport);
    await videoNode.locator(".wc-node-drag-strip").click();
    await expect(composer).toBeVisible();
    const resultComposerBox = await composer.boundingBox();
    expect(resultComposerBox).not.toBeNull();
    expect(resultComposerBox!.x + resultComposerBox!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(resultComposerBox!.y + resultComposerBox!.height).toBeLessThanOrEqual(
      viewport.height + 1,
    );
    await page.screenshot({
      path: testInfo.outputPath(`loop-result-${viewport.width}x${viewport.height}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.reload();
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await expect(page.getByLabel("项目名称")).toHaveValue("闭环项目");
  const reloadedVideo = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])')
    .last();
  await expect(reloadedVideo.locator(".wc-node-wrap")).toHaveAttribute(
    "data-node-status",
    "success",
    { timeout: 15_000 },
  );
  await expect(reloadedVideo.locator("video")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      page
        .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"] video)')
        .count(),
    )
    .toBe(1);
  await expect(
    page
      .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])')
      .last()
      .locator(".wc-node-text-preview"),
  ).toContainText(textBody);

  expect(submittedCount).toBe(1);
  expect(idempotencyKeys.length).toBe(1);
  await expect.poll(() => listReads).toBeGreaterThanOrEqual(2);
  expect(quotes.length).toBeGreaterThan(0);
  expect(externalRequests).toEqual([]);
  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
  const allowedMutations = new Set([
    "/api/v1/generation-jobs",
    "/api/v1/generation-quotes",
    "/api/v1/media/uploads",
    `/api/v1/media/${referenceId}/content`,
    `/api/v1/media/${referenceId}/provider-reference`,
    "/api/v1/membership/tasks/canvas-create-node",
  ]);
  for (const entry of mutatingApiRequests) {
    expect(
      allowedMutations.has(entry.path),
      `unexpected mutation ${entry.method} ${entry.path}`,
    ).toBe(true);
  }
  await testInfo.attach("creation-loop-scenario.json", {
    body: JSON.stringify(
      {
        layouts,
        submittedCount,
        idempotencyKeys,
        pollReads,
        listReads,
        sseReads,
        quoteReads: quotes.length,
        uploadIntents,
        contentPuts,
        providerReferenceReads,
        resultContentReads,
        externalRequests,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
});

test("submission_unknown 状态保持可见并锁定，不自动重放提交", async ({ page }) => {
  test.setTimeout(45_000);
  const network: NetworkState = { unmocked: [], external: [] };
  await installNetworkGuard(page, network);
  await mockAuthenticatedBackgroundApis(page);
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  let submissions = 0;
  let pollReads = 0;

  const unknownJob = {
    schemaVersion: 1,
    version: 1,
    id: "job-loop-unknown-1",
    projectId: "project-loop-unknown",
    nodeId: "node-loop-unknown",
    modelId: "e2e-video-model",
    modelLabel: "镜头生成模型",
    modality: "video",
    status: "submission_unknown",
    progress: 0,
    quote: {
      id: "quote-loop-unknown",
      modelId: "e2e-video-model",
      modelLabel: "镜头生成模型",
      modality: "video",
      quantity: 1,
      normalizedParameters: { prompt: "待确认的提交", seconds: 1, aspect_ratio: "16:9" },
      creditMicros: 5_000_000,
      credits: "5",
      yuanMicros: 50_000,
      yuan: "0.05",
      estimated: false,
      pricingUnit: "request",
      catalogVersion: "loop-catalog-unknown",
      capabilityVersion: "loop-capability-unknown",
      pricingVersion: "loop-pricing-unknown",
      expiresAt,
    },
    artifacts: [],
    error: {
      code: "SUBMISSION_STATUS_UNKNOWN",
      message: "任务提交结果待确认，请勿重复提交",
      retryable: false,
    },
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
  };

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({
      json: { ok: true, data: session, capabilities },
    }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({
      json: { ok: true, data: catalog("video") },
    }),
  );
  await page.route("**/api/v1/generation-quotes", (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, data: quote("video", body.parameters) } });
  });
  await page.route("**/api/v1/generation-jobs**", (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) {
      return route.abort("connectionfailed");
    }
    if (request.method() === "POST") {
      submissions += 1;
      return route.fulfill({ status: 202, json: { ok: true, data: unknownJob } });
    }
    if (url.pathname === "/api/v1/generation-jobs") {
      return route.fulfill({ json: { ok: true, data: [unknownJob] } });
    }
    pollReads += 1;
    return route.fulfill({ json: { ok: true, data: unknownJob } });
  });
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({ json: { ok: true, data: summary(100) } }),
  );
  await page.addInitScript(
    ({ createdAt }) => {
      localStorage.clear();
      const time = Date.parse(createdAt);
      localStorage.setItem(
        "weftcanvas:project:v1",
        JSON.stringify({
          schemaVersion: 1,
          id: "project-loop-unknown",
          name: "待确认提交项目",
          nodes: [
            {
              id: "node-loop-unknown",
              type: "weftcanvas",
              position: { x: 420, y: 180 },
              width: 340,
              height: 192,
              data: {
                kind: "video",
                body: "待确认的提交",
                accent: "coral",
                status: "running",
                progress: null,
                media: null,
                directorCapture: null,
                config: null,
                generation: {
                  modelId: "e2e-video-model",
                  parameters: { prompt: "待确认的提交", seconds: 1, aspect_ratio: "16:9" },
                  maxOutputTokens: null,
                  referenceMode: "auto",
                  referenceNodeIds: [],
                  jobId: "job-loop-unknown-1",
                  jobVersion: 1,
                  jobCreatedAt: createdAt,
                  jobStatus: "submission_unknown",
                  error: null,
                },
                createdAt: time,
                updatedAt: time,
              },
            },
          ],
          edges: [],
          groups: [],
          viewport: { x: 160, y: 120, zoom: 1 },
          createdAt: time,
          updatedAt: time,
        }),
      );
    },
    { createdAt },
  );

  await page.goto("/canvas");
  const node = page.locator('.react-flow__node-weftcanvas[data-id="node-loop-unknown"]');
  await expect(node.locator(".wc-node-wrap")).toHaveAttribute("data-node-status", "error");
  await expect(node.locator(".wc-node-loading")).toHaveCount(0);
  await expect(node.locator(".wc-node-generation-failure")).toContainText("任务提交结果待确认");

  await node.locator(".wc-node-drag-strip").click();
  const generation = page.getByLabel("视频节点创作设置");
  const submitButton = generation.locator(".wc-generation-submit");
  await expect(submitButton).toBeDisabled();
  await expect.poll(() => pollReads, { timeout: 12_000 }).toBeGreaterThan(0);
  await expect(node.locator(".wc-node-loading")).toHaveCount(0);
  await expect(submitButton).toBeDisabled();
  expect(submissions).toBe(0);
  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
});

test("提交响应被丢掉一次：面板提示重试，同一个幂等键落到同一个任务", async ({ page }) => {
  test.setTimeout(60_000);
  await seedBrowser(page);
  const network: NetworkState = { unmocked: [], external: [] };
  await installNetworkGuard(page, network);
  await mockAuthenticatedBackgroundApis(page);

  const submittedKeys: string[] = [];
  const startedJobs: Record<string, unknown>[] = [];
  let jobPostAttempts = 0;
  let created: Record<string, unknown> | null = null;

  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: session, capabilities } }),
  );
  await page.route("**/api/v1/model-catalog*", (route) =>
    route.fulfill({ json: { ok: true, data: catalog("image") } }),
  );
  await page.route("**/api/v1/generation-quotes", (route) => {
    const body = route.request().postDataJSON() as {
      modality: "image";
      parameters: Record<string, unknown>;
    };
    return route.fulfill({ json: { ok: true, data: quote(body.modality, body.parameters) } });
  });
  await page.route("**/api/v1/generation-jobs*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/events")) return route.fulfill({ status: 204, body: "" });
    if (request.method() === "GET") {
      return route.fulfill({ json: { ok: true, data: created ? [created] : [] } });
    }
    const body = request.postDataJSON() as {
      modality: "image";
      modelId: string;
      nodeId: string;
      projectId: string;
      parameters: Record<string, unknown>;
      idempotencyKey: string;
    };
    submittedKeys.push(body.idempotencyKey);
    jobPostAttempts += 1;
    if (jobPostAttempts === 1) {
      // 第一次的响应在链路上被丢掉：浏览器看到的是网络错误，服务端其实已经接单。
      return route.abort("connectionreset");
    }
    // 同一个幂等键回到同一个任务：第二次不产生新任务、也不产生第二笔扣费。
    created ??= {
      schemaVersion: 1,
      version: 1,
      id: "job-image",
      projectId: body.projectId,
      nodeId: body.nodeId,
      modelId: body.modelId,
      modelLabel: "画面生成模型",
      modality: body.modality,
      status: "completed",
      progress: 100,
      quote: quote(body.modality, body.parameters),
      artifacts: [mediaArtifact("image", "image-result")],
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
    };
    startedJobs.push(created);
    return route.fulfill({ status: 202, json: { ok: true, data: created } });
  });
  await page.route(/\/api\/v1\/media\/image-result\/content(?:\?.*)?$/, (route) =>
    route.fulfill({ body: PIXEL, contentType: "image/png" }),
  );
  await page.route("**/api/v1/wallet", (route) =>
    route.fulfill({ json: { ok: true, data: summary(100) } }),
  );
  await page.route(/\/api\/v1\/announcements(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ok: true, data: { items: [] } } }),
  );
  await page.route(/\/api\/v1\/agent\/connectors(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ok: true, data: [] } }),
  );

  await page.goto("/canvas");
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible();
  await skipOnboardingTour(page);
  await page
    .getByRole("navigation", { name: "创建工具" })
    .locator(".wc-create-rail-plus-wrapper")
    .hover();
  await page
    .getByRole("navigation", { name: "创建工具" })
    .getByRole("menuitem", { name: "添加图片节点" })
    .click();
  const imageNode = page
    .locator('.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])')
    .first();
  await imageNode.locator(".wc-node-drag-strip").click();
  const composer = page.locator("[data-node-prompt-composer]").last();
  const generation = composer.getByLabel("图片节点创作设置");
  await expect(generation.getByRole("button", { name: "模型", exact: true })).toContainText(
    "画面生成模型",
  );
  await composer.locator("[data-prompt-editor]").fill("雨夜站台，电影感灯光");
  const submitButton = generation.locator(".wc-generation-submit");
  await expect(submitButton).toBeEnabled();
  await submitButton.click();

  // 重试窗口里按钮和 toast 都要说清「还在重试」，而不是让用户以为卡死。
  await expect(submitButton).toHaveText(/重试中 2\/3/);
  await expect(
    page.locator(".wc-toast").filter({ hasText: "网络不稳定，正在自动重试提交" }),
  ).toBeVisible();

  // 第二次尝试把同一张任务交回来，节点照常出图，且只有一笔任务。
  await expect(imageNode.locator(".wc-node-wrap")).toHaveAttribute("data-node-status", "success");
  await expect(imageNode.locator('img[data-media-id="image-result"]')).toBeVisible();
  expect(submittedKeys.length).toBe(2);
  expect(new Set(submittedKeys).size).toBe(1);
  expect(startedJobs.length).toBe(1);
  expect(network.unmocked, `unmocked /api requests: ${network.unmocked.join(", ")}`).toEqual([]);
  expect(network.external, `external network requests: ${network.external.join(", ")}`).toEqual([]);
});
