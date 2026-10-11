import type { SignedMediaAccess } from "../media/signed-access.js";
import type { MediaService } from "../media/service.js";
import type { GenerationQuoteService } from "../catalog/quote.js";
import type { CatalogCompatibilityOverlay } from "../catalog/normalize.js";
import type { IdentityProvider } from "../identity/provider.js";
import type { GenerationJobService } from "../generation/service.js";
import type { WalletProvider } from "../wallet/provider.js";
import type { GenerationProvider, HostedAccountProvider } from "./types.js";

/**
 * Provider 装配（docs/PLUGIN-ROADMAP.md §5 P2）。
 *
 * `CANVAS_API_PROVIDER` 声明用哪套 provider：
 * - `dev-test`（默认，零外部依赖）：原生 PostgreSQL 身份 + durable 生成任务，
 *   目录/定价端点全部从环境变量读取、没有默认值；
 * - `kachang`：托管商业实现（私有 overlay 模块 spi/kachang.ts，公开树不含）；
 * - `auto`：按配置自动落一边（托管凭据存在 → kachang，否则 dev-test）。
 *
 * 未知 provider 名直接拒绝启动；点名 kachang 而当前构建不含私有 overlay 时
 * 给出明确错误，绝不静默降级。
 */
export type CanvasApiProviderName = "dev-test" | "kachang" | "auto";
export type ResolvedCanvasApiProviderName = Exclude<CanvasApiProviderName, "auto">;

export function readCanvasApiProviderName(value: string | undefined): CanvasApiProviderName {
  const normalized = value?.trim() || "auto";
  if (normalized === "auto" || normalized === "dev-test" || normalized === "kachang") return normalized;
  throw new Error("CANVAS_API_PROVIDER must be auto, dev-test, or kachang");
}

/** kachang 私有模块的公开形状（公开树只知道签名，不知道实现）。 */
export type KachangProviderModule = {
  resolveKachangEndpoints(env: Record<string, string | undefined>): {
    catalogSourceUrl: string;
    catalogVideoInventoryUrl: string | undefined;
    stationPricingUrl: string;
  };
  /** 站点策展兼容层（计价/品牌化规则只在私有侧）。 */
  createCatalogOverlay(env: Record<string, string | undefined>): CatalogCompatibilityOverlay;
  assembleKachangProviders(inputs: ProviderServiceInputs): Promise<ResolvedProviderServices>;
};

/**
 * 装配第一阶段：解析 provider 名、端点计划，并在点名 kachang 时加载私有
 * 模块（端点随模块提供，因为目录/报价必须先于服务装配建立）。
 */
export type ProviderPlan = {
  providerName: ResolvedCanvasApiProviderName;
  catalogSourceUrl: string | undefined;
  catalogVideoInventoryUrl: string | undefined;
  stationPricingUrl: string | undefined;
  /** dev-test 下为 null。 */
  kachang: KachangProviderModule | null;
};

/**
 * kachang 私有模块的加载器。specifier 用计算字符串，公开树的类型检查不依赖
 * 该文件存在；运行时缺失则给出明确错误（绝不静默降级）。
 */
const KACHANG_MODULE_SPECIFIER = "./kachang.js";

async function loadKachangAssembly(): Promise<KachangProviderModule> {
  try {
    return await import(KACHANG_MODULE_SPECIFIER);
  } catch (error) {
    throw new Error(
      "CANVAS_API_PROVIDER=kachang 需要私有 overlay 模块 apps/api/src/spi/kachang.ts（当前构建不包含它）",
      { cause: error },
    );
  }
}

export async function resolveProviderPlan(env: {
  CANVAS_API_PROVIDER?: string;
  /** 旧变量名，向后兼容：native → dev-test，prompt-hub → kachang。 */
  IDENTITY_PROVIDER?: string;
  PROMPT_HUB_ANON_KEY?: string;
  VITE_CARD_LIBRARY_ANON_KEY?: string;
  NODE_ENV?: string;
  CATALOG_SOURCE_URL?: string;
  VIDEO_INVENTORY_URL?: string;
  KACHANG_PRICING_URL?: string;
}): Promise<ProviderPlan> {
  const requestedRaw = env.CANVAS_API_PROVIDER?.trim() || env.IDENTITY_PROVIDER?.trim();
  const requested = requestedRaw === "native"
    ? "dev-test"
    : requestedRaw === "prompt-hub"
      ? "kachang"
      : readCanvasApiProviderName(requestedRaw);
  const hostedConfigured = Boolean((env.PROMPT_HUB_ANON_KEY ?? env.VITE_CARD_LIBRARY_ANON_KEY)?.trim());
  if (requested === "auto" && env.NODE_ENV === "production" && !hostedConfigured) {
    // 生产环境必须显式表态：要么配置托管凭据（kachang），要么明确 dev-test。
    throw new Error("Production requires PROMPT_HUB_ANON_KEY or an explicit CANVAS_API_PROVIDER=dev-test");
  }
  const providerName: ResolvedCanvasApiProviderName = requested === "auto"
    ? (hostedConfigured ? "kachang" : "dev-test")
    : requested;
  if (providerName === "dev-test") {
    return {
      providerName,
      // dev-test 只认显式配置的自托管端点（OpenAI-compatible 网关等），没有默认值。
      catalogSourceUrl: env.CATALOG_SOURCE_URL?.trim() || undefined,
      catalogVideoInventoryUrl: env.VIDEO_INVENTORY_URL?.trim() || undefined,
      stationPricingUrl: env.KACHANG_PRICING_URL?.trim() || undefined,
      kachang: null,
    };
  }
  const kachang = await loadKachangAssembly();
  const endpoints = kachang.resolveKachangEndpoints(env);
  return { providerName, ...endpoints, kachang };
}

/** 装配第二阶段的输入：server.ts 已建好的共享服务。 */
export type ProviderServiceInputs = {
  env: Record<string, string | undefined>;
  sessionSecret: string;
  sessionTtlMs: number;
  quotes: GenerationQuoteService;
  media: MediaService | undefined;
  signedMedia: SignedMediaAccess | undefined;
  /** dev-test 身份（Postgres 缺失时为 undefined，app 以"账号服务不可用"暴露）。 */
  nativeIdentity: IdentityProvider | undefined;
  /** dev-test 生成（durable 任务；pool/media 缺失时为 undefined）。 */
  nativeGeneration: GenerationJobService | undefined;
};

export type ResolvedProviderServices = {
  providerName: ResolvedCanvasApiProviderName;
  identity: IdentityProvider | undefined;
  account: (HostedAccountProvider & WalletProvider) | undefined;
  hostedGeneration: GenerationProvider | undefined;
};

export async function assembleProviderServices(
  plan: ProviderPlan,
  inputs: ProviderServiceInputs,
): Promise<ResolvedProviderServices> {
  if (plan.providerName === "dev-test" || !plan.kachang) {
    return {
      providerName: "dev-test",
      identity: inputs.nativeIdentity,
      account: undefined,
      hostedGeneration: inputs.nativeGeneration,
    };
  }
  return plan.kachang.assembleKachangProviders(inputs);
}
