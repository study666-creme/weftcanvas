import { expect, test } from "./zero-cost-test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/wallet", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        credits: 100,
        creditsPermanent: 100,
        dailyCredits: 0,
        creditGrantMode: "bundle",
        dailyCreditsNote: "",
        membership: { tier: null, until: null, active: false, genDiscount: null },
        lifetimeCreditsSpent: 0,
      },
    },
  }));
});

test("replaces a removed saved model only after the live catalog succeeds", async ({ page }) => {
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  const expiresAt = new Date(now + 60_000).toISOString();
  const projectId = "stale-model-recovery";
  await page.addInitScript(({ now, projectId }) => {
    localStorage.clear();
    sessionStorage.clear();
    const project = {
      schemaVersion: 1,
      id: projectId,
      name: "失效模型恢复",
      nodes: [{
        id: "stale-image-node",
        type: "kachang",
        position: { x: 460, y: 240 },
        width: 340,
        height: 340,
        data: {
          kind: "image",
          body: "雨夜街道",
          accent: "blue",
          status: "idle",
          progress: 0,
          media: null,
          directorCapture: null,
          config: null,
          generation: {
            modelId: "retired-image-model",
            parameters: { retired: "value" },
            maxOutputTokens: null,
            referenceMode: "auto",
            referenceNodeIds: [],
            jobId: null,
            jobVersion: null,
            jobCreatedAt: null,
            jobStatus: null,
            error: null,
          },
          createdAt: now,
          updatedAt: now,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: now,
      updatedAt: now,
    };
    localStorage.setItem(`kachang-canvas:project-data:v1:${encodeURIComponent(projectId)}`, JSON.stringify(project));
    localStorage.setItem("kachang-canvas:projects:v1", JSON.stringify({
      version: 1,
      projects: [{ id: projectId, name: project.name, createdAt: now, updatedAt: now, nodeCount: 1 }],
    }));
    localStorage.setItem("kachang-canvas:active-project:v1", projectId);
  }, { now, projectId });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/generation-jobs*", (route) => route.fulfill({ json: { ok: true, data: [] } }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-stale-model-recovery",
        capabilityVersion: "capability-stale-model-recovery",
        pricingVersion: "pricing-stale-model-recovery",
        fetchedAt: timestamp,
        expiresAt,
        quoteAvailable: true,
        models: [testCatalogModel("safe-image", "可用图片模型", "image")],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON() as { modelId: string; parameters: Record<string, unknown> };
    await route.fulfill({
      json: {
        ok: true,
        data: {
          id: "quote-stale-model-recovery",
          modelId: request.modelId,
          modelLabel: "可用图片模型",
          modality: "image",
          quantity: 1,
          outputCount: 1,
          normalizedParameters: request.parameters,
          creditMicros: 1,
          credits: "0.000001",
          yuanMicros: 1,
          yuan: "0.000001",
          estimated: false,
          pricingUnit: "request",
          catalogVersion: "catalog-stale-model-recovery",
          capabilityVersion: "capability-stale-model-recovery",
          pricingVersion: "pricing-stale-model-recovery",
          expiresAt,
        },
      },
    });
  });

  await page.goto("/canvas");
  const node = page.locator('.react-flow__node-kachang[data-id="stale-image-node"]');
  await node.locator(".kc-node-drag-strip").click();
  const panel = page.getByLabel("图片节点创作设置");
  await expect(panel.locator("[data-generation-model-select]")).toHaveValue("safe-image");
  await expect(panel).not.toContainText("所选模型已停用或来源已移除");
  await expect.poll(() => page.evaluate((id) => {
    const raw = localStorage.getItem(`kachang-canvas:project-data:v1:${encodeURIComponent(id)}`);
    const project = raw ? JSON.parse(raw) as { nodes?: Array<{ id?: string; data?: { generation?: { modelId?: string; parameters?: Record<string, unknown> } } }> } : null;
    const generation = project?.nodes?.find((item) => item.id === "stale-image-node")?.data?.generation;
    return generation ? { modelId: generation.modelId, parameters: generation.parameters } : null;
  }, projectId)).toEqual({ modelId: "safe-image", parameters: {} });
});

test("collapses stale H3 and image2-A aliases into one control and one request field", async ({ page }) => {
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const quotes = new Map<string, Record<string, unknown>>();
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/generation-jobs*", (route) => route.fulfill({ json: { ok: true, data: [] } }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-alias-dedupe",
        capabilityVersion: "capability-alias-dedupe",
        pricingVersion: "pricing-alias-dedupe",
        fetchedAt: timestamp,
        expiresAt,
        quoteAvailable: true,
        models: [staleImage2AModel(), staleH3Model()],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON() as { modelId: string; modality: "image" | "video"; parameters: Record<string, unknown> };
    quotes.set(request.modelId, request.parameters);
    await route.fulfill({
      json: {
        ok: true,
        data: {
          id: `quote-${request.modelId}`,
          modelId: request.modelId,
          modelLabel: request.modelId === "minimax_h3" ? "Minimax H3" : "全能模型2-A",
          modality: request.modality,
          quantity: 1,
          outputCount: 1,
          normalizedParameters: request.parameters,
          creditMicros: 1,
          credits: "0.000001",
          yuanMicros: 1,
          yuan: "0.000001",
          estimated: false,
          pricingUnit: "request",
          catalogVersion: "catalog-alias-dedupe",
          capabilityVersion: "capability-alias-dedupe",
          pricingVersion: "pricing-alias-dedupe",
          expiresAt,
        },
      },
    });
  });

  await page.goto("/canvas");
  await page.getByRole("navigation", { name: "创建工具" }).getByLabel("添加图片节点").click();
  const imageNode = page.locator('.react-flow__node-kachang.selected:has(.kc-node-wrap[data-node-kind="image"])');
  await imageNode.locator(".kc-node-drag-strip").click();
  const imagePanel = page.getByLabel("图片节点创作设置");
  await expect(imagePanel.locator("[data-generation-model-select]")).toHaveValue("image2-A");
  await expect(imagePanel.getByLabel("分辨率", { exact: true })).toHaveCount(1);
  await expect(imagePanel.getByLabel("画面比例", { exact: true })).toHaveCount(1);
  await expect(imagePanel.getByLabel("质量", { exact: true })).toHaveCount(1);
  await expect(imagePanel.getByLabel("像素尺寸或兼容比例", { exact: true })).toHaveCount(0);
  await expect(imagePanel.getByLabel("画面比例（兼容别名）", { exact: true })).toHaveCount(0);
  await expect(imagePanel.getByRole("button", { name: /更多参数/ })).toHaveCount(0);
  await page.locator(".kc-node-prompt-editor").fill("电影感产品图");
  await expect.poll(() => quotes.get("image2-A")).toBeTruthy();
  expect(quotes.get("image2-A")).toMatchObject({ resolution: "1k", aspect_ratio: "auto", quality: "standard" });
  expect(quotes.get("image2-A")).not.toHaveProperty("size");
  expect(quotes.get("image2-A")).not.toHaveProperty("aspectRatio");
  expect(quotes.get("image2-A")).not.toHaveProperty("ratio");

  await page.getByRole("navigation", { name: "创建工具" }).getByLabel("添加视频节点").click();
  const videoNode = page.locator('.react-flow__node-kachang.selected:has(.kc-node-wrap[data-node-kind="video"])');
  await videoNode.locator(".kc-node-drag-strip").click();
  const videoPanel = page.getByLabel("视频节点创作设置");
  await expect(videoPanel.locator("[data-generation-model-select]")).toHaveValue("minimax_h3");
  await expect(videoPanel.getByLabel("时长（秒）", { exact: true })).toHaveCount(1);
  await expect(videoPanel.getByLabel("画面尺寸", { exact: true })).toHaveCount(1);
  await expect(videoPanel.getByLabel("时长兼容字段（秒）", { exact: true })).toHaveCount(0);
  await expect(videoPanel.getByLabel("分辨率", { exact: true })).toHaveCount(0);
  await expect(videoPanel.getByRole("button", { name: /更多参数/ })).toHaveCount(0);
  await page.locator(".kc-node-prompt-editor").fill("主体自然运动");
  await expect.poll(() => quotes.get("minimax_h3")).toBeTruthy();
  expect(quotes.get("minimax_h3")).toMatchObject({ seconds: 4, size: "1080p" });
  expect(quotes.get("minimax_h3")).not.toHaveProperty("duration");
  expect(quotes.get("minimax_h3")).not.toHaveProperty("resolution");
});

test("labels a fixed Midjourney submission by its delivered image count", async ({ page }) => {
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  let quotedQuantity = -1;
  let quotedParameters: Record<string, unknown> = {};
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  await page.route("**/api/v1/**", (route) => route.fulfill({ json: { ok: true, data: [] } }));
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/wallet", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        credits: 100,
        creditsPermanent: 100,
        dailyCredits: 0,
        creditGrantMode: "bundle",
        dailyCreditsNote: "",
        membership: { tier: null, until: null, active: false, genDiscount: null },
        lifetimeCreditsSpent: 0,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog*", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-mj-call-count",
        capabilityVersion: "capability-mj-call-count",
        pricingVersion: "pricing-mj-call-count",
        fetchedAt: timestamp,
        expiresAt,
        quoteAvailable: true,
        models: [{
          id: "mj-v81",
          label: "Midjourney 8.1",
          description: "One submission returns a grid and four images.",
          modality: "image",
          operation: "generate",
          order: 50,
          input: { textRequired: true, images: { min: 0, max: 5, multiple: true } },
          output: { type: "image", minCount: 5, maxCount: 5 },
          parameters: [
            { name: "prompt", label: "Prompt", type: "string", required: true, mutuallyExclusiveWith: [] },
            { name: "size", label: "Ratio", type: "string", required: false, default: "auto", options: ["auto", "1:1", "16:9", "9:16"], mutuallyExclusiveWith: [] },
            { name: "quality", label: "Quality", type: "string", required: false, default: "1", options: ["0.25", "0.5", "1", "2"], mutuallyExclusiveWith: [] },
            { name: "stylize", label: "Stylize", type: "integer", required: false, default: 0, min: 0, max: 1000, step: 1, mutuallyExclusiveWith: [] },
            { name: "chaos", label: "Chaos", type: "integer", required: false, default: 0, min: 0, max: 100, step: 1, mutuallyExclusiveWith: [] },
            { name: "weird", label: "Weird", type: "integer", required: false, default: 0, min: 0, max: 3000, step: 1, mutuallyExclusiveWith: [] },
            { name: "speed", label: "Speed", type: "string", required: false, fixed: "relax", mutuallyExclusiveWith: [] },
            { name: "n", label: "Submission count", type: "integer", required: false, fixed: 1, mutuallyExclusiveWith: [] },
          ],
          pricing: {
            mode: "fixed",
            unit: "request",
            currency: "CNY",
            creditsPerYuan: 100,
            baseCreditMicros: 40_000_000,
            baseYuanMicros: 400_000,
            tiers: [],
          },
        }],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON() as { quantity: number; parameters: Record<string, unknown> };
    quotedQuantity = request.quantity;
    quotedParameters = request.parameters;
    await route.fulfill({
      json: {
        ok: true,
        data: {
          id: "quote-mj-call-count",
          modelId: "mj-v81",
          modelLabel: "Midjourney 8.1",
          modality: "image",
          quantity: 1,
          outputCount: 5,
          normalizedParameters: request.parameters,
          creditMicros: 40_000_000,
          credits: "40",
          yuanMicros: 400_000,
          yuan: "0.4",
          estimated: false,
          pricingUnit: "request",
          catalogVersion: "catalog-mj-call-count",
          capabilityVersion: "capability-mj-call-count",
          pricingVersion: "pricing-mj-call-count",
          expiresAt,
        },
      },
    });
  });

  await page.goto("/canvas");
  const imageNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])').first();
  await imageNode.locator(".kc-node-drag-strip").click();
  const panel = page.locator('.kc-generation-panel--embedded[data-generation-modality="image"]');
  await expect(panel.locator("[data-generation-model-select]")).toHaveValue("mj-v81");
  // 固定多图的模型不再显示「调用次数 1 次」，否则用户会以为一次只出一张、
  // 单价偏高；改为直接告诉用户这一次会出几张。
  await expect(panel.getByLabel("\u51fa\u56fe\u5f20\u6570")).toHaveText("5 \u5f20");
  await expect(panel.getByLabel("\u51fa\u56fe\u5f20\u6570")).toBeDisabled();
  await expect(panel.getByLabel("\u8c03\u7528\u6b21\u6570")).toHaveCount(0);
  await expect(panel.getByLabel("\u751f\u6210\u5f20\u6570")).toHaveCount(0);
  await expect.poll(() => quotedQuantity).toBe(1);
  expect(quotedParameters.n).toBe(1);
});

test("keeps all image models while filtering unavailable video ids", async ({ page }) => {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const availableImageIds = ["image2", "image2-economy", "gpt-image-2", "gpt-image-2-1k", "lingtu-fast", "lingtu-lite", "lingtu", "nano-banana-fast", "nano-banana-2-lite", "nano-banana"];
  const unavailableVideoIds = ["motion-video", "motion-video-1-5", "firefly-seedance2-fast-480p"];
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        data: {
          id: `filter-quote-${request.modality}`,
          modelId: request.modelId,
          modelLabel: request.modality === "video" ? "可用视频" : "可用图片",
          modality: request.modality,
          quantity: 1,
          normalizedParameters: request.parameters,
          creditMicros: 1,
          credits: "0.000001",
          yuanMicros: 1,
          yuan: "0.000001",
          estimated: false,
          pricingUnit: "request",
          catalogVersion: "filter-catalog",
          capabilityVersion: "filter-capability",
          pricingVersion: "filter-pricing",
          expiresAt,
        },
      },
    });
  });
  await page.route("**/api/v1/model-catalog*", (route) => {
    return route.fulfill({
      json: {
        ok: true,
        data: {
          version: "filter-catalog",
          capabilityVersion: "filter-capability",
          pricingVersion: "filter-pricing",
          fetchedAt: now.toISOString(),
          expiresAt,
          quoteAvailable: false,
          models: [
            testCatalogModel("safe-image", "可用图片", "image"),
            ...availableImageIds.map((id) => testCatalogModel(id, `可用 ${id}`, "image")),
            testCatalogModel("safe-video", "可用视频", "video"),
            ...unavailableVideoIds.map((id) => testCatalogModel(id, `失效 ${id}`, "video")),
          ],
        },
      },
    });
  });
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  await page.goto("/canvas");
  const imageNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])').first();
  await imageNode.locator(".kc-node-drag-strip").click();
  const imagePanel = page.getByLabel("图片节点创作设置");
  await imagePanel.getByRole("button", { name: "模型", exact: true }).click();
  let menu = page.getByRole("listbox", { name: "模型" });
  await expect(menu.getByRole("option")).toHaveCount(availableImageIds.length + 1);
  await expect(menu).toContainText("可用图片");
  for (const id of availableImageIds) await expect(menu).toContainText(id);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();

  await page.getByRole("navigation", { name: "创建工具" }).getByLabel("添加视频节点").click();
  const videoNode = page.locator('.react-flow__node-kachang.selected:has(.kc-node-wrap[data-node-kind="video"])');
  await videoNode.locator(".kc-node-drag-strip").click();
  const videoPanel = page.getByLabel("视频节点创作设置");
  await videoPanel.getByRole("button", { name: "模型", exact: true }).click();
  menu = page.getByRole("listbox", { name: "模型" });
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(menu).toContainText("可用视频");
  for (const id of unavailableVideoIds) await expect(menu).not.toContainText(id);
});

test("text nodes keep a focused editor without model generation controls", async ({ page }, testInfo) => {
  const now = new Date();
  const expires = new Date(now.getTime() + 60 * 60_000).toISOString();
  const session = {
    user: {
      id: "07d3b269-6bc3-4dbb-b67f-28664c787f00",
      email: "creator@example.com",
      displayName: "创作者",
      createdAt: now.toISOString(),
    },
    expiresAt: expires,
  };
  const quote = {
    id: "quote-public-1",
    modelId: "creative-text",
    modelLabel: "全能文本",
    modality: "text" as const,
    quantity: 1,
    normalizedParameters: { messages: [{ role: "user", content: "placeholder" }] },
    creditMicros: 125_000,
    credits: "0.125",
    yuanMicros: 1_250,
    yuan: "0.00125",
    estimated: true,
    pricingUnit: "token" as const,
    catalogVersion: "catalog-1",
    capabilityVersion: "capability-1",
    pricingVersion: "pricing-1",
    expiresAt: expires,
  };
  let runningJob: Record<string, unknown> | null = null;

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.route("**/api/v1/auth/login", (route) => route.fulfill({ json: { ok: true, data: session } }));
  await page.route("**/api/v1/model-catalog?modality=text", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-1",
        capabilityVersion: "capability-1",
        pricingVersion: "pricing-1",
        fetchedAt: now.toISOString(),
        expiresAt: expires,
        quoteAvailable: true,
        models: [{
          id: "creative-text",
          label: "全能文本",
          description: "长文本创作与改写",
          modality: "text",
          operation: "chat",
          order: 0,
          input: { textRequired: true },
          output: { type: "text", minCount: 1, maxCount: 1 },
          parameters: [{ name: "messages", label: "消息", type: "array", required: true, mutuallyExclusiveWith: [] }],
          pricing: {
            mode: "token",
            unit: "token",
            currency: "CNY",
            creditsPerYuan: 100,
            tiers: [],
            inputCreditMicrosPerMillion: 15_000_000,
            outputCreditMicrosPerMillion: 90_000_000,
            inputYuanMicrosPerMillion: 150_000,
            outputYuanMicrosPerMillion: 900_000,
          },
        }],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON();
    await route.fulfill({ json: { ok: true, data: { ...quote, normalizedParameters: request.parameters } } });
  });
  await page.route("**/api/v1/generation-jobs*", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ok: true, data: [] } });
    const request = route.request().postDataJSON();
    const createdAt = new Date().toISOString();
    runningJob = {
      schemaVersion: 1,
      version: 1,
      id: "job-public-1",
      projectId: request.projectId,
      nodeId: request.nodeId,
      modelId: "creative-text",
      modelLabel: "全能文本",
      modality: "text",
      status: "running",
      progress: 36,
      quote: { ...quote, normalizedParameters: request.parameters },
      artifacts: [],
      error: null,
      createdAt,
      updatedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
    };
    await route.fulfill({
      status: 202,
      json: { ok: true, data: runningJob },
    });
  });
  await page.route("**/api/v1/generation-jobs/job-public-1/events", async (route) => {
    if (!runningJob) return route.abort();
    const completedAt = new Date().toISOString();
    const job = {
      ...runningJob,
      version: 4,
      status: "completed",
      progress: 100,
      artifacts: [{ id: "artifact-1", kind: "text", text: "生成后的完整场景文本", createdAt: completedAt }],
      updatedAt: completedAt,
      completedAt,
    };
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: { "Cache-Control": "no-cache" },
      body: `id: generation:job-public-1:4\nevent: job\ndata: ${JSON.stringify({ type: "job", job })}\n\n`,
    });
  });

  await page.addInitScript(() => localStorage.clear());
  await page.goto("/canvas");

  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  await textNode.locator(".kc-node-drag-strip").click();
  const prompt = page.locator("[data-node-prompt-composer]");
  await expect(prompt).toBeVisible();
  await expect(prompt.locator("[data-generation-model-select]")).toHaveCount(0);
  await expect(prompt.getByRole("button", { name: "生成", exact: true })).toHaveCount(0);
  const editor = prompt.locator("[data-prompt-editor]");
  await editor.fill("一段用于验证文本节点编辑的内容");
  await expect(editor).toHaveText("一段用于验证文本节点编辑的内容");
  await page.screenshot({ path: testInfo.outputPath("text-node-editor-dark.png") });
  await expect(page.locator(".kc-generation-backdrop")).toHaveCount(0);
  await page.getByLabel("切换主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: testInfo.outputPath("text-node-editor-light.png") });
  await page.getByLabel("切换主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("uploads a local reference and replaces the image node with the validated result", async ({ page }, testInfo) => {
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const referenceId = "11111111-1111-4111-8111-111111111111";
  const resultId = "22222222-2222-4222-8222-222222222222";
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  let uploadCount = 0;
  let quotedImageCount = -1;
  let quotedOutputCount = -1;
  let quotedQuantity = -1;
  let submittedOutputCount = -1;
  let submittedQuantity = -1;
  let submittedInputs: Record<string, unknown> | null = null;
  let submittedPrompt = "";
  let releaseSubmission!: () => void;
  const submissionGate = new Promise<void>((resolve) => { releaseSubmission = resolve; });

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        user: { id: "07d3b269-6bc3-4dbb-b67f-28664c787f00", email: "creator@example.com", displayName: "创作者", createdAt: timestamp },
        expiresAt,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-image-1",
        capabilityVersion: "capability-image-1",
        pricingVersion: "pricing-image-1",
        fetchedAt: timestamp,
        expiresAt,
        quoteAvailable: true,
        models: [{
          id: "image2-pro",
          label: "全能模型2 · 2K",
          description: "",
          modality: "image",
          operation: "generate",
          order: 0,
          input: { textRequired: true, images: { min: 0, max: 1, multiple: false } },
          output: { type: "image", minCount: 1, maxCount: 4 },
          parameters: [
            { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
            { name: "size", label: "画面比例", type: "string", required: false, default: "auto", options: ["auto", "16:9"], mutuallyExclusiveWith: [] },
            { name: "resolution", label: "分辨率", type: "string", required: false, default: "2k", options: ["1k", "2k"], mutuallyExclusiveWith: [] },
            { name: "quality", label: "质量", type: "string", required: false, default: "medium", options: ["low", "medium", "high"], mutuallyExclusiveWith: [] },
            { name: "n", label: "生成张数", type: "integer", required: false, default: 1, min: 1, max: 4, step: 1, mutuallyExclusiveWith: [] },
          ],
          pricing: { mode: "fixed", unit: "image", currency: "CNY", creditsPerYuan: 100, baseCreditMicros: 2_000_000, baseYuanMicros: 20_000, tiers: [] },
        }],
      },
    },
  }));
  const imageQuote = {
    id: "quote-image-1",
    modelId: "image2-pro",
    modelLabel: "全能模型2 · 2K",
    modality: "image",
    quantity: 1,
    normalizedParameters: { prompt: "placeholder", resolution: "2k", quality: "medium" },
    creditMicros: 2_000_000,
    credits: "2",
    yuanMicros: 20_000,
    yuan: "0.02",
    estimated: false,
    pricingUnit: "image",
    catalogVersion: "catalog-image-1",
    capabilityVersion: "capability-image-1",
    pricingVersion: "pricing-image-1",
    expiresAt,
  };
  await page.route("**/api/v1/generation-quotes", async (route) => {
    const request = route.request().postDataJSON();
    quotedImageCount = request.inputs.images;
    quotedOutputCount = request.parameters.n;
    quotedQuantity = request.quantity;
    const outputCount = Number(request.parameters.n ?? 1);
    await route.fulfill({
      json: {
        ok: true,
        data: {
          ...imageQuote,
          normalizedParameters: request.parameters,
          creditMicros: outputCount * 2_000_000,
          credits: String(outputCount * 2),
        },
      },
    });
  });
  await page.route("**/api/v1/media/uploads", (route) => route.fulfill({
    status: 201,
    json: {
      ok: true,
      data: {
        media: publicMedia(referenceId, "reference.png", image.length, timestamp),
        upload: { method: "PUT", url: `/api/v1/media/${referenceId}/content`, headers: {}, expiresAt, completeUrl: null },
      },
    },
  }));
  await page.route(`**/api/v1/media/${referenceId}/content`, (route) => {
    if (route.request().method() === "PUT") {
      uploadCount += 1;
      return route.fulfill({ json: { ok: true, data: publicMedia(referenceId, "reference.png", image.length, timestamp) } });
    }
    return route.fulfill({ body: image, contentType: "image/png" });
  });
  await page.route(`**/api/v1/media/${resultId}/content`, (route) => route.fulfill({ body: image, contentType: "image/png" }));
  await page.route("**/api/v1/generation-jobs*", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { ok: true, data: [] } });
    const request = route.request().postDataJSON();
    submittedOutputCount = request.parameters.n;
    submittedQuantity = request.quantity;
    submittedInputs = request.inputs;
    submittedPrompt = request.parameters.prompt;
    await submissionGate;
    await route.fulfill({
      status: 202,
      json: {
        ok: true,
        data: {
          schemaVersion: 1,
          version: 4,
          id: "job-image-1",
          projectId: request.projectId,
          nodeId: request.nodeId,
          modelId: "image2-pro",
          modelLabel: "全能模型2 · 2K",
          modality: "image",
          status: "completed",
          progress: 100,
          quote: { ...imageQuote, normalizedParameters: request.parameters },
          artifacts: [{ id: "artifact-image-1", kind: "image", mediaId: resultId, name: "result.png", mimeType: "image/png", size: image.length, width: 1, height: 1, createdAt: timestamp }],
          error: null,
          createdAt: timestamp,
          updatedAt: timestamp,
          startedAt: timestamp,
          completedAt: timestamp,
        },
      },
    });
  });

  await page.addInitScript(() => localStorage.clear());
  await page.goto("/canvas");
  const imageNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])');
  await imageNode.locator('input[type="file"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: image });
  await expect(imageNode.locator("img")).toBeVisible();
  await imageNode.locator(".kc-node-drag-strip").click();
  const generation = page.getByLabel("图片节点创作设置");
  await generation.hover();
  await expect(generation.locator("[data-generation-model-select]")).toHaveValue("image2-pro");
  await expect(generation.getByLabel("分辨率")).toBeVisible();
  await expect(generation.getByLabel("质量")).toHaveText("中等");
  await generation.getByLabel("质量").click();
  const qualityOptions = page.getByRole("listbox", { name: "质量" });
  await expect(qualityOptions).toContainText("低");
  await expect(qualityOptions).toContainText("中等");
  await expect(qualityOptions).toContainText("高");
  await generation.getByLabel("质量").click();
  await expect(qualityOptions).toHaveCount(0);

  const composer = page.locator(".kc-node-prompt-composer");
  const quickTrack = generation.locator(".kc-generation-quick-controls");
  const quickControls = generation.locator(".kc-generation-quick-controls > .kc-generation-parameter-control");
  const modelLabel = generation.locator(".kc-generation-model-control .kc-canvas-select-label");
  const credit = generation.locator(".kc-generation-compact-credit");
  const generate = generation.getByRole("button", { name: "生成", exact: true });
  await expect(quickControls).toHaveCount(4);
  await expect(modelLabel).toHaveText("全能模型2 · 2K");
  await expect(credit).toHaveText("需 2 积分");
  await expect(generate).toHaveText("生成");

  const layouts: Array<{ viewport: string; composer: { x: number; right: number }; credit: { x: number; right: number }; generate: { x: number; right: number } }> = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    await expect(composer).toBeVisible();
    const compactBounds = await generation.evaluate((element) => {
      const composerElement = element.closest(".kc-node-prompt-composer");
      const creditElement = element.querySelector(".kc-generation-compact-credit");
      const generateElement = element.querySelector(".kc-generation-submit--compact");
      if (!composerElement || !creditElement || !generateElement) return null;
      const composerRect = composerElement.getBoundingClientRect();
      const creditRect = creditElement.getBoundingClientRect();
      const generateRect = generateElement.getBoundingClientRect();
      return {
        composer: { x: composerRect.x, right: composerRect.right },
        credit: { x: creditRect.x, right: creditRect.right },
        generate: { x: generateRect.x, right: generateRect.right },
      };
    });
    expect(compactBounds).not.toBeNull();
    expect(compactBounds!.generate.x).toBeGreaterThanOrEqual(compactBounds!.composer.x - 1);
    expect(compactBounds!.generate.right).toBeLessThanOrEqual(compactBounds!.composer.right + 1);
    expect(compactBounds!.credit.right).toBeLessThanOrEqual(compactBounds!.generate.x + 1);
    expect(await generation.locator(".kc-generation-compact-bar").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    const quickLayout = await quickTrack.evaluate((element) => {
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
    const clippedText = await generation.locator([
      ".kc-generation-model-control .kc-canvas-select-label",
      ".kc-generation-quick-controls small",
      ".kc-generation-quick-controls .kc-canvas-select-label",
      ".kc-generation-compact-credit",
      ".kc-generation-submit--compact span",
    ].join(", ")).evaluateAll((elements) => elements.flatMap((element) => (
      element.scrollWidth > element.clientWidth + 1 ? [element.textContent?.trim() || element.className] : []
    )));
    expect(clippedText).toEqual([]);
    layouts.push({
      viewport: `${viewport.width}x${viewport.height}`,
      composer: compactBounds!.composer,
      credit: compactBounds!.credit,
      generate: compactBounds!.generate,
    });
    await page.screenshot({ path: testInfo.outputPath(`embedded-generation-${viewport.width}x${viewport.height}.png`) });
  }
  await testInfo.attach("embedded-generation-layout.json", {
    body: JSON.stringify(layouts, null, 2),
    contentType: "application/json",
  });

  const outputCount = generation.getByLabel("生成张数");
  await expect(outputCount).toHaveText("1 张");
  await outputCount.click();
  await page.getByRole("listbox", { name: "生成张数" }).getByRole("option", { name: "3 张" }).click();
  await expect(outputCount).toHaveText("3 张");
  await expect.poll(() => quotedOutputCount).toBe(3);
  await expect(generation).toContainText("6 积分");
  await generate.click();
  await expect.poll(() => submittedOutputCount).toBe(3);
  await expect(imageNode.locator(".kc-node-loading")).toHaveAttribute("data-generation-stage", "submitting");
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Control+Z");
  await expect(imageNode.locator(".kc-node-loading")).toHaveAttribute("data-generation-stage", "submitting");
  releaseSubmission();
  await expect(page.locator(".kc-toast--info")).toHaveCount(0);

  await expect(imageNode.locator(`img[data-media-id="${resultId}"]`)).toBeVisible();
  await page.keyboard.press("Control+Y");
  await expect(imageNode.locator(`img[data-media-id="${resultId}"]`)).toBeVisible();
  await page.keyboard.press("Control+Z");
  await expect(imageNode.locator(`img[data-media-id="${resultId}"]`)).toBeVisible();
  expect(quotedImageCount).toBe(1);
  expect(quotedQuantity).toBe(1);
  expect(submittedOutputCount).toBe(3);
  expect(submittedQuantity).toBe(1);
  expect(uploadCount).toBe(1);
  expect(submittedInputs).toEqual({ images: [referenceId], styleImages: [], elementImages: [], videos: [], audios: [] });
  expect(submittedPrompt).toContain("参考素材按上传顺序：图片1");
  expect(submittedPrompt).not.toMatch(/(?:blob:|data:|https?:\/\/|11111111-1111-4111-8111-111111111111)/);
});

test("reference upload failure stops the submit before any generation POST and restores the button", async ({ page }) => {
  const timestamp = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  let generationPosts = 0;
  let uploadIntents = 0;
  await page.addInitScript(() => localStorage.clear());
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        user: { id: "07d3b269-6bc3-4dbb-b67f-28664c787f00", email: "creator@example.com", displayName: "创作者", createdAt: timestamp },
        expiresAt,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-upload-fail",
        capabilityVersion: "capability-upload-fail",
        pricingVersion: "pricing-upload-fail",
        fetchedAt: timestamp,
        expiresAt,
        quoteAvailable: true,
        models: [{
          id: "image2-pro",
          label: "全能模型2 · 2K",
          description: "",
          modality: "image",
          operation: "generate",
          order: 0,
          input: { textRequired: true, images: { min: 0, max: 1, multiple: false } },
          output: { type: "image", minCount: 1, maxCount: 4 },
          parameters: [
            { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
          ],
          pricing: { mode: "fixed", unit: "image", currency: "CNY", creditsPerYuan: 100, baseCreditMicros: 2_000_000, baseYuanMicros: 20_000, tiers: [] },
        }],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: {
        ok: true,
        data: {
          id: "quote-upload-fail",
          modelId: "image2-pro",
          modelLabel: "全能模型2 · 2K",
          modality: "image",
          quantity: 1,
          normalizedParameters: request.parameters,
          creditMicros: 2_000_000,
          credits: "2",
          yuanMicros: 20_000,
          yuan: "0.02",
          estimated: false,
          pricingUnit: "image",
          catalogVersion: "catalog-upload-fail",
          capabilityVersion: "capability-upload-fail",
          pricingVersion: "pricing-upload-fail",
          expiresAt,
        },
      },
    });
  });
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() === "POST") {
      generationPosts += 1;
      return route.fulfill({ status: 202, json: { ok: true, data: {} } });
    }
    return route.fulfill({ json: { ok: true, data: [] } });
  });
  await page.route("**/api/v1/media/uploads", async (route) => {
    uploadIntents += 1;
    await route.fulfill({
      status: 500,
      json: { ok: false, error: { code: "MEDIA_PROCESSING_UNAVAILABLE", message: "素材上传失败，请重试" } },
    });
  });

  await page.goto("/canvas");
  const imageNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="image"])').first();
  await imageNode.locator('input[type="file"]').setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: image });
  await expect(imageNode.locator("img")).toBeVisible();
  await imageNode.locator(".kc-node-drag-strip").click();
  const generation = page.getByLabel("图片节点创作设置");
  await expect(generation.locator("[data-generation-model-select]")).toHaveValue("image2-pro");
  const generate = generation.getByRole("button", { name: "生成", exact: true });
  await expect(generate).toBeEnabled();

  await generate.click();

  // The reference upload runs first and fails: no generation POST is ever
  // issued, the node surfaces the specific upload error, and the submit button
  // becomes operable again instead of pretending generation started.
  await expect(generation.getByRole("alert")).toContainText("素材上传失败", { timeout: 15_000 });
  expect(uploadIntents).toBeGreaterThanOrEqual(1);
  expect(generationPosts).toBe(0);
  await expect(imageNode.locator(".kc-node-loading")).toHaveCount(0);
  await expect(generate).toBeEnabled();
  await expect(page.locator(".kc-toast--error")).toContainText("素材上传失败");
});

test("video generation shows text-free cinematic feedback across themes and reduced motion", async ({ page }, testInfo) => {
  const createdAt = new Date().toISOString();

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.addInitScript(({ createdAt }) => {
    localStorage.clear();
    const time = Date.parse(createdAt);
    localStorage.setItem("kachang-canvas:project:v1", JSON.stringify({
      schemaVersion: 1,
      id: "project-video-generation-motion",
      name: "视频生成动效",
      nodes: [{
        id: "node-video-validating",
        type: "kachang",
        position: { x: 500, y: 240 },
        width: 340,
        height: 192,
        data: {
          kind: "video",
          body: "镜头从雨夜站台缓慢推进",
          accent: "coral",
          status: "running",
          progress: 64,
          media: null,
          directorCapture: null,
          config: null,
          generation: {
            modelId: "video-model-test",
            parameters: { duration: 6, aspect_ratio: "16:9" },
            maxOutputTokens: null,
            referenceMode: "auto",
            referenceNodeIds: [],
            jobId: "job-video-validating",
            jobVersion: 3,
            jobCreatedAt: createdAt,
            jobStatus: "validating",
            error: null,
          },
          createdAt: time,
          updatedAt: time,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: time,
      updatedAt: time,
    }));
  }, { createdAt });

  await page.goto("/canvas");

  const node = page.locator('.react-flow__node-kachang[data-id="node-video-validating"]');
  const loading = node.locator(".kc-node-loading");
  const field = loading.locator(".kc-video-generation-field");
  const sweep = loading.locator(".kc-video-generation-sweep");
  const glint = loading.locator(".kc-video-generation-glint");
  const scan = loading.locator(".kc-video-generation-scan");
  const rail = loading.locator(".kc-video-generation-rail");

  await expect(loading).toBeVisible();
  await expect(loading).toHaveAttribute("data-loading-activity", "generation");
  await expect(loading).toHaveAttribute("data-generation-stage", "validating");
  await expect(loading).toHaveAttribute("aria-label", /.+/);
  await expect(page.locator("html")).toHaveAttribute("data-canvas-style", "studio");
  await expect(loading.locator(".kc-node-loading-content")).toHaveCount(0);
  await expect(loading.locator(".kc-node-loading-label")).toHaveCount(0);
  await expect(loading.locator(".kc-node-loading-value")).toHaveCount(0);
  await expect(loading.locator(".kc-node-loading-track")).toHaveCount(0);
  await expect(rail).toBeVisible();
  await expect(rail).toHaveCSS("height", "1px");
  await expect(loading.locator(".kc-cinematic-generation-stage")).toHaveCount(0);
  await expect(loading.locator(".kc-cinematic-generation-label")).toHaveCount(0);
  await expect(loading.locator(".kc-cinematic-generation-progress")).toHaveCount(0);
  await expect(field).toBeVisible();
  await expect(sweep).toBeVisible();
  await expect(glint).toBeVisible();
  await expect(scan).toBeVisible();
  const scanGeometry = await scan.evaluate((element) => {
    const sceneHeight = element.parentElement?.getBoundingClientRect().height ?? 0;
    return {
      coverage: sceneHeight > 0 ? element.getBoundingClientRect().height / sceneHeight : 0,
      lineHeight: getComputedStyle(element, "::before").height,
    };
  });
  expect(scanGeometry.coverage).toBeGreaterThan(0.95);
  expect(scanGeometry.lineHeight).toBe("1px");
  await expect(node.locator(".kc-node-surface")).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(node.locator(".kc-media-empty")).toHaveCSS("opacity", "0");
  expect(await loading.evaluate((element) => element.style.getPropertyValue("--kc-video-generation-field-opacity"))).toBe("0.68");
  await expect(loading.locator(".kc-video-generation-stages")).toHaveCount(0);

  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.screenshot({ path: testInfo.outputPath("video-generation-validating-dark.png"), fullPage: false });
  await page.getByLabel("切换主题").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: testInfo.outputPath("video-generation-validating-light.png"), fullPage: false });

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(field).toHaveCSS("animation-name", "kc-video-generation-field-drift");
  await expect(sweep).toHaveCSS("animation-name", "kc-video-generation-sweep");
  await expect(glint).toHaveCSS("animation-name", "kc-video-generation-glint");
  await expect(field).toHaveCSS("animation-duration", "7.2s");
  await expect(sweep).toHaveCSS("animation-iteration-count", "infinite");
});

test("image generation uses the same frameless feedback without visible copy", async ({ page }) => {
  const createdAt = new Date().toISOString();

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.addInitScript(({ createdAt }) => {
    localStorage.clear();
    const time = Date.parse(createdAt);
    localStorage.setItem("kachang-canvas:project:v1", JSON.stringify({
      schemaVersion: 1,
      id: "project-image-generation-motion",
      name: "image-generation-motion",
      nodes: [{
        id: "node-image-running",
        type: "kachang",
        position: { x: 500, y: 240 },
        width: 340,
        height: 192,
        data: {
          kind: "image",
          body: "image generation motion",
          accent: "blue",
          status: "running",
          progress: 42,
          media: null,
          directorCapture: null,
          config: null,
          generation: {
            modelId: "image-model-test",
            parameters: { aspect_ratio: "16:9" },
            maxOutputTokens: null,
            referenceMode: "auto",
            referenceNodeIds: [],
            jobId: "job-image-running",
            jobVersion: 3,
            jobCreatedAt: createdAt,
            jobStatus: "running",
            error: null,
          },
          createdAt: time,
          updatedAt: time,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAt: time,
      updatedAt: time,
    }));
  }, { createdAt });

  await page.goto("/canvas");

  const node = page.locator('.react-flow__node-kachang[data-id="node-image-running"]');
  const loading = node.locator(".kc-node-loading");

  await expect(loading).toHaveAttribute("aria-label", /.+/);
  await expect(loading).toHaveClass(/kc-node-loading--cinematic/);
  await expect(loading.locator(".kc-video-generation-field")).toBeVisible();
  await expect(loading.locator(".kc-video-generation-sweep")).toBeVisible();
  await expect(loading.locator(".kc-video-generation-glint")).toBeVisible();
  await expect(loading.locator(".kc-node-loading-content")).toHaveCount(0);
  await expect(loading.locator(".kc-node-loading-label")).toHaveCount(0);
  await expect(loading.locator(".kc-node-loading-value")).toHaveCount(0);
  await expect(loading.locator(".kc-node-loading-track")).toHaveCount(0);
  await expect(loading.locator(".kc-video-generation-rail")).toBeVisible();
  await expect(loading.locator(".kc-cinematic-generation-stage")).toHaveCount(0);
  await expect(loading.locator(".kc-cinematic-generation-label")).toHaveCount(0);
  await expect(loading.locator(".kc-cinematic-generation-progress")).toHaveCount(0);
  await expect(node.locator(".kc-node-surface")).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  await expect(node.locator(".kc-media-empty")).toHaveCSS("opacity", "0");
});

test("recovers a saved running job after refresh", async ({ page }) => {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const quote = {
    id: "quote-recovery-1",
    modelId: "creative-text",
    modelLabel: "全能文本",
    modality: "text",
    quantity: 1,
    normalizedParameters: { messages: [{ role: "user", content: "继续" }] },
    creditMicros: 100_000,
    credits: "0.1",
    yuanMicros: 1_000,
    yuan: "0.001",
    estimated: true,
    pricingUnit: "token",
    catalogVersion: "catalog-1",
    capabilityVersion: "capability-1",
    pricingVersion: "pricing-1",
    expiresAt,
  };
  const running = {
    schemaVersion: 1,
    version: 2,
    id: "job-recovery-1",
    projectId: "project-recovery",
    nodeId: "node-recovery",
    modelId: "creative-text",
    modelLabel: "全能文本",
    modality: "text",
    status: "running",
    progress: 54,
    quote,
    artifacts: [],
    error: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: createdAt,
    completedAt: null,
  };

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        user: { id: "07d3b269-6bc3-4dbb-b67f-28664c787f00", email: "creator@example.com", displayName: "创作者", createdAt },
        expiresAt,
      },
    },
  }));
  await page.route("**/api/v1/generation-jobs?*", (route) => route.fulfill({ json: { ok: true, data: [running] } }));
  await page.route("**/api/v1/generation-jobs/job-recovery-1/events", (route) => {
    const completedAt = new Date().toISOString();
    const completed = {
      ...running,
      version: 3,
      status: "completed",
      progress: 100,
      artifacts: [{ id: "artifact-recovery-1", kind: "text", text: "刷新后恢复的最终结果", createdAt: completedAt }],
      updatedAt: completedAt,
      completedAt,
    };
    return route.fulfill({
      contentType: "text/event-stream",
      body: `id: generation:job-recovery-1:3\nevent: job\ndata: ${JSON.stringify({ type: "job", job: completed })}\n\n`,
    });
  });
  await page.addInitScript(({ createdAt }) => {
    localStorage.clear();
    const time = Date.parse(createdAt);
    localStorage.setItem("kachang-canvas:project:v1", JSON.stringify({
      schemaVersion: 1,
      id: "project-recovery",
      name: "恢复测试",
      nodes: [{
        id: "node-recovery",
        type: "kachang",
        position: { x: 420, y: 180 },
        width: 308,
        height: 176,
        data: {
          kind: "text",
          body: "等待生成结果",
          accent: "jade",
          status: "running",
          progress: 12,
          media: null,
          directorCapture: null,
          generation: {
            modelId: "creative-text",
            parameters: {},
            maxOutputTokens: 1024,
            jobId: "job-recovery-1",
            jobVersion: 1,
            jobCreatedAt: createdAt,
            error: null,
          },
          createdAt: time,
          updatedAt: time,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 160, y: 120, zoom: 1 },
      createdAt: time,
      updatedAt: time,
    }));
  }, { createdAt });

  await page.goto("/canvas");
  const node = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  await expect(node.locator(".kc-node-text-preview")).toContainText("刷新后恢复的最终结果");
  await expect(node.locator(".kc-node-loading")).toHaveCount(0);
});

test("active and awaiting image nodes lock only themselves while an idle node submits", async ({ page }) => {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const submissions: Array<Record<string, unknown>> = [];
  let quotedIdleCount = -1;
  const quote = {
    id: "quote-unknown-1",
    modelId: "image-batch",
    modelLabel: "批量图片模型",
    modality: "image" as const,
    quantity: 1,
    normalizedParameters: { prompt: "节点 B 等待核对", n: 1 },
    creditMicros: 2_000_000,
    credits: "2",
    yuanMicros: 20_000,
    yuan: "0.02",
    estimated: false,
    pricingUnit: "image" as const,
    catalogVersion: "catalog-unknown-1",
    capabilityVersion: "capability-unknown-1",
    pricingVersion: "pricing-unknown-1",
    expiresAt,
  };
  const pending = {
    schemaVersion: 1,
    version: 1,
    id: "job-unknown-1",
    projectId: "project-unknown",
    nodeId: "node-unknown",
    modelId: "image-batch",
    modelLabel: "批量图片模型",
    modality: "image",
    status: "submission_unknown",
    progress: 0,
    quote,
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
  const active = {
    ...pending,
    id: "job-active-1",
    nodeId: "node-active",
    status: "running",
    progress: 42,
    quote: { ...quote, id: "quote-active-1", normalizedParameters: { prompt: "节点 A 正在生成", n: 1 } },
    error: null,
  };

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        user: { id: "07d3b269-6bc3-4dbb-b67f-28664c787f00", email: "creator@example.com", displayName: "创作者", createdAt },
        expiresAt,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-unknown-1",
        capabilityVersion: "capability-unknown-1",
        pricingVersion: "pricing-unknown-1",
        fetchedAt: createdAt,
        expiresAt,
        quoteAvailable: true,
        models: [{
          id: "image-batch",
          label: "批量图片模型",
          description: "",
          modality: "image",
          operation: "generate",
          order: 0,
          input: { textRequired: true },
          output: { type: "image", minCount: 1, maxCount: 4 },
          parameters: [
            { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
            { name: "n", label: "生成张数", type: "integer", required: false, default: 1, min: 1, max: 4, step: 1, mutuallyExclusiveWith: [] },
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
        }],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", (route) => {
    const request = route.request().postDataJSON();
    const outputCount = Number(request.parameters.n ?? 1);
    if (request.parameters.prompt === "节点 C 可以提交") quotedIdleCount = outputCount;
    return route.fulfill({
      json: {
        ok: true,
        data: {
          ...quote,
          id: `quote-${request.parameters.prompt}-${outputCount}`,
          normalizedParameters: request.parameters,
          creditMicros: outputCount * 2_000_000,
          credits: String(outputCount * 2),
        },
      },
    });
  });
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: { ok: true, data: [active, pending] } });
    }
    const request = route.request().postDataJSON();
    submissions.push(request);
    const completedAt = new Date().toISOString();
    return route.fulfill({
      status: 202,
      json: {
        ok: true,
        data: {
          schemaVersion: 1,
          version: 1,
          id: "job-idle-1",
          projectId: request.projectId,
          nodeId: request.nodeId,
          modelId: "image-batch",
          modelLabel: "批量图片模型",
          modality: "image",
          status: "completed",
          progress: 100,
          quote: {
            ...quote,
            id: request.expectedQuote.id,
            normalizedParameters: request.parameters,
            creditMicros: Number(request.parameters.n) * 2_000_000,
            credits: String(Number(request.parameters.n) * 2),
          },
          artifacts: [],
          error: null,
          createdAt: completedAt,
          updatedAt: completedAt,
          startedAt: completedAt,
          completedAt,
        },
      },
    });
  });
  await page.route("**/api/v1/generation-jobs/job-active-1/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    headers: { "Cache-Control": "no-cache" },
    body: `id: generation:job-active-1:1\nevent: job\ndata: ${JSON.stringify({ type: "job", job: active })}\n\n`,
  }));
  await page.addInitScript(({ createdAt }) => {
    localStorage.clear();
    const time = Date.parse(createdAt);
    localStorage.setItem("kachang-canvas:project:v1", JSON.stringify({
      schemaVersion: 1,
      id: "project-unknown",
      name: "节点级并发测试",
      nodes: [{
        id: "node-active",
        type: "kachang",
        position: { x: 40, y: 100 },
        width: 340,
        height: 214,
        data: {
          kind: "image",
          body: "节点 A 正在生成",
          accent: "blue",
          status: "running",
          progress: 42,
          media: null,
          directorCapture: null,
          generation: {
            modelId: "image-batch",
            parameters: { n: 1 },
            maxOutputTokens: null,
            jobId: "job-active-1",
            jobVersion: 1,
            jobCreatedAt: createdAt,
            jobStatus: "running",
            error: null,
          },
          createdAt: time,
          updatedAt: time,
        },
      }, {
        id: "node-unknown",
        type: "kachang",
        position: { x: 420, y: 100 },
        width: 340,
        height: 214,
        data: {
          kind: "image",
          body: "节点 B 等待核对",
          accent: "blue",
          status: "error",
          progress: null,
          media: null,
          directorCapture: null,
          generation: {
            modelId: "image-batch",
            parameters: { n: 1 },
            maxOutputTokens: null,
            jobId: "job-unknown-1",
            jobVersion: 1,
            jobCreatedAt: createdAt,
            jobStatus: "submission_unknown",
            error: null,
          },
          createdAt: time,
          updatedAt: time,
        },
      }, {
        id: "node-idle",
        type: "kachang",
        position: { x: 800, y: 100 },
        width: 340,
        height: 214,
        data: {
          kind: "image",
          body: "节点 C 可以提交",
          accent: "blue",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          generation: {
            modelId: "image-batch",
            parameters: { n: 1 },
            maxOutputTokens: null,
            jobId: null,
            jobVersion: null,
            jobCreatedAt: null,
            jobStatus: null,
            error: null,
          },
          createdAt: time,
          updatedAt: time,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 70, y: 150, zoom: 0.9 },
      createdAt: time,
      updatedAt: time,
    }));
  }, { createdAt });

  await page.goto("/canvas");
  const activeNode = page.locator('.react-flow__node-kachang[data-id="node-active"]');
  const unknownNode = page.locator('.react-flow__node-kachang[data-id="node-unknown"]');
  const idleNode = page.locator('.react-flow__node-kachang[data-id="node-idle"]');

  await activeNode.locator(".kc-node-drag-strip").click();
  let generation = page.getByLabel("图片节点创作设置");
  let generateButton = generation.locator(".kc-generation-submit");
  await expect(generateButton).toBeDisabled();
  await expect(generateButton).toHaveAttribute("aria-label", "生成");
  await expect(generateButton).toHaveText("生成");
  await expect(generateButton.locator(".is-spinning")).toHaveCount(1);
  await expect(generation.locator(".kc-generation-compact-status")).toHaveCount(0);
  await expect(generation.getByLabel("生成张数")).toBeDisabled();

  await unknownNode.locator(".kc-node-drag-strip").click();
  generation = page.getByLabel("图片节点创作设置");
  generateButton = generation.locator(".kc-generation-submit");
  await expect(unknownNode.locator(".kc-node-wrap")).toHaveAttribute("data-node-status", "error");
  await expect(generation.locator(".kc-generation-compact-status.is-pending")).toHaveCount(0);
  await expect(unknownNode.locator(".kc-node-loading")).toHaveCount(0);
  await expect(unknownNode.locator(".kc-node-generation-failure")).toContainText("任务提交结果待确认");
  await expect(generateButton).toBeDisabled();
  await expect(generateButton).toHaveAttribute("aria-label", "生成");
  await expect(generateButton).toHaveText("生成");
  await expect(generateButton.locator(".is-spinning")).toHaveCount(1);
  await expect(generation.getByLabel("生成张数")).toBeDisabled();

  await idleNode.locator(".kc-node-drag-strip").click();
  generation = page.getByLabel("图片节点创作设置");
  const outputCount = generation.getByLabel("生成张数");
  await expect(outputCount).toBeEnabled();
  await outputCount.click();
  await page.getByRole("listbox", { name: "生成张数" }).getByRole("option", { name: "3 张" }).click();
  await expect.poll(() => quotedIdleCount).toBe(3);
  const submit = generation.locator(".kc-generation-submit");
  await expect(submit).toBeEnabled();
  await expect(submit).toHaveText("生成");
  await expect(submit).not.toContainText("积分");
  await expect(generation.locator(".kc-generation-compact-credit")).toHaveText("需 6 积分");
  const composer = page.locator(".kc-node-prompt-composer");
  const [composerBox, submitBox] = await Promise.all([composer.boundingBox(), submit.boundingBox()]);
  expect(composerBox).not.toBeNull();
  expect(submitBox).not.toBeNull();
  expect(submitBox!.x + submitBox!.width).toBeLessThanOrEqual(composerBox!.x + composerBox!.width + 1);
  expect(await generation.locator(".kc-generation-compact-bar").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await submit.click();

  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({
    projectId: "project-unknown",
    nodeId: "node-idle",
    modelId: "image-batch",
    modality: "image",
    parameters: { prompt: "节点 C 可以提交", n: 3 },
    quantity: 1,
  });
});

test("a connected text node supplies the effective prompt for a blank image node", async ({ page }) => {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const linkedText = "rainlit alley with mirrored pavement";
  const quotedPrompts: string[] = [];
  let submittedPrompt: string | null = null;
  let submittedInputs: Record<string, unknown> | null = null;
  const quote = {
    id: "quote-linked-text-1",
    modelId: "image-from-text",
    modelLabel: "Linked text image model",
    modality: "image" as const,
    quantity: 1,
    normalizedParameters: { prompt: linkedText },
    creditMicros: 2_000_000,
    credits: "2",
    yuanMicros: 20_000,
    yuan: "0.02",
    estimated: false,
    pricingUnit: "image" as const,
    catalogVersion: "catalog-linked-text-1",
    capabilityVersion: "capability-linked-text-1",
    pricingVersion: "pricing-linked-text-1",
    expiresAt,
  };

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        user: { id: "07d3b269-6bc3-4dbb-b67f-28664c787f00", email: "creator@example.com", displayName: "Creator", createdAt },
        expiresAt,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-linked-text-1",
        capabilityVersion: "capability-linked-text-1",
        pricingVersion: "pricing-linked-text-1",
        fetchedAt: createdAt,
        expiresAt,
        quoteAvailable: true,
        models: [{
          id: "image-from-text",
          label: "Linked text image model",
          description: "",
          modality: "image",
          operation: "generate",
          order: 0,
          input: { textRequired: true },
          output: { type: "image", minCount: 1, maxCount: 1 },
          parameters: [{ name: "prompt", label: "Prompt", type: "string", required: true, mutuallyExclusiveWith: [] }],
          pricing: {
            mode: "fixed",
            unit: "image",
            currency: "CNY",
            creditsPerYuan: 100,
            baseCreditMicros: 2_000_000,
            baseYuanMicros: 20_000,
            tiers: [],
          },
        }],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", (route) => {
    const request = route.request().postDataJSON();
    quotedPrompts.push(String(request.parameters.prompt));
    return route.fulfill({
      json: { ok: true, data: { ...quote, normalizedParameters: request.parameters } },
    });
  });
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { ok: true, data: [] } });
    const request = route.request().postDataJSON();
    submittedPrompt = String(request.parameters.prompt);
    submittedInputs = request.inputs;
    return route.fulfill({
      status: 202,
      json: {
        ok: true,
        data: {
          schemaVersion: 1,
          version: 1,
          id: "job-linked-text-1",
          projectId: request.projectId,
          nodeId: request.nodeId,
          modelId: "image-from-text",
          modelLabel: "Linked text image model",
          modality: "image",
          status: "completed",
          progress: 100,
          quote: { ...quote, normalizedParameters: request.parameters },
          artifacts: [],
          error: null,
          createdAt,
          updatedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
        },
      },
    });
  });
  await page.addInitScript(({ createdAt, linkedText }) => {
    localStorage.clear();
    const time = Date.parse(createdAt);
    const generation = {
      modelId: "image-from-text",
      parameters: {},
      maxOutputTokens: null,
      referenceMode: "auto",
      referenceNodeIds: [],
      jobId: null,
      jobVersion: null,
      jobCreatedAt: null,
      jobStatus: null,
      error: null,
    };
    localStorage.setItem("kachang-canvas:project:v1", JSON.stringify({
      schemaVersion: 1,
      id: "project-linked-text",
      name: "Linked text prompt test",
      nodes: [{
        id: "source-text",
        type: "kachang",
        position: { x: 80, y: 180 },
        width: 308,
        height: 176,
        data: {
          kind: "text",
          body: linkedText,
          accent: "jade",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          config: null,
          generation,
          createdAt: time,
          updatedAt: time,
        },
      }, {
        id: "target-image",
        type: "kachang",
        position: { x: 480, y: 180 },
        width: 308,
        height: 176,
        data: {
          kind: "image",
          body: "",
          accent: "blue",
          status: "idle",
          progress: null,
          media: null,
          directorCapture: null,
          config: null,
          generation,
          createdAt: time,
          updatedAt: time,
        },
      }],
      edges: [{ id: "source-to-image", source: "source-text", target: "target-image" }],
      groups: [],
      viewport: { x: 140, y: 120, zoom: 1 },
      createdAt: time,
      updatedAt: time,
    }));
  }, { createdAt, linkedText });

  await page.goto("/canvas");
  const imageNode = page.locator('.react-flow__node-kachang[data-id="target-image"]');
  await imageNode.locator(".kc-node-drag-strip").click();

  const composer = page.locator(".kc-node-prompt-composer");
  const editor = composer.locator("[data-prompt-editor]");
  const generation = composer.locator(".kc-generation-panel");
  const generate = generation.locator(".kc-generation-submit");
  await expect(editor).toHaveText("");
  await expect(editor).toHaveAttribute("aria-placeholder", "已连接 1 条文本，生成时自动使用");
  await expect(generation.locator(".kc-generation-compact-status.is-linked")).toContainText("已连接 1 条文本，生成时自动使用");
  await expect.poll(() => quotedPrompts.at(-1)).toBe(linkedText);
  await expect(generate).toBeEnabled();

  await generate.click();
  await expect.poll(() => submittedPrompt).toBe(linkedText);
  expect(submittedInputs).toEqual({ images: [], styleImages: [], elementImages: [], videos: [], audios: [] });
});

test.skip("failed generation can be cleared and submitted again", async ({ page }) => {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  let submitted = 0;
  const retryQuote = {
    id: "quote-retry-1",
    modelId: "creative-text",
    modelLabel: "全能文本",
    modality: "text" as const,
    quantity: 1,
    normalizedParameters: { messages: [{ role: "user", content: "retry" }] },
    creditMicros: 100_000,
    credits: "0.1",
    yuanMicros: 1_000,
    yuan: "0.001",
    estimated: true,
    pricingUnit: "token" as const,
    catalogVersion: "catalog-retry-1",
    capabilityVersion: "capability-retry-1",
    pricingVersion: "pricing-retry-1",
    expiresAt,
  };

  await page.route("**/api/v1/auth/session", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        user: { id: "07d3b269-6bc3-4dbb-b67f-28664c787f00", email: "creator@example.com", displayName: "创作者", createdAt },
        expiresAt,
      },
    },
  }));
  await page.route("**/api/v1/model-catalog", (route) => route.fulfill({
    json: {
      ok: true,
      data: {
        version: "catalog-retry-1",
        capabilityVersion: "capability-retry-1",
        pricingVersion: "pricing-retry-1",
        fetchedAt: createdAt,
        expiresAt,
        quoteAvailable: true,
        models: [{
          id: "creative-text",
          label: "全能文本",
          description: "",
          modality: "text",
          operation: "chat",
          order: 0,
          input: { textRequired: true },
          output: { type: "text", minCount: 1, maxCount: 1 },
          parameters: [{ name: "messages", label: "消息", type: "array", required: true, mutuallyExclusiveWith: [] }],
          pricing: {
            mode: "token",
            unit: "token",
            currency: "CNY",
            creditsPerYuan: 100,
            tiers: [],
            inputCreditMicrosPerMillion: 15_000_000,
            outputCreditMicrosPerMillion: 90_000_000,
            inputYuanMicrosPerMillion: 150_000,
            outputYuanMicrosPerMillion: 900_000,
          },
        }],
      },
    },
  }));
  await page.route("**/api/v1/generation-quotes", (route) => route.fulfill({
    json: {
      ok: true,
      data: retryQuote,
    },
  }));
  await page.route("**/api/v1/generation-jobs/job-retry-1/events", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: "",
  }));
  await page.route("**/api/v1/generation-jobs*", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { ok: true, data: [] } });
    submitted += 1;
    return route.fulfill({
      status: 202,
      json: {
        ok: true,
        data: {
          schemaVersion: 1,
          version: 1,
          id: "job-retry-1",
          projectId: "project-retry",
          nodeId: "node-retry",
          modelId: "creative-text",
          modelLabel: "全能文本",
          modality: "text",
          status: "queued",
          progress: 0,
          quote: retryQuote,
          artifacts: [],
          error: null,
          createdAt,
          updatedAt: createdAt,
          startedAt: null,
          completedAt: null,
        },
      },
    });
  });
  await page.addInitScript(({ createdAt }) => {
    localStorage.clear();
    const time = Date.parse(createdAt);
    localStorage.setItem("kachang-canvas:project:v1", JSON.stringify({
      schemaVersion: 1,
      id: "project-retry",
      name: "重试测试",
      nodes: [{
        id: "node-retry",
        type: "kachang",
        position: { x: 420, y: 180 },
        width: 308,
        height: 176,
        data: {
          kind: "text",
          body: "失败后重新生成",
          accent: "jade",
          status: "error",
          progress: null,
          media: null,
          directorCapture: null,
          generation: {
            modelId: "creative-text",
            parameters: {},
            maxOutputTokens: 1024,
            jobId: "job-failed-1",
            jobVersion: 2,
            jobCreatedAt: createdAt,
            error: "模型返回失败，请重试",
          },
          createdAt: time,
          updatedAt: time,
        },
      }],
      edges: [],
      groups: [],
      viewport: { x: 160, y: 120, zoom: 1 },
      createdAt: time,
      updatedAt: time,
    }));
  }, { createdAt });

  await page.goto("/canvas");
  const node = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  await node.locator(".kc-node-drag-strip").click();
  const generation = page.getByLabel("文本节点创作设置");
  await expect(generation.getByRole("alert")).toContainText("模型返回失败");
  await generation.getByRole("button", { name: "重试" }).click();
  await expect(generation.getByRole("alert")).toHaveCount(0);
  await generation.getByRole("button", { name: "生成", exact: true }).click();
  expect(submitted).toBe(1);
});

function publicMedia(id: string, name: string, size: number, timestamp: string) {
  return {
    id,
    kind: "image",
    name,
    mimeType: "image/png",
    size,
    sha256: null,
    width: 1,
    height: 1,
    durationMs: null,
    status: "ready",
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function testCatalogModel(id: string, label: string, modality: "image" | "video") {
  return {
    id,
    label,
    description: "",
    modality,
    operation: modality === "video" ? "video.generate" : "generate",
    order: 1,
    input: { textRequired: true },
    output: { type: modality, minCount: 1, maxCount: 1 },
    parameters: [{ name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] }],
    pricing: {
      mode: "fixed",
      unit: "request",
      currency: "CNY",
      creditsPerYuan: 100,
      baseCreditMicros: 1,
      baseYuanMicros: 1,
      tiers: [],
    },
  };
}

function staleImage2AModel() {
  return {
    ...testCatalogModel("image2-A", "全能模型2-A", "image"),
    parameters: [
      { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
      { name: "resolution", label: "分辨率", type: "string", required: false, default: "1k", options: ["1k", "2k", "4k"], mutuallyExclusiveWith: [] },
      { name: "size", label: "像素尺寸或兼容比例", type: "string", required: false, mutuallyExclusiveWith: [] },
      { name: "aspect_ratio", label: "画面比例", type: "string", required: false, default: "auto", options: ["auto", "16:9"], mutuallyExclusiveWith: [] },
      { name: "aspectRatio", label: "画面比例（兼容别名）", type: "string", required: false, default: "auto", options: ["auto", "16:9"], mutuallyExclusiveWith: [] },
      { name: "ratio", label: "画面比例（兼容别名）", type: "string", required: false, default: "auto", options: ["auto", "16:9"], mutuallyExclusiveWith: [] },
      { name: "quality", label: "质量", type: "string", required: false, default: "standard", options: ["low", "standard", "high"], mutuallyExclusiveWith: [] },
      { name: "n", label: "生成数量", type: "integer", required: false, fixed: 1, mutuallyExclusiveWith: [] },
    ],
  };
}

function staleH3Model() {
  return {
    ...testCatalogModel("minimax_h3", "Minimax H3", "video"),
    parameters: [
      { name: "prompt", label: "提示词", type: "string", required: true, mutuallyExclusiveWith: [] },
      { name: "seconds", label: "时长（秒）", type: "integer", required: false, default: 4, min: 4, max: 15, mutuallyExclusiveWith: [] },
      { name: "duration", label: "时长兼容字段（秒）", type: "integer", required: false, default: 4, min: 4, max: 15, mutuallyExclusiveWith: [] },
      { name: "size", label: "画面尺寸", type: "string", required: false, default: "1080p", options: ["768", "1080p"], mutuallyExclusiveWith: [] },
      { name: "resolution", label: "分辨率", type: "string", required: false, default: "768", options: ["768", "1080p"], mutuallyExclusiveWith: [] },
      { name: "async", label: "异步任务", type: "boolean", required: false, fixed: true, mutuallyExclusiveWith: [] },
    ],
  };
}
