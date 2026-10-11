# plugins/

画布的官方插件目录（docs/PLUGIN-ROADMAP.md §6）。每个插件是独立的 workspace 包，
经 `@kachang/plugin-sdk` 的 `definePlugin` 声明，宿主（apps/web 的
`lib/plugin-host.ts`）懒加载为独立 chunk，不进主 bundle。

## split-list（批量拆单）

把多行文本拆成一串相连的文本节点。选中「批量拆单」节点后在创作框输入多行文本，
卡面预览出清单，点「拆分为节点」经宿主 ops（与 Agent 命令同一套校验与执行路径）
生成一串相连的文本节点。

## 写一个插件

最小骨架（`plugins/my-plugin/src/index.ts`）：

```ts
import { definePlugin } from "@kachang/plugin-sdk";

export default definePlugin({
  id: "my-plugin",        // [a-z][a-z0-9-]*
  version: "0.1.0",
  setup(ctx) {
    ctx.nodes.registerNode({
      name: "board",      // 完整节点类型 = plugin:my-plugin:board
      label: () => "我的节点",
      createDraft: () => ({ width: 308, height: 190 }),
      renderBody: MyBody, // 可选；宿主包 ErrorBoundary，抛错不击穿画布
    });
    ctx.onDispose(() => { /* 对称清理 */ });
  },
});
```

然后在 `apps/web/src/lib/official-plugins.ts` 的 `officialPluginLoaders` 加一条
loader，并在本包 `package.json` 声明依赖。本地开发可用 `VITE_PLUGIN_DEV=1` 打开
调试钩子（`window.__kachangPluginHost`）。

插件 API 面上**没有任何模型密钥**：`ctx.ai.*` 由宿主走既有 BYOK 通道代发；
`ctx.storage` 按插件名隔离；`ctx.ops` 与 Agent 命令同一套 schema 校验。
不做 URL 远程加载，不做 eval。
