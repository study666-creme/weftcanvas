import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../..");
const targetUrl = process.env.CANVAS_SMOKE_URL ?? "http://127.0.0.1:4173/canvas";
const profileDir = path.resolve(
  process.env.CANVAS_SMOKE_PROFILE ?? path.join(repoRoot, ".tmp/canvas-model-smoke-profile"),
);
const outputDir = path.resolve(
  process.env.CANVAS_SMOKE_OUTPUT ?? path.join(repoRoot, ".tmp/model-smoke-20260725"),
);
const reusePendingProposal = process.env.CANVAS_SMOKE_REUSE_PENDING_PROPOSAL === "YES";
const projectName =
  process.env.CANVAS_SMOKE_PROJECT ??
  `Agent-故事板-Grok-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const imageSpecs = [
  {
    marker: "STORYBOARD_A",
    modelId: "image2-4k-fast",
    option: /全能模型2\s*·\s*4K(?:GPT|$)/i,
    credits: "6",
  },
  {
    marker: "STORYBOARD_B",
    modelId: "nano-banana-pro",
    option: /香蕉.*Pro.*1K\/2K\/4K/i,
    credits: "6",
  },
  {
    marker: "STORYBOARD_C",
    modelId: "nano-banana-2",
    option: /香蕉.*2.*1K\/2K\/4K/i,
    credits: "6",
  },
];

const videoSpecs = [
  {
    marker: "MOTION_A",
    modelId: "grok-imagine-video",
    option: /^Grok Imagine Video(?!\s*1\.5)/i,
    credits: "3.4",
  },
  {
    marker: "MOTION_B",
    modelId: "grok-imagine-video-1.5",
    option: /^Grok Imagine Video\s*1\.5(?:\s|$)/i,
    credits: "3",
  },
];

// Prefer stable English model names embedded in the catalog descriptions;
// localized labels can vary between deployments.
imageSpecs[0].option = /GPT Image 2.*4K/i;
imageSpecs[1].option = /Nano Banana Pro.*4K/i;
imageSpecs[2].option = /Nano Banana 2.*4K/i;

function report(event, details = {}) {
  process.stdout.write(`${JSON.stringify({ event, ...details })}\n`);
}

async function sessionState(page) {
  return page.evaluate(async () => {
    const response = await fetch("/api/v1/auth/session", { credentials: "include" });
    const payload = await response.json().catch(() => null);
    return { status: response.status, authenticated: Boolean(payload?.data?.user) };
  });
}

async function createDedicatedProject(page) {
  const menu = page.getByLabel("项目菜单");
  await menu.waitFor({ state: "visible", timeout: 30_000 });
  await menu.click();
  const sidebar = page.getByLabel("项目库");
  await sidebar.getByLabel("新建项目").click();
  await page.getByLabel("项目名称").fill(projectName);
  await page.getByLabel("项目名称").blur();
  await page.locator('[data-save-state="saved"]').waitFor({ timeout: 15_000 });
  report("project-ready", { projectName });
}

async function currentNodeIds(page) {
  return new Set(
    await page
      .locator(".react-flow__node-weftcanvas")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-id")).filter(Boolean)),
  );
}

async function runAgentProposal(page, initialNodeIds) {
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await drawer.waitFor({ state: "visible" });
  const mode = drawer.getByLabel("创作协作模式", { exact: true });
  await mode.waitFor({ state: "visible", timeout: 30_000 });
  if ((await mode.locator(".wc-canvas-select-label").textContent())?.trim() !== "自由协作") {
    await mode.click();
    await page
      .getByRole("listbox", { name: "创作协作模式" })
      .getByRole("option", { name: "自由协作", exact: true })
      .click();
  }

  const prompt = [
    "请以自由协作模式先判断当前画布进程和最小缺口，并调用你的专业电影分镜知识。",
    "我明确授权你提出一个可逆 proposal：新增 3 个图片节点和 2 个视频节点，不触发生成。",
    "三张图必须保持同一位 50 岁中国维修工、同一座深夜老旧写字楼维修电梯、写实电影感、16:9、无文字无水印，但分别是环境建立镜头、人物中近景和门缝细节镜头。",
    "图片节点正文必须分别以 STORYBOARD_A、STORYBOARD_B、STORYBOARD_C 开头，随后写可直接用于生图的完整专业提示词。",
    "两个视频节点正文必须分别以 MOTION_A、MOTION_B 开头，写与前两张故事板衔接的镜头运动提示词。",
    "请连接 STORYBOARD_A 到 MOTION_A，并连接 STORYBOARD_B 到 MOTION_B。",
    "使用 clientId storyboard_a、storyboard_b、storyboard_c、motion_a、motion_b；不要修改或删除现有节点。",
  ].join("\n");
  const composer = drawer.getByRole("textbox", { name: "发送给 Agent" });
  await composer.fill(prompt);
  await drawer.getByRole("button", { name: "发送给 Agent" }).click();

  // The production bundle can expose the proposal's translated aria-label with
  // a different normalization than Playwright's role query. The class is the
  // stable component contract and keeps this smoke test focused on behavior.
  const proposal = drawer.locator(".wc-agent-proposal");
  try {
    await proposal.waitFor({ state: "visible", timeout: 180_000 });
  } catch (error) {
    report("agent-failed", { text: (await drawer.innerText()).slice(-2_000) });
    throw error;
  }
  report("agent-proposal", { text: (await proposal.innerText()).slice(0, 2_000) });
  await proposal.getByRole("button", { name: "确认" }).click();
  await drawer
    .getByText(/已应用\s+\d+\s+项操作/)
    .last()
    .waitFor({ state: "visible", timeout: 30_000 });

  const created = page.locator(".react-flow__node-weftcanvas").filter({
    has: page.locator(".wc-node-wrap"),
  });
  await page.waitForFunction(
    ({ initial, expected }) =>
      [...document.querySelectorAll(".react-flow__node-weftcanvas")].filter(
        (node) => !initial.includes(node.getAttribute("data-id") ?? ""),
      ).length >= expected,
    { initial: [...initialNodeIds], expected: imageSpecs.length + videoSpecs.length },
    { timeout: 30_000 },
  );
  await page.locator('[data-save-state="saved"]').waitFor({ timeout: 15_000 });
  report("agent-applied", { createdNodeCount: (await created.count()) - initialNodeIds.size });
}

async function confirmPendingProposal(page, initialNodeIds) {
  await page.getByLabel("打开画布 Agent").click();
  const drawer = page.getByRole("dialog", { name: "画布 Agent" });
  await drawer.waitFor({ state: "visible" });
  const proposal = drawer.locator(".wc-agent-proposal");
  if (!(await proposal.count())) {
    report("agent-proposal-already-resolved");
    await drawer
      .getByRole("button", { name: "关闭" })
      .click()
      .catch(() => undefined);
    return;
  }
  await proposal.waitFor({ state: "visible", timeout: 60_000 });
  report("agent-proposal-reused", { text: (await proposal.innerText()).slice(0, 2_000) });
  await proposal.locator("button.is-primary").click();
  await drawer.locator(".wc-agent-receipt").waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(
    ({ initial, expected }) =>
      [...document.querySelectorAll(".react-flow__node-weftcanvas")].filter(
        (node) => !initial.includes(node.getAttribute("data-id") ?? ""),
      ).length >= expected,
    { initial: [...initialNodeIds], expected: imageSpecs.length + videoSpecs.length },
    { timeout: 60_000 },
  );
  await page.locator('[data-save-state="saved"]').waitFor({ timeout: 30_000 });
  report("agent-applied", {
    createdNodeCount: (await currentNodeIds(page)).size - initialNodeIds.size,
  });
}

async function newNodesByKind(page, initialNodeIds, kind) {
  const nodes = page.locator(
    `.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="${kind}"])`,
  );
  const result = [];
  for (let index = 0; index < (await nodes.count()); index += 1) {
    const node = nodes.nth(index);
    const id = await node.getAttribute("data-id");
    if (id && (!initialNodeIds.has(id) || initialNodeIds.size === 0))
      result.push({ id, node: page.locator(`.react-flow__node-weftcanvas[data-id="${id}"]`) });
  }
  return result;
}

async function orderNodesByMarker(page, nodes, specs) {
  const bodies = await page.evaluate(() => {
    const projectId = window.localStorage.getItem("weftcanvas:active-project:v1");
    const raw = projectId
      ? window.localStorage.getItem(`weftcanvas:project-data:v1:${projectId}`)
      : null;
    const project = raw ? JSON.parse(raw) : null;
    return Object.fromEntries(
      (project?.nodes ?? []).map((node) => [node.id, node.data?.body ?? ""]),
    );
  });
  const remaining = [...nodes];
  const ordered = [];
  for (const spec of specs) {
    const index = findNodeIndex(remaining, bodies, spec.marker);
    if (index < 0) throw new Error(`Agent did not create a node containing ${spec.marker}`);
    ordered.push(remaining.splice(index, 1)[0]);
  }
  return ordered;
}

function findNodeIndex(nodes, bodies, marker) {
  for (let index = 0; index < nodes.length; index += 1) {
    if (String(bodies[nodes[index].id] ?? "").includes(marker)) return index;
  }
  return -1;
}

async function openNodePanel(page, node, modality) {
  await node.locator(".wc-node-drag-strip").evaluate((element) => element.click());
  const nodeId = await node.getAttribute("data-id");
  await page.waitForFunction(
    (id) => document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.contains("selected"),
    nodeId,
  );
  const panel = page.getByLabel(modality === "image" ? "图片节点创作设置" : "视频节点创作设置");
  await panel.locator("[data-generation-model-select]").waitFor({ state: "attached" });
  return panel;
}

async function selectModel(page, panel, matcher) {
  await panel.getByRole("button", { name: "模型", exact: true }).click();
  const listbox = page.getByRole("listbox", { name: "模型", exact: true });
  const option = listbox.getByRole("option", { name: matcher }).first();
  if (!(await option.count())) {
    report("model-options", {
      choices: (await listbox.getByRole("option").allTextContents()).map((value) => value.trim()),
    });
    throw new Error(`Canvas model option was not found: ${matcher}`);
  }
  await option.click();
}

async function selectOption(page, panel, labels, matcher) {
  for (const label of labels) {
    const trigger = panel.getByRole("button", { name: label, exact: true });
    if (!(await trigger.count())) continue;
    await trigger.click();
    await page
      .getByRole("listbox", { name: label, exact: true })
      .getByRole("option", { name: matcher })
      .click();
    return true;
  }
  return false;
}

async function configureImage(page, entry, spec) {
  const panel = await openNodePanel(page, entry.node, "image");
  await selectModel(page, panel, spec.option);
  const selected = await panel.locator("[data-generation-model-select]").inputValue();
  if (selected !== spec.modelId) throw new Error(`Expected ${spec.modelId}, selected ${selected}`);
  await selectOption(page, panel, ["画面比例", "尺寸"], /16:9/);
  await selectOption(page, panel, ["分辨率", "质量"], /^4K$/i);
  const parameters = (
    await panel.locator(".wc-generation-parameter-control").allTextContents()
  ).map((value) => value.trim());
  const quote = (await panel.locator(".wc-generation-compact-credit").textContent())?.trim() ?? "";
  if (!quote.includes(spec.credits))
    throw new Error(`Unexpected quote for ${spec.modelId}: ${quote}`);
  if (spec.modelId !== "image2-4k-fast" && !parameters.join(" ").toUpperCase().includes("4K")) {
    throw new Error(`${spec.modelId} is not configured for 4K`);
  }
  report("image-configured", { nodeId: entry.id, modelId: spec.modelId, parameters, quote });
}

async function configureVideo(page, entry, spec) {
  const panel = await openNodePanel(page, entry.node, "video");
  await selectModel(page, panel, spec.option);
  const selected = await panel.locator("[data-generation-model-select]").inputValue();
  if (selected !== spec.modelId) throw new Error(`Expected ${spec.modelId}, selected ${selected}`);
  await selectOption(page, panel, ["时长", "时长（秒）"], /^1(?:\s*秒)?$/);
  await selectOption(page, panel, ["分辨率"], /^480P$/i);
  await selectOption(page, panel, ["画面比例"], /^16:9$/);
  const parameters = (
    await panel.locator(".wc-generation-parameter-control").allTextContents()
  ).map((value) => value.trim());
  const quoteControl = panel.locator(".wc-generation-compact-credit");
  if (!(await quoteControl.count())) {
    const panelText = await panel.innerText();
    if (spec.modelId === "grok-imagine-video-1.5" && /参考图片至少需要\s*1\s*个/.test(panelText)) {
      report("video-configured-awaiting-reference", {
        nodeId: entry.id,
        modelId: spec.modelId,
        parameters,
      });
      return;
    }
    await quoteControl.waitFor({ state: "attached", timeout: 60_000 }).catch(() => undefined);
  }
  if (!(await quoteControl.count())) {
    const panelText = await panel.innerText();
    if (spec.modelId === "grok-imagine-video-1.5" && /参考图片至少需要\s*1\s*个/.test(panelText)) {
      report("video-configured-awaiting-reference", {
        nodeId: entry.id,
        modelId: spec.modelId,
        parameters,
      });
      return;
    }
    throw new Error(`Quote was unavailable for ${spec.modelId}: ${panelText}`);
  }
  const quote = (await quoteControl.textContent())?.trim() ?? "";
  if (!quote.includes(spec.credits))
    throw new Error(`Unexpected quote for ${spec.modelId}: ${quote}`);
  report("video-configured", { nodeId: entry.id, modelId: spec.modelId, parameters, quote });
}

async function assertConnection(page, source, target) {
  const edge = page.locator(
    `.react-flow__edge[aria-label="Edge from ${source.id} to ${target.id}"]`,
  );
  if (!(await edge.count())) throw new Error(`Agent did not connect ${source.id} to ${target.id}`);
}

async function main() {
  await fs.mkdir(outputDir, { recursive: true });
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromium.executablePath(),
    headless: true,
    viewport: { width: 1_600, height: 1_000 },
    locale: "zh-CN",
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.setDefaultTimeout(20_000);
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.locator(".react-flow").waitFor();
    const session = await sessionState(page);
    report("session", session);
    if (!session.authenticated)
      throw new Error("Canvas smoke profile must be logged in before the Agent flow");

    if (!reusePendingProposal) await createDedicatedProject(page);
    const allNodeIds = await currentNodeIds(page);
    const markerIds = reusePendingProposal
      ? new Set(
          await page.evaluate(
            (markers) => {
              const projectId = window.localStorage.getItem("weftcanvas:active-project:v1");
              const raw = projectId
                ? window.localStorage.getItem(`weftcanvas:project-data:v1:${projectId}`)
                : null;
              const project = raw ? JSON.parse(raw) : null;
              return (project?.nodes ?? [])
                .filter((node) =>
                  markers.some((marker) => String(node.data?.body ?? "").includes(marker)),
                )
                .map((node) => node.id);
            },
            [...imageSpecs, ...videoSpecs].map((spec) => spec.marker),
          ),
        )
      : new Set();
    const initialNodeIds = reusePendingProposal
      ? new Set([...allNodeIds].filter((id) => !markerIds.has(id)))
      : allNodeIds;
    if (reusePendingProposal) {
      const markerCount = await page
        .locator(
          '.react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="image"]), .react-flow__node-weftcanvas:has(.wc-node-wrap[data-node-kind="video"])',
        )
        .count();
      if (markerCount < imageSpecs.length + videoSpecs.length)
        await confirmPendingProposal(page, initialNodeIds);
    } else await runAgentProposal(page, initialNodeIds);
    const createdImages = reusePendingProposal
      ? (await newNodesByKind(page, new Set(), "image")).filter((entry) => markerIds.has(entry.id))
      : await newNodesByKind(page, initialNodeIds, "image");
    const createdVideos = reusePendingProposal
      ? (await newNodesByKind(page, new Set(), "video")).filter((entry) => markerIds.has(entry.id))
      : await newNodesByKind(page, initialNodeIds, "video");
    if (createdImages.length !== imageSpecs.length || createdVideos.length !== videoSpecs.length) {
      throw new Error(
        `Agent created ${createdImages.length} image and ${createdVideos.length} video nodes`,
      );
    }
    const images = await orderNodesByMarker(page, createdImages, imageSpecs);
    const videos = await orderNodesByMarker(page, createdVideos, videoSpecs);
    await assertConnection(page, images[0], videos[0]);
    await assertConnection(page, images[1], videos[1]);

    for (let index = 0; index < imageSpecs.length; index += 1) {
      await configureImage(page, images[index], imageSpecs[index]);
    }
    for (let index = 0; index < videoSpecs.length; index += 1) {
      await configureVideo(page, videos[index], videoSpecs[index]);
    }
    await page.locator('[data-save-state="saved"]').waitFor({ timeout: 15_000 });
    const staged = {
      projectName,
      images: images.map((entry, index) => ({ nodeId: entry.id, ...imageSpecs[index] })),
      videos: videos.map((entry, index) => ({ nodeId: entry.id, ...videoSpecs[index] })),
    };
    await fs.writeFile(
      path.join(outputDir, "agent-stage.json"),
      `${JSON.stringify(staged, null, 2)}\n`,
      "utf8",
    );
    report("agent-stage-complete", staged);
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  report("failed", { message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
