/**
 * 上游（模型目录 / 计价 / 提交）连接配置的**中立**环境变量层。
 *
 * 这些键名历史上带着自家中转站的品牌：`PROMPT_HUB_*`（托管链路）、`WEFTCANVAS_*`
 * （目录与计价）、`VITE_CARD_LIBRARY_*`（早期前端遗留）。第三方中转站或自托管
 * 用户接进来时，不该被迫使用别人家的品牌名去配置自己的上游，所以统一到
 * `CANVAS_UPSTREAM_*`：
 *
 *   新名（CANVAS_UPSTREAM_*）优先 → 旧名继续生效（线上环境不受影响）→ 最后才是内置默认值。
 *
 * 这样"换一个上游"只是改几个环境变量，不需要改代码、也不需要在别人的品牌名里
 * 猜哪个键对应哪个用途。
 */
type EnvRecord = Record<string, string | undefined>;

/**
 * 每一项按优先级排列的候选键名。新增中立名时把它排在数组最前，旧名保留在后面，
 * 保证既有部署（含生产）继续工作。
 */
export const UPSTREAM_ENV_NAMES = {
  catalogSourceUrl: ["CANVAS_UPSTREAM_CATALOG_URL", "CATALOG_SOURCE_URL", "WEFTCANVAS_CATALOG_URL"],
  pricingUrl: ["CANVAS_UPSTREAM_PRICING_URL", "WEFTCANVAS_PRICING_URL"],
  videoInventoryUrl: ["CANVAS_UPSTREAM_VIDEO_INVENTORY_URL", "VIDEO_INVENTORY_URL"],
  apiBaseUrl: [
    "CANVAS_UPSTREAM_API_BASE_URL",
    "PROMPT_HUB_API_BASE_URL",
    "VITE_CARD_LIBRARY_API_BASE_URL",
  ],
  authBaseUrl: [
    "CANVAS_UPSTREAM_AUTH_BASE_URL",
    "PROMPT_HUB_AUTH_BASE_URL",
    "VITE_CARD_LIBRARY_SUPABASE_URL",
  ],
  siteUrl: ["CANVAS_UPSTREAM_SITE_URL", "PROMPT_HUB_SITE_URL", "VITE_CARD_LIBRARY_SITE_URL"],
  anonKey: ["CANVAS_UPSTREAM_ANON_KEY", "PROMPT_HUB_ANON_KEY", "VITE_CARD_LIBRARY_ANON_KEY"],
  requestTimeoutMs: ["CANVAS_UPSTREAM_REQUEST_TIMEOUT_MS", "PROMPT_HUB_REQUEST_TIMEOUT_MS"],
  submissionTimeoutMs: [
    "CANVAS_UPSTREAM_SUBMISSION_TIMEOUT_MS",
    "PROMPT_HUB_SUBMISSION_TIMEOUT_MS",
  ],
  generationStorePath: [
    "CANVAS_UPSTREAM_GENERATION_STORE_PATH",
    "PROMPT_HUB_GENERATION_STORE_PATH",
  ],
  referenceStorePath: ["CANVAS_UPSTREAM_REFERENCE_STORE_PATH", "PROMPT_HUB_REFERENCE_STORE_PATH"],
} as const satisfies Record<string, readonly string[]>;

/** 按声明顺序返回第一个非空值。 */
export function readUpstreamValue(
  env: EnvRecord,
  key: keyof typeof UPSTREAM_ENV_NAMES,
): string | undefined {
  for (const name of UPSTREAM_ENV_NAMES[key]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** 一次性读出全部上游连接配置（未配置的项为 undefined，由调用方决定默认值）。 */
export function readUpstreamEnv(env: EnvRecord) {
  const read = (key: keyof typeof UPSTREAM_ENV_NAMES) => readUpstreamValue(env, key);
  return {
    catalogSourceUrl: read("catalogSourceUrl"),
    pricingUrl: read("pricingUrl"),
    videoInventoryUrl: read("videoInventoryUrl"),
    apiBaseUrl: read("apiBaseUrl"),
    authBaseUrl: read("authBaseUrl"),
    siteUrl: read("siteUrl"),
    anonKey: read("anonKey"),
    requestTimeoutMs: read("requestTimeoutMs"),
    submissionTimeoutMs: read("submissionTimeoutMs"),
    generationStorePath: read("generationStorePath"),
    referenceStorePath: read("referenceStorePath"),
  };
}
