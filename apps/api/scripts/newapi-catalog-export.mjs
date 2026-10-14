#!/usr/bin/env node
/**
 * Export a draft catalog from New API channel metadata and the token-visible
 * model list. Only GET requests are sent; credentials never enter the output.
 * Prices are copied only when explicitly supplied in the contract format.
 * Confirm prices and relay protocols before publishing the generated catalog.
 * Usage and authentication: docs/UPSTREAM-CONTRACT.md.
 * Exit codes: 0 = exported, 1 = no models, 2 = invalid usage.
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// 单页 100 条，最多翻 50 页，避免上游 total 字段异常时无限循环。
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
/** New API 管理端身份头名（仅当给出 --admin-user 时发送）。 */
const ADMIN_USER_HEADER = "New-Api-User";

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args["api-base"]) {
    say("至少给出 --api-base（你的中转站根地址）。用 --help 查看用法。");
    return 2;
  }

  const base = stripTrailingSlash(args["api-base"]);
  const notes = [];
  const warnings = [];

  banner("NewAPI → 合同目录导出（只读）");
  say(`  · 中转站：${base}`);
  if (args["admin-token"]) say("  · 管理端：已带 token（值不会回显）");
  else say("  · 管理端：未提供 --admin-token，渠道清单可能读不到");
  if (args["api-key"]) say("  · 模型列表：已带用户 token（值不会回显）");

  // —— 1. 渠道清单（管理员只读接口）——
  section("读取渠道清单 /api/channel/");
  const channels = await fetchChannels(base, args);
  if (!channels.ok) {
    warnings.push(`渠道清单不可读（${channels.error}）。`);
    say(`  ⚠️ 渠道清单不可读：${channels.error}`);
  } else {
    say(`  · 读到 ${channels.items.length} 个渠道`);
  }

  // —— 2. 用户可见模型列表（token 视图，fail-closed 的"真正能用"集合）——
  section("读取用户可见模型列表 /v1/models");
  const usable = await fetchUsableModelIds(base, args);
  if (!usable.ok) {
    warnings.push(`/v1/models 不可读（${usable.error}），已回退到渠道并集。`);
    say(`  ⚠️ /v1/models 不可读：${usable.error}`);
  } else {
    say(`  · token 可见 ${usable.ids.length} 个模型 id`);
  }

  // —— 3. 纯映射 ——
  const { models, stats } = mapChannelsToCatalog({
    channels: channels.ok ? channels.items : [],
    usableModelIds: usable.ok ? usable.ids : undefined,
  });

  if (!usable.ok && channels.ok) {
    warnings.push(
      "没有 token 视图，模型集合来自管理端渠道并集——它可能包含该 token 无权使用的模型，请以真实 token 视图为准。",
    );
  }

  banner("结果");
  say(`  · 产出模型：${stats.total} 个`);
  say(`  · 已带价格：${stats.priced} 个；待补价格：${stats.unpriced} 个`);
  const modalityLine = Object.entries(stats.byModality)
    .filter(([, count]) => count > 0)
    .map(([modality, count]) => `${modality} ${count}`)
    .join("，");
  if (modalityLine) say(`  · 模态分布（保守推断）：${modalityLine}`);

  for (const note of notes) say(`  · ${note}`);
  for (const warning of warnings) say(`  ⚠️ ${warning}`);

  if (stats.unpriced > 0) {
    // 大声、可操作：这是本脚本最重要的输出。
    say("");
    say("  ⛔ 这份目录里有模型没有 pricing，画布不会上架它们。");
    say("     本脚本不猜价格（钱不能推导），stock New API 也不提供每模型 CNY 价。");
    say("     请为每个模型补一个 pricing 对象（mode/unit/currency + 价格或 tiers），");
    say("     模板与字段说明见 docs/UPSTREAM-CONTRACT.md 的 JSON 示例。");
    say("     补齐后，用上游一致性探针验收：");
    say(`        node apps/api/scripts/upstream-conformance.mjs --catalog-url <你发布后的 URL>`);
  }

  const document = buildDocument(models);
  const json = `${JSON.stringify(document, null, 2)}\n`;

  if (args.out) {
    writeFileSync(args.out, json, "utf8");
    say(`\n  ✅ 已写入 ${args.out}（含 ${stats.total} 个模型）。`);
  } else {
    // JSON 走 stdout，人读信息全走 stderr，保证可管道给 jq 等工具。
    process.stdout.write(json);
  }

  if (stats.total === 0) {
    say("\n结果：什么都没产出——先确认 --api-base 正确、token 有权限。");
    return 1;
  }
  if (stats.unpriced > 0) {
    say("\n结果：目录已产出，但在补齐 pricing 之前 upstream-conformance.mjs 会判为阻断。");
  } else {
    say("\n结果：目录已产出且每个模型都带价。");
  }
  return 0;
}

// ---------------------------------------------------------------- 纯映射（可测）

/**
 * 把渠道清单 + token 可见模型集映射成合同目录条目。
 *
 * - **模型集合的权威来源是 `usableModelIds`**（`/v1/models` 的 token 视图：不可用的
 *   模型根本不会出现）。只有它不可读取时，才回退到渠道并集；成功读取的空集合仍为空。
 * - **模态保守推断**：只把官方 id 族里明确是图像/视频的挑出来，其余一律 `text`。
 *   宁可让运营手动改，也不猜错模态（与 `apps/web/src/lib/custom-model-knowledge.ts`
 *   的 id 族判据同源）。
 * - **结构字段由模态确定性地推导**：`endpoint`、`output.type` 与固定的 `model` 路由
 *   参数不是价格、也不猜业务，而是画布归一化（`normalizePrivateRoute` /
 *   `normalizeModel`）**实际要求**的执行字段；缺了它们画布会静默丢弃整行。
 *   路由按模态取白名单路径，绝不从上游自由路径读取。
 * - **价格只透传、不编造**：`pricingByModel[id]` 必须已是合同形状（见
 *   `extractContractPricing`），否则该模型不带 `pricing` 字段。
 * - 输出按 id 排序，便于 diff。
 *
 * @returns {{ models: Array<Record<string, unknown>>, stats: {
 *   total: number, priced: number, unpriced: number,
 *   byModality: Record<string, number>, channelOnly: number,
 * } }}
 */
export function mapChannelsToCatalog({ channels = [], usableModelIds, pricingByModel = {} } = {}) {
  const channelIds = collectChannelModelIds(channels);
  const mergedPricing = { ...collectPricingByModel(channels), ...pricingByModel };

  const usable = dedupeStrings(usableModelIds);
  const usableSet = new Set(usable);
  const ids = (Array.isArray(usableModelIds) ? usable : channelIds)
    .slice()
    .sort((a, b) => a.localeCompare(b));

  const stats = {
    total: 0,
    priced: 0,
    unpriced: 0,
    byModality: { text: 0, image: 0, video: 0, audio: 0 },
    channelOnly: 0,
  };

  const models = [];
  for (const id of ids) {
    const modality = inferModality(id);
    const pricing = extractContractPricing(mergedPricing[id]);
    const entry = {
      id,
      modality,
      operation: "generate",
      output: { type: OUTPUT_TYPE_BY_MODALITY[modality] },
      // 画布的私有路由要求一个固定到本 id 的 `model` 参数；它不是用户可见控件，
      // 归一化会把它从公开参数里滤掉（normalize.ts 里 name !== "model"）。
      parameters: [
        { name: "model", path: "model", type: "string", required: true, fixed: id, label: "模型" },
      ],
      endpoint: {
        method: "POST",
        path: ENDPOINT_BY_MODALITY[modality],
        content_type: "application/json",
      },
      public: { id, label: id, description: "" },
      selectable: true,
    };
    if (pricing) {
      entry.pricing = pricing;
      stats.priced += 1;
    } else {
      stats.unpriced += 1;
    }
    stats.total += 1;
    stats.byModality[modality] = (stats.byModality[modality] ?? 0) + 1;
    if (!usableSet.has(id)) stats.channelOnly += 1;
    models.push(entry);
  }

  return { models, stats };
}

/** 聚合渠道对象里的模型 id（`models` 是逗号分隔字符串或数组）。 */
export function collectChannelModelIds(channels) {
  const ids = [];
  for (const channel of Array.isArray(channels) ? channels : []) {
    if (!isRecord(channel)) continue;
    const raw = channel.models;
    if (typeof raw === "string") {
      for (const piece of raw.split(",")) {
        const id = piece.trim();
        if (id) ids.push(id);
      }
    } else if (Array.isArray(raw)) {
      for (const piece of raw) {
        if (typeof piece === "string" && piece.trim()) ids.push(piece.trim());
      }
    }
  }
  return dedupeStrings(ids);
}

/**
 * 保守模态推断：默认 `text`；只在官方 id 明确属于图像/视频族时改判。
 * 音频族刻意不在这里猜——留给运营手动改，避免把 TTS 之类误当可用出图模型。
 */
export function inferModality(modelId) {
  const id = typeof modelId === "string" ? modelId.trim() : "";
  if (!id) return "text";
  if (IMAGE_ID_PATTERNS.some((pattern) => pattern.test(id))) return "image";
  if (VIDEO_ID_PATTERNS.some((pattern) => pattern.test(id))) return "video";
  return "text";
}

/**
 * 校验并透传一个"已经是合同形状"的 pricing 对象（判据与
 * `upstream-conformance.mjs` 的 checkModelRow 一致）。任何不合规/缺失一律返回
 * `undefined`，绝不补默认值、绝不换算——价格是钱，这里只做摆渡。
 */
export function extractContractPricing(value) {
  if (!isRecord(value)) return undefined;
  if (!["fixed", "tiered", "token", "tiered_token"].includes(value.mode)) return undefined;
  if (!["request", "image", "second", "token"].includes(value.unit)) return undefined;
  if (value.currency !== "CNY") return undefined;
  return value;
}

/**
 * 少数 fork 会把合同形状的 `pricing` 直接挂在渠道对象上；存在时透传给该渠道的
 * 全部模型。stock New API 没有这个字段，所以普通情况下这里返回空对象。
 */
function collectPricingByModel(channels) {
  const map = {};
  for (const channel of Array.isArray(channels) ? channels : []) {
    if (!isRecord(channel)) continue;
    const pricing = extractContractPricing(channel.pricing);
    if (!pricing) continue;
    for (const id of channelModelIdsOf(channel)) map[id] = pricing;
  }
  return map;
}

function channelModelIdsOf(channel) {
  const raw = channel.models;
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((piece) => piece.trim())
      .filter(Boolean);
  }
  if (Array.isArray(raw)) return raw.filter((piece) => typeof piece === "string" && piece.trim());
  return [];
}

/** 组装最终目录文档；书信字段（version/fetched_at…）留空交给画布推导。 */
function buildDocument(models) {
  return {
    success: true,
    fetched_at: new Date().toISOString(),
    models,
  };
}

// ---------------------------------------------------------------- 上游读取（只读 GET）

async function fetchChannels(base, args) {
  const items = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = `${base}/api/channel/?p=${page}&page_size=${PAGE_SIZE}`;
    const payload = await getJson(url, adminHeaders(args));
    if (!payload.ok) return { ok: false, error: payload.error, items };
    const data = payload.value?.data;
    const rows = Array.isArray(data)
      ? data
      : Array.isArray(data?.items)
        ? data.items
        : Array.isArray(payload.value?.items)
          ? payload.value.items
          : [];
    items.push(...rows);
    const total =
      typeof data?.total === "number"
        ? data.total
        : typeof payload.value?.total === "number"
          ? payload.value.total
          : undefined;
    if (rows.length === 0) break;
    if (total !== undefined && items.length >= total) break;
    if (rows.length < PAGE_SIZE) break;
  }
  return { ok: true, items };
}

async function fetchUsableModelIds(base, args) {
  const payload = await getJson(
    `${base}/v1/models`,
    args["api-key"] ? bearer(args["api-key"]) : {},
  );
  if (!payload.ok) return { ok: false, error: payload.error, ids: [] };
  const rows = Array.isArray(payload.value?.data)
    ? payload.value.data
    : Array.isArray(payload.value?.models)
      ? payload.value.models
      : [];
  const ids = rows
    .map((row) => (isRecord(row) && typeof row.id === "string" ? row.id.trim() : ""))
    .filter(Boolean);
  return { ok: true, ids };
}

function adminHeaders(args) {
  return {
    ...(args["admin-token"] ? bearer(args["admin-token"]) : {}),
    ...(args["admin-user"] ? { [ADMIN_USER_HEADER]: String(args["admin-user"]) } : {}),
  };
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

async function getJson(url, headers) {
  try {
    const response = await fetch(url, {
      method: "GET", // 只读纪律：永远只发 GET。
      headers: { Accept: "application/json", ...headers },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------- 工具

const IMAGE_ID_PATTERNS = [
  /^gpt-image/i,
  /^(?:dall-?e|dalle)/i,
  /^flux/i,
  /^(?:doubao-)?seedream/i,
  /^nano-banana/i,
  /^imagen/i,
  /^(?:midjourney|mj[_-])/i,
  /^(?:stable-?diffusion|sdxl|sd3|sd-?\d)/i,
  /^qwen-image/i,
  /^ideogram/i,
  /^recraft/i,
  /^kolors/i,
  /^grok-image/i,
  /^hunyuan[-_]image(?:[-_\d]|$)/i,
];

const VIDEO_ID_PATTERNS = [
  /^sora/i,
  /^(?:google-)?veo/i,
  /^kling/i,
  /^wan(?:\d|-|_|$)/i,
  /^(?:doubao-)?seedance/i,
  /^(?:(?:minimax-)?hailuo(?:[-_\d]|$)|video-01(?:[-_]|$))/i,
  /^pika/i,
  /^(?:luma|ray-\d)/i,
  /^(?:runway|gen-[34])/i,
  /^grok-imagine-video/i,
  /^hunyuan[-_]video(?:[-_\d]|$)/i,
  /^vidu/i,
  /^cogvideo/i,
  /^mochi/i,
];

/**
 * 执行端点白名单，与 `apps/api/src/catalog/normalize.ts` 的 ENDPOINT_BY_MODALITY
 * 保持一致。画布只认这几个路径，上游自带的自由路径一概不采信。
 */
const ENDPOINT_BY_MODALITY = {
  text: "/v1/chat/completions",
  image: "/v1/images/generations",
  video: "/v1/videos",
  audio: "/v1/chat/completions",
};

/** 输出类型直接等于模态（画布 output.type 的取值域与模态一致）。 */
const OUTPUT_TYPE_BY_MODALITY = {
  text: "text",
  image: "image",
  video: "video",
  audio: "audio",
};

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function say(message) {
  // 人读信息统一走 stderr：stdout 只留给 JSON，方便管道。
  console.error(message);
}

function section(title) {
  say(`\n${title}`);
}

function banner(title) {
  say(`\n=== ${title} ===`);
}

function usage() {
  console.log(
    [
      "NewAPI → 上游合同 JSON 导出（只读）。",
      "",
      "用法：",
      "  node apps/api/scripts/newapi-catalog-export.mjs --api-base <url> \\",
      "    [--admin-token <token>] [--admin-user <id>] [--api-key <token>] [--out <path>]",
      "",
      "参数：",
      "  --api-base    中转站根地址（必填），例如 https://your-relay.example.com",
      "  --admin-token 管理端 token，以 Authorization: Bearer 读取 /api/channel/",
      "  --admin-user  额外发送 New-Api-User 头（部分部署要求）",
      "  --api-key     用户 token，用于读取 /v1/models 的 token 视图",
      "  --out         输出文件路径；缺省打印到 stdout",
      "  --help        显示本帮助",
      "",
      "退出码：0 = 已产出目录；1 = 什么都没产出；2 = 用法错误。",
      "说明：本脚本只读，不改中转站；不猜价格。缺价提醒见运行输出。",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "help") {
      usage();
      process.exit(0);
    }
    const value = argv[index + 1];
    if (value && !value.startsWith("--")) {
      parsed[key] = value;
      index += 1;
    }
  }
  return parsed;
}

// 仅在直接执行时跑 main；被 import（测试）时不触发任何网络/退出。
const isDirectRun =
  typeof process.argv[1] === "string" && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().then(
    (code) => {
      process.exit(code);
    },
    (error) => {
      say(`脚本异常：${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    },
  );
}
