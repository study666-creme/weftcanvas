#!/usr/bin/env node
/**
 * Read-only catalog validation using the same normalizer as the Canvas API.
 * Install dependencies and build contracts before running this source CLI.
 * Exit codes: 0 = selectable catalog, 1 = validation/fetch failure, 2 = usage.
 * This checks metadata only; it never submits a paid generation request.
 */
import { pathToFileURL } from "node:url";
import { tsImport } from "tsx/esm/api";

const { normalizeSourceCatalog } = await tsImport("../src/catalog/normalize.ts", import.meta.url);

export function validateCatalog(value, now = Date.now()) {
  const snapshot = normalizeSourceCatalog(value, {
    validatedAt: now,
    maxQuoteAgeMs: 60_000,
    includeKnownModels: false,
  });
  return snapshot.catalog.models;
}

export async function main(argv = process.argv.slice(2), log = console.log) {
  const args = parseArgs(argv);
  if (args.help) {
    log(
      "Usage: node apps/api/scripts/upstream-conformance.mjs --catalog-url <url> [--api-base <url>] [--pricing-url <url>] [--video-inventory-url <url>]",
    );
    log("Optional credential: CANVAS_UPSTREAM_API_KEY environment variable or --api-key <key>.");
    return 0;
  }
  if (!args["catalog-url"] && !args["api-base"]) {
    log("至少给出 --catalog-url 或 --api-base；用 --help 查看用法。");
    return 2;
  }
  const key = args["api-key"] ?? process.env.CANVAS_UPSTREAM_API_KEY;
  const catalogUrl = args["catalog-url"] ?? joinUrl(args["api-base"], "/api/model-catalog");
  let blocking = false;
  try {
    const catalog = await getJson(catalogUrl, key);
    const models = validateCatalog(catalog);
    log(`目录校验通过：${models.length} 个模型满足画布的路由、参数、输出与报价契约。`);
    const rawCount = Array.isArray(catalog?.models) ? catalog.models.length : models.length;
    if (rawCount > models.length)
      log(`提示：${rawCount - models.length} 行未进入可选目录（下架、缺价格或不支持的路由等）。`);
  } catch (error) {
    log(`阻断：目录无法供画布使用。${diagnostic(error)}`);
    blocking = true;
  }
  // Auxiliary documents are checked for reachability only. Station-specific
  // pricing and availability formats are not certified by this probe.
  for (const [option, label] of [
    ["pricing-url", "计价文档"],
    ["video-inventory-url", "视频准入清单"],
  ]) {
    if (!args[option]) continue;
    try {
      await getJson(args[option], key);
      log(`${label}：可读取 JSON（未验证业务内容）。`);
    } catch (error) {
      log(`阻断：显式配置的${label}不可读取。${diagnostic(error)}`);
      blocking = true;
    }
  }
  if (args["api-base"]) {
    try {
      const value = await getJson(joinUrl(args["api-base"], "/v1/models"), key);
      log(
        `/v1/models：${Array.isArray(value?.data) ? value.data.length : 0} 个模型；该列表本身不证明协议或价格兼容。`,
      );
    } catch {
      log("提示：/v1/models 不可读取；发布合同目录的上游可不提供此接口。");
    }
  }
  log(
    blocking
      ? "结果：存在阻断项，修复后重新校验。"
      : "结果：目录结构可接入。仍需在浏览器验证 CORS、认证和实际模型执行。",
  );
  log("本探针仅发 GET，不生成图片或视频，不验证所有模型的实际可用性。");
  return blocking ? 1 : 0;
}

async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { Accept: "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function diagnostic(error) {
  // Report invalid field paths without echoing complete private payloads.
  if (Array.isArray(error?.issues))
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
  return error instanceof Error ? error.message : "校验失败";
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help") parsed.help = true;
    else if (token.startsWith("--") && argv[index + 1] && !argv[index + 1].startsWith("--"))
      parsed[token.slice(2)] = argv[++index];
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await main();
