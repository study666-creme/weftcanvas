import { ListChecks } from "lucide-react";
import { definePlugin } from "@weftcanvas/plugin-sdk";

import { SplitListBody } from "./body";
import "./split-list.css";

/**
 * 批量拆单（官方示例插件，docs/PLUGIN-ROADMAP.md §6）：
 * 一个「批量拆单」节点把多行文本预览成清单；点「拆分为节点」经宿主 ops
 * 生成一串相连的文本节点。演示注册表扩展点 + ops 原语 + 对称卸载，
 * 不触碰任何模型密钥。
 */
export default definePlugin({
  id: "split-list",
  version: "0.1.0",
  description: "把多行文本拆成一串相连的文本节点（官方示例插件）",
  setup(ctx) {
    // 演示存储命名空间与对称卸载：宿主按插件隔离 kv（其它插件读不到这块前缀）；
    // init 写标记，onDispose 对称清掉。
    const kv = ctx.storage("usage");
    kv.set("loaded", "1");
    ctx.onDispose(() => {
      kv.remove("loaded");
    });

    ctx.nodes.registerNode({
      name: "board",
      label: () => "批量拆单",
      icon: ListChecks,
      accent: "jade",
      creatable: true,
      createDraft: () => ({ width: 308, height: 190 }),
      renderBody: SplitListBody,
    });
  },
});
