import { configDefaults, defineConfig } from "vitest/config";

// CLI tests use node:test and run separately through test:scripts.
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "scripts/**"],
    // 目录策展用例跑在"放开完整目录"的开关下：它们钉的是归一化/计价/路由规则，
    // 用中性 fixture id，不该被站点当前"一个模型都不上架"的口径吃掉。白名单规则本身
    // 由 catalog.test.ts 的「模型目录白名单」用例单独钉住。
    env: { WEFTCANVAS_SHOW_ALL_MODELS: "1" },
  },
});
