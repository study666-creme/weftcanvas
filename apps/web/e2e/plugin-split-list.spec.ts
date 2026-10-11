import { expect, test, type Page } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/v1/auth/session", (route) => route.fulfill({ json: { ok: true, data: null } }));
});

async function cleanBrowser(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem("kachang-plugin-e2e-cleaned")) return;
    localStorage.clear();
    sessionStorage.setItem("kachang-plugin-e2e-cleaned", "1");
  });
}

const SPLIT_NODE = '.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="plugin:split-list:board"])';

test("official split-list plugin installs, creates, renders, splits, and uninstalls", async ({ page }) => {
  test.setTimeout(60_000);
  await cleanBrowser(page);
  await page.goto("/canvas");

  const creation = page.getByRole("navigation", { name: "创建工具" });
  const pluginEntry = creation.getByRole("menuitem", { name: "添加批量拆单" });

  // 官方插件随包懒加载：装好后创建菜单出现新节点类型（弹层 hover 展开）。
  await creation.locator(".kc-create-rail-plus-wrapper").hover();
  await expect(pluginEntry).toBeVisible({ timeout: 15_000 });

  await pluginEntry.click();
  const node = page.locator(SPLIT_NODE);
  await expect(node).toHaveCount(1);
  await expect(node.locator(".kc-node-type-label")).toContainText("批量拆单");
  // 插件节点体由宿主 ErrorBoundary 包裹渲染：空态提示可见。
  await expect(node.locator(".kc-plugin-split-list-empty")).toBeVisible();

  // 选中节点 → 创作框输入多行文本（与文本节点同一条 body 通道）。
  await node.click();
  const editor = page.getByRole("textbox", { name: "批量拆单提示词" });
  await expect(editor).toBeVisible();
  await editor.click();
  // 多行经剪贴板粘贴进入（与真实用户粘贴同一条 insertPromptText 通道）。
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("去买咖啡\n取快递\n回邮件"));
  await editor.press("Control+V");

  // 插件体预览出三行清单。
  await expect(node.locator(".kc-plugin-split-list-rows li")).toHaveCount(3);

  // 拆分：经宿主 ops 生成三个相连的文本节点（与 Agent 命令同一套原语）。
  await node.locator(".kc-plugin-split-list-action").click();
  await expect(page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])')).toHaveCount(3);
  await expect(page.locator(".react-flow__edge")).toHaveCount(2);

  // 卸载：创建菜单条目消失，已存在节点仍渲染（卸载必须可逆且不破坏画布）。
  await page.evaluate(() => {
    const host = (window as unknown as { __kachangPluginHost?: { uninstall(id: string): void } }).__kachangPluginHost;
    if (!host) throw new Error("插件宿主调试钩子不存在");
    host.uninstall("split-list");
  });
  await expect(pluginEntry).toHaveCount(0);
  await expect(node).toBeVisible();
});

test("plugin body errors are contained by the host boundary", async ({ page }) => {
  test.setTimeout(60_000);
  await cleanBrowser(page);
  await page.goto("/canvas");

  const creation = page.getByRole("navigation", { name: "创建工具" });
  const pluginEntry = creation.getByRole("menuitem", { name: "添加批量拆单" });
  await creation.locator(".kc-create-rail-plus-wrapper").hover();
  await expect(pluginEntry).toBeVisible({ timeout: 15_000 });
  await pluginEntry.click();
  const node = page.locator(SPLIT_NODE);
  await expect(node).toHaveCount(1);

  await node.click();
  const editor = page.getByRole("textbox", { name: "批量拆单提示词" });
  await editor.click();
  await page.keyboard.type("触发插件错误");

  // 插件抛错只影响这一张卡面；画布仍可正常创建节点（重新展开创建弹层）。
  await expect(page.locator(".kc-plugin-body-error")).toBeVisible();
  await creation.locator(".kc-create-rail-plus-wrapper").hover();
  await creation.getByRole("menuitem", { name: "添加文本节点" }).click();
  await expect(page.locator('.react-flow__node-kachang:has(.kc-node-wrap[data-node-kind="text"])')).toHaveCount(1);
});
