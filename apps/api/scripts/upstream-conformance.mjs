#!/usr/bin/env node
/**
 * 上游一致性探针 —— 给中转站长/自托管用户**自助**验证用。
 *
 * 目的：把"能不能接上画布"从"问我们"变成"你自己跑一条命令就知道"。它只做只读
 * 检查，不改任何东西，并且**不对上游提出格式要求**——它读你已经发布的端点，告诉你
 * 画布能读到哪里、缺什么。
 *
 * 用法（任选其一，未给的端点会被跳过）：
 *
 *   node apps/api/scripts/upstream-conformance.mjs \
 *     --catalog-url https://your-relay.example.com/api/model-catalog \
 *     --pricing-url  https://your-relay.example.com/api/pricing \
 *     --api-base     https://your-relay.example.com \
 *     [--video-inventory-url ...] [--api-key sk-...]
 *
 * 退出码：0 = 画布可用（可能带提示）；1 = 有阻断缺口。
 *
 * 关于键名：目录文档的 "书信字段"（success / fetched_at / capability_version /
 * credits_per_yuan / 版本号命名）缺失或大小写不同都不影响使用，画布会自动推导；
 * 唯独**模型级价格**不猜——缺价格的模型会被跳过并列在这里。无价格的上游请改走
 * 浏览器 BYOK 直连（不需要服务端报价）。
 */

const args = parseArgs(process.argv.slice(2));
if (!args["catalog-url"] && !args["api-base"]) {
  console.error("至少给出 --catalog-url 或 --api-base。用 --help 查看用法（见脚本头部注释）。");
  process.exit(2);
}

const findings = [];
const notes = [];
let blocking = false;

const catalogUrl =
  args["catalog-url"] ??
  (args["api-base"] ? joinUrl(args["api-base"], "/api/model-catalog") : null);
const openAiModelsUrl = args["api-base"] ? joinUrl(args["api-base"], "/v1/models") : null;

banner("上游一致性检查");
if (args["api-key"]) notes.push("已带凭据请求（值不会回显）");

if (catalogUrl) await checkCatalog(catalogUrl);
if (openAiModelsUrl) await checkOpenAiModels(openAiModelsUrl);
if (args["pricing-url"]) await checkPricing(args["pricing-url"]);
if (args["video-inventory-url"]) await checkVideoInventory(args["video-inventory-url"]);

banner("结论");
for (const note of notes) console.log(`  · ${note}`);
if (!findings.length) {
  console.log("  ✅ 画布可以直接使用这个上游（未发现阻断项）。");
} else {
  for (const finding of findings)
    console.log(`  ${finding.blocking ? "⛔" : "⚠️"} ${finding.text}`);
}
console.log(
  blocking
    ? "\n结果：有阻断缺口——上面的 ⛔ 项修好后重跑本脚本。"
    : "\n结果：可用。把结果贴给画布维护者即可开始接入。",
);
process.exit(blocking ? 1 : 0);

// ---------------------------------------------------------------- 检查项

async function checkCatalog(url) {
  section(`目录文档 ${url}`);
  const payload = await getJson(url);
  if (!payload.ok) return report(false, `无法读取目录文档：${payload.error}`);

  const body = payload.value;
  const models = Array.isArray(body?.models)
    ? body.models
    : Array.isArray(body?.data)
      ? body.data
      : null;
  if (!models) {
    return report(true, "目录文档里找不到模型清单（`models[]` 或 OpenAI 风格 `data[]`）。");
  }

  const envelope = {
    success: body?.success,
    version: body?.version ?? body?.catalogVersion,
    capabilityVersion: body?.capability_version ?? body?.capabilityVersion,
    fetchedAt: body?.fetched_at ?? body?.fetchedAt,
    creditsPerYuan: body?.credits_per_yuan ?? body?.creditsPerYuan,
  };
  const derived = Object.entries(envelope)
    .filter(([, value]) => value === undefined || value === null || value === "")
    .map(([key]) => key);
  console.log(`  · 模型行：${models.length}`);
  if (derived.length) {
    console.log(`  · 这些书信字段缺失，画布会推导（不影响接入）：${derived.join(", ")}`);
  }

  const priced = [];
  const unpriced = [];
  const invalid = [];
  for (const model of models) {
    const row = checkModelRow(model);
    if (row.pricing === "ok") priced.push(model);
    else if (row.pricing === "missing") unpriced.push(model);
    else invalid.push({ model, row });
  }

  console.log(`  · 带价格、可用于报价的模型：${priced.length}`);
  if (unpriced.length) {
    console.log(`  · 缺价格、画布会跳过的模型：${unpriced.length}`);
    for (const model of unpriced.slice(0, 8)) {
      console.log(`      - ${label(model)}（缺 pricing）`);
    }
    if (unpriced.length > 8) console.log(`      … 另外 ${unpriced.length - 8} 个`);
  }
  if (invalid.length) {
    console.log(`  · 价格字段不合规的模型：${invalid.length}`);
    for (const { model, row } of invalid.slice(0, 5)) {
      console.log(`      - ${label(model)}：${row.problems.join("；")}`);
    }
  }

  if (priced.length === 0) {
    blocking = true;
    findings.push({
      blocking: true,
      text: catalogUrlFallbackMessage(),
    });
  } else if (unpriced.length) {
    findings.push({
      blocking: false,
      text: `有 ${unpriced.length} 个模型缺少 pricing，画布不会列出它们；补上即可一并上架。`,
    });
  }
  if (typeof envelope.creditsPerYuan !== "number" && envelope.creditsPerYuan !== undefined) {
    findings.push({ blocking: false, text: "credits_per_yuan 不是数字，画布会按 1 处理。" });
  }
}

function checkModelRow(model) {
  if (!isRecord(model)) return { pricing: "missing", problems: ["模型行不是对象"] };
  const problems = [];
  for (const field of ["id", "modality", "operation"]) {
    if (typeof model[field] !== "string" || !model[field].trim()) problems.push(`缺 ${field}`);
  }
  if (!isRecord(model.pricing)) return { pricing: "missing", problems };
  const pricing = model.pricing;
  if (!["fixed", "tiered", "token", "tiered_token"].includes(pricing.mode)) {
    problems.push(
      `pricing.mode 必须是 fixed/tiered/token/tiered_token（当前 ${JSON.stringify(pricing.mode)}）`,
    );
  }
  if (!["request", "image", "second", "token"].includes(pricing.unit)) {
    problems.push(
      `pricing.unit 必须是 request/image/second/token（当前 ${JSON.stringify(pricing.unit)}）`,
    );
  }
  if (pricing.currency !== "CNY") {
    problems.push(`pricing.currency 目前只接受 "CNY"（当前 ${JSON.stringify(pricing.currency)}）`);
  }
  return problems.length ? { pricing: "invalid", problems } : { pricing: "ok", problems };
}

async function checkOpenAiModels(url) {
  section(`OpenAI 兼容模型列表 ${url}`);
  const payload = await getJson(url);
  if (!payload.ok) {
    notes.push("/v1/models 不可读（若你的上游只有目录文档，这是正常的）");
    return;
  }
  const models = Array.isArray(payload.value?.data) ? payload.value.data : [];
  console.log(`  · 返回 ${models.length} 个模型 id`);
  notes.push(
    "注意：/v1/models 只给模型名，没有价格与参数；服务端计费链路需要目录文档里的价格，画布用它无法报价。",
  );
}

async function checkPricing(url) {
  section(`计价文档 ${url}`);
  const payload = await getJson(url);
  if (!payload.ok) return report(false, `无法读取计价文档：${payload.error}`);
  console.log(`  · 可读（${describeShape(payload.value)}）`);
  notes.push("计价文档用作文字模型的上游费率参考；缺失只影响按 token 计的模型。");
}

async function checkVideoInventory(url) {
  section(`视频准入清单 ${url}`);
  const payload = await getJson(url);
  if (!payload.ok) return report(false, `无法读取视频准入清单：${payload.error}`);
  const models = Array.isArray(payload.value?.models)
    ? payload.value.models
    : Array.isArray(payload.value?.data)
      ? payload.value.data
      : [];
  console.log(`  · 可读，声明 ${models.length} 条视频模型准入`);
  notes.push("视频准入清单缺省时，视频模型按目录文档自身声明发布。");
}

// ---------------------------------------------------------------- 工具

function catalogUrlFallbackMessage() {
  return "目录文档里没有任何带价格的模型：服务端无法报价，用户就无法提交（无价格的上游请走浏览器 BYOK 直连）。";
}

function report(isBlocking, text) {
  blocking = blocking || isBlocking;
  findings.push({ blocking: isBlocking, text });
}

async function getJson(url) {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(args["api-key"] ? { Authorization: `Bearer ${args["api-key"]}` } : {}),
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    return { ok: true, value: await response.json() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function label(model) {
  if (!isRecord(model)) return "(非对象)";
  const id = model.public && isRecord(model.public) ? model.public.id : model.id;
  return typeof id === "string" && id.trim() ? id : "(无 id)";
}

function describeShape(value) {
  if (Array.isArray(value)) return `数组，${value.length} 项`;
  if (isRecord(value)) return `对象，字段 ${Object.keys(value).slice(0, 6).join("/")}`;
  return typeof value;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}${path}`;
}

function section(title) {
  console.log(`\n${title}`);
}

function banner(title) {
  console.log(`\n=== ${title} ===`);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    if (key === "help") {
      console.log(
        "见脚本头部注释：node apps/api/scripts/upstream-conformance.mjs --catalog-url <url> [--api-base <url>] [--api-key <key>]",
      );
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
