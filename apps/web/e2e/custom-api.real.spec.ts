import { expect, test } from "@playwright/test";

const apiKey = process.env.CANVAS_REAL_API_KEY;

test("real browser-owned API completes one canvas text creation", async ({ page }) => {
  test.skip(true, "文本节点模型生成已迁移到 Agent，画布文本节点只保留编辑器");
  test.skip(!apiKey, "CANVAS_REAL_API_KEY is required for the opt-in paid smoke test");
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
  await page.addInitScript(({ key }) => {
    localStorage.clear();
    localStorage.setItem("kachang-canvas:custom-api:v1", JSON.stringify({
      baseUrl: "https://newapi.prompt-hubs.com",
      apiKey: key,
    }));
  }, { key: apiKey! });

  await page.goto("/canvas");
  const textNode = page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])');
  await textNode.locator(".kc-node-drag-strip").click();
  const panel = page.getByLabel("文本节点创作设置");
  const model = panel.getByLabel("模型");
  await expect(model.locator('option[value="glm-5.1"]')).toHaveCount(1, { timeout: 20_000 });
  await model.selectOption("glm-5.1");
  const prompt = "连接测试：请只回复“卡藏画布已接通”，不要复述问题。";
  await page.getByLabel("文本节点提示词").fill(prompt);
  const maxTokens = panel.getByLabel("最大输出 Token");
  if (await maxTokens.count()) await maxTokens.fill("32");
  await panel.getByRole("button", { name: "生成", exact: true }).click();

  await expect(textNode.locator(".kc-node-loading")).toHaveCount(0, { timeout: 120_000 });
  await expect(textNode.locator(".kc-node-text-preview")).toContainText("卡藏画布已接通");
  await expect(textNode.locator(".kc-node-text-preview")).not.toHaveText(prompt);
});
