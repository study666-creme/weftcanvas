import { expect, test } from "@playwright/test";

import { seedStarterCanvas } from "./starter-canvas.fixture";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) =>
    route.fulfill({ json: { ok: true, data: null } }),
  );
  await page.addInitScript(() => {
    if (sessionStorage.getItem("weftcanvas-material-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("weftcanvas-material-e2e-cleaned", "1");
  });
  await seedStarterCanvas(page);
});

test("default canvas keeps transparent nodes visible with stable control feedback states", async ({
  page,
}, testInfo) => {
  await page.goto("/canvas");

  const textNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="text"])',
  );
  const nodeWrap = textNode.locator(".wc-node-wrap");
  const surface = textNode.locator(".wc-node-surface");
  await expect(nodeWrap).toHaveAttribute("data-node-status", "idle");
  await expect(nodeWrap).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("html")).toHaveAttribute("data-canvas-style", "studio");
  await expect(surface).toHaveCSS("border-radius", "7px");
  await expect(textNode.locator(".wc-node-type-label svg")).toHaveCSS("border-top-width", "0px");
  await expect(textNode.locator(".wc-node-port-zone--right")).toHaveAttribute(
    "data-node-port-style",
    "classic",
  );
  const studioMaterial = await surface.evaluate((element) => {
    const style = getComputedStyle(element);
    const afterStyle = getComputedStyle(element, "::after");
    return {
      background: style.backgroundColor,
      backgroundImage: style.backgroundImage,
      border: style.borderTopColor,
      shadow: style.boxShadow,
      innerRim: afterStyle.boxShadow,
      filter: style.filter,
      backdropFilter: style.backdropFilter,
    };
  });
  expect(studioMaterial.background).toMatch(/^(?:rgba?|color)\(/);
  expect(studioMaterial.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(studioMaterial.backgroundImage).not.toBe("none");
  expect(studioMaterial.border).not.toBe("rgba(0, 0, 0, 0)");
  expect(studioMaterial.shadow).not.toBe("none");
  expect(studioMaterial.innerRim).not.toBe("none");
  expect(studioMaterial.filter).toBe("none");
  expect(studioMaterial.backdropFilter).toBe("none");
  const entrance = await surface.evaluate((element) => {
    const style = getComputedStyle(element);
    return { name: style.animationName, duration: style.animationDuration };
  });
  expect(entrance).toEqual({ name: "wc-node-enter", duration: "0.22s" });

  const imageNode = page.locator(
    '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"])',
  );
  const preview = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 40;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "#26332f";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#91a99d";
    context.fillRect(12, 8, 40, 24);
    return canvas.toDataURL("image/png").split(",")[1]!;
  });
  await imageNode.locator('input[type="file"]').setInputFiles({
    name: "frameless-node.png",
    mimeType: "image/png",
    buffer: Buffer.from(preview, "base64"),
  });
  await expect(imageNode.locator(".wc-node-media-frame img")).toBeVisible();
  const imageMaterial = await imageNode.evaluate((node) => {
    const imageSurface = node.querySelector<HTMLElement>(".wc-node-surface")!;
    const frame = node.querySelector<HTMLElement>(".wc-node-media-frame")!;
    const surfaceStyle = getComputedStyle(imageSurface);
    const frameAfterStyle = getComputedStyle(frame, "::after");
    return {
      background: surfaceStyle.backgroundColor,
      border: surfaceStyle.borderTopColor,
      shadow: surfaceStyle.boxShadow,
      frameBorder: frameAfterStyle.borderTopColor,
      frameShadow: frameAfterStyle.boxShadow,
    };
  });
  expect(imageMaterial.background).toBe("rgba(0, 0, 0, 0)");
  expect(imageMaterial.border).not.toBe("rgba(0, 0, 0, 0)");
  expect(imageMaterial.shadow).not.toBe("none");
  expect(imageMaterial.frameBorder).toBe("rgba(0, 0, 0, 0)");
  expect(imageMaterial.frameShadow).toBe("none");

  await page.screenshot({ path: testInfo.outputPath("studio-node-hierarchy.png"), fullPage: true });

  await textNode.hover();
  await expect(surface).not.toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
  const toolbar = page.getByRole("toolbar", { name: "节点操作" });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByLabel("全屏编辑")).toHaveAttribute("data-toolbar-action", "edit");
  await expect(toolbar.getByLabel("删除节点")).toHaveAttribute("data-toolbar-action", "delete");

  await imageNode.hover();
  const imageToolbar = page.locator('.wc-node-action-toolbar[data-node-kind="image"]');
  await expect(imageToolbar.locator('[data-toolbar-action="face-grid"]')).toBeVisible();

  await textNode.locator(".wc-node-drag-strip").click();
  await expect(textNode).toHaveClass(/selected/);
  expect(await surface.evaluate((element) => getComputedStyle(element, "::before").content)).toBe(
    "none",
  );

  const panButton = page.getByRole("navigation", { name: "编辑工具" }).getByLabel("平移画布");
  await expect(panButton).toHaveAttribute("aria-pressed", "false");
  await panButton.click();
  await expect(panButton).toHaveAttribute("aria-pressed", "true");

  const zoom = page.getByLabel("画布缩放");
  await expect(zoom).toHaveAttribute("aria-valuetext", /%$/);
  expect(
    await zoom.evaluate((element) => element.style.getPropertyValue("--wc-zoom-progress")),
  ).toMatch(/%$/);
});

test("connected material rail only shows direct media and can unlink it without deleting nodes", async ({
  page,
}) => {
  const now = Date.now();
  const generation = {
    modelId: null,
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
  const media = (id: string, kind: "image" | "video") => ({
    id: `${id}-media`,
    name: `${id}.${kind === "image" ? "png" : "mp4"}`,
    mimeType: kind === "image" ? "image/png" : "video/mp4",
    size: 1,
    source: "server",
    serverId: null,
    width: 640,
    height: 360,
    durationMs: kind === "video" ? 1_000 : null,
  });
  const node = (
    id: string,
    kind: "image" | "video",
    x: number,
    nodeMedia: ReturnType<typeof media> | null,
    selected = false,
    body = "",
  ) => ({
    id,
    type: "weftcanvas",
    position: { x, y: 180 },
    selected,
    data: {
      kind,
      body,
      accent: "jade",
      status: nodeMedia ? "success" : "idle",
      progress: null,
      media: nodeMedia,
      directorCapture: null,
      config: null,
      generation,
      createdAt: now,
      updatedAt: now,
    },
  });
  const sharedDirectMedia = media("direct", "video");
  const project = {
    schemaVersion: 1,
    id: "direct-material-project",
    name: "直接素材测试",
    nodes: [
      node("transitive", "image", 80, media("transitive", "image"), false, "间接图片素材"),
      node("direct", "video", 400, sharedDirectMedia, false, "直接视频素材"),
      node("direct-copy", "video", 680, sharedDirectMedia, false, "同媒体直连副本"),
      node("target", "video", 840, null, true),
    ],
    edges: [
      { id: "transitive-direct", source: "transitive", target: "direct" },
      { id: "direct-target", source: "direct", target: "target" },
      { id: "direct-copy-target", source: "direct-copy", target: "target" },
    ],
    groups: [],
    viewport: { x: 80, y: 120, zoom: 0.9 },
    createdAt: now,
    updatedAt: now,
  };
  await page.addInitScript((seed) => {
    localStorage.setItem(
      `weftcanvas:project-data:v1:${encodeURIComponent(seed.id)}`,
      JSON.stringify(seed),
    );
    localStorage.setItem(
      "weftcanvas:projects:v1",
      JSON.stringify({
        version: 1,
        projects: [
          {
            id: seed.id,
            name: seed.name,
            createdAt: seed.createdAt,
            updatedAt: seed.updatedAt,
            nodeCount: seed.nodes.length,
          },
        ],
      }),
    );
    localStorage.setItem("weftcanvas:active-project:v1", seed.id);
  }, project);
  await page.goto("/canvas");
  await expect(page.locator(".react-flow__edge")).toHaveCount(3);
  const rail = page.getByLabel("已连接素材");
  await expect(rail.locator(".wc-node-reference-chip")).toHaveCount(2);
  const directChoice = rail.getByRole("button", { name: "引用素材 直接视频素材" });
  const material = directChoice.locator("..");
  await expect(rail.getByRole("button", { name: "引用素材 同媒体直连副本" })).toBeVisible();
  await expect(rail).not.toContainText("间接图片素材");
  const unlink = material.locator(".wc-node-reference-remove");
  await expect(unlink).toHaveAttribute("aria-label", "取消素材链接 直接视频素材");
  await expect(unlink).toHaveCSS("opacity", "0");
  await expect(unlink).toHaveCSS("pointer-events", "none");
  await material.hover();
  await expect(unlink).toHaveCSS("opacity", "1");
  await expect(unlink).toHaveCSS("pointer-events", "auto");

  await unlink.click();
  await expect(rail.locator(".wc-node-reference-chip")).toHaveCount(1);
  await expect(page.locator(".react-flow__node-weftcanvas")).toHaveCount(4);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);
  await expect(page.locator('.react-flow__edge[data-id="transitive-direct"]')).toHaveCount(1);
  await expect(page.locator('.react-flow__edge[data-id="direct-target"]')).toHaveCount(0);
  await expect(page.locator('.react-flow__edge[data-id="direct-copy-target"]')).toHaveCount(1);
});
