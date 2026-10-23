import type { Hono } from "hono";

import { createHash } from "node:crypto";

import {
  announcementListResponseSchema,
  modelCatalogResponseSchema,
  modelModalitySchema,
  type ModelHealth,
  type PublicModel,
  type PublicModelCatalog,
} from "@weftcanvas/contracts";

import {
  announcementCollectionSchema,
  EMPTY_ANNOUNCEMENTS,
  publicAnnouncements,
  type AnnouncementCollection,
} from "../announcements/store.js";
import { modelOverridesSchema, type ModelOverrides } from "../catalog/overrides.js";
import { toPublicCatalogView } from "../catalog/public-view.js";
import { ADMIN_THEME_BOOT_JS, ADMIN_THEME_CSS } from "../ops/admin-theme.js";
import { errorResponse } from "../http/errors.js";
import { readJsonBody } from "../http/json-body.js";
import { CANVAS_OPS_ADMIN_PAGE } from "../ops/admin-page.js";

/**
 * Self-contained operator page for the override API. It is served by the API
 * itself so an operator does not need a separate deploy; the shared secret is
 * held in sessionStorage and sent as the `x-model-overrides-secret` header.
 */
const MODEL_OVERRIDES_ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>画布模型上架与定价</title>
<style>
${ADMIN_THEME_CSS}
/* 本页专属：沿用本页既有类名，观感全部走共享 token（与 /admin/ops 同源）。 */
header.wc-model-header {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 9px 18px;
  background: var(--wc-surface);
  border-bottom: 1px solid var(--wc-border);
}
header.wc-model-header h1 { font-size: 15px; margin: 0 auto 0 0; font-weight: 600; }
main { padding: 14px 18px 64px; max-width: 1280px; margin: 0 auto; }
#status { font-size: 12px; color: var(--wc-text-tertiary); }
#msg { margin: 12px 0 0; font-size: 13px; min-height: 20px; color: var(--wc-text-tertiary); }
#msg.ok { color: var(--wc-success); }
#msg.err { color: var(--wc-danger); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--wc-border); vertical-align: middle; }
th { position: sticky; top: 52px; z-index: 1; background: var(--wc-surface); font-size: 11px; color: var(--wc-text-tertiary); font-weight: 500; }
td { font-variant-numeric: tabular-nums; }
td.id code { font-size: 11.5px; color: var(--wc-text-secondary); font-family: ui-monospace, "SF Mono", Consolas, monospace; }
td .label { display: block; font-size: 12px; color: var(--wc-text-tertiary); }
.muted { color: var(--wc-text-tertiary); font-size: 12px; }
.price-input { width: 94px; }
.hidden-row td { opacity: .5; }
.badge {
  display: inline-block; padding: 0 6px; margin-left: 4px; border-radius: 3px; font-size: 11px;
  line-height: 16px; border: 1px solid var(--wc-border-strong); color: var(--wc-text-secondary);
}
.badge.badge-promo { background: var(--wc-amber-soft); border-color: transparent; color: var(--wc-amber); }
#filters { display: flex; gap: 8px; margin: 14px 0 10px; flex-wrap: wrap; align-items: center; }
#filters input[type=text] { flex: 1; min-width: 180px; }
#filters label { color: var(--wc-text-tertiary); font-size: 12px; }
.token-inputs { display: flex; gap: 4px; }
.token-inputs .price-input { width: 84px; }
.hint { color: var(--wc-text-tertiary); font-size: 12px; margin: 12px 0 0; max-width: 980px; }
.zone-input { width: 108px; }
.name-input { width: 100%; margin-bottom: 4px; }
.desc-input { width: 100%; font-size: 12px; }
.health-good { color: var(--wc-success); font-weight: 600; }
.health-mid { color: var(--wc-amber); font-weight: 600; }
.health-low { color: var(--wc-danger); font-weight: 600; }
@media (max-width: 720px) {
  header.wc-model-header { padding: 8px 14px; }
  main { padding: 12px 14px 48px; }
}
</style>
<script>${ADMIN_THEME_BOOT_JS}</script>
</head>
<body>
<header class="wc-model-header">
  <h1>画布模型上架与定价</h1>
  <input id="secret" type="password" placeholder="管理密钥" style="width:200px">
  <button id="load" class="wc-btn wc-btn-primary">加载</button>
  <button id="save" class="wc-btn wc-btn-primary" disabled>保存</button>
  <span id="status"></span>
  <div class="wc-seg" role="group" aria-label="配色">
    <button type="button" data-wc-theme-set="light" title="石墨（亮色）">石墨</button>
    <button type="button" data-wc-theme-set="dark" title="墨黑（暗色）">墨黑</button>
  </div>
</header>
<main>
  <div id="msg"></div>
  <p class="hint">列表来自上游目录（含所有可接模型）。<b>展示</b>取消勾选 = 下架，画布与 Agent 都不再出现；<b>自定义价</b>留空则沿用上游价，Token 模型按「元 / 百万 token」填输入与输出费率，其余模型按每条/张/秒填单个价格。<b>分区</b>决定模型出现在「稳定主推」还是「特惠」选择区：特惠区模型面向用户时明确标注「随时可能下架、不保证可用性与成功率」，只放中转渠道等不稳定模型，主推与默认选中始终是稳定区。<b>显示名/简介</b>只改站内文案（对外不出现上游原始模型名），不影响路由与计费。</p>
  <div id="filters">
    <input id="search" placeholder="筛选模型 id / 名称">
    <select id="modality">
      <option value="">全部类型</option>
      <option value="text">文本</option>
      <option value="image">图片</option>
      <option value="video">视频</option>
      <option value="audio">音频</option>
    </select>
    <label class="muted"><input type="checkbox" id="onlyHidden"> 只看已下架</label>
    <label class="muted"><input type="checkbox" id="onlyPromo"> 只看特惠区</label>
  </div>
  <table>
    <thead><tr>
      <th style="width:24%">模型</th><th>类型</th><th style="width:96px">成功率(7天)</th><th>分辨率</th><th style="width:180px">当前价</th><th style="width:170px">自定义价（元）</th><th style="width:110px">分区</th><th style="width:200px">显示名 / 简介</th><th style="width:64px">展示</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="9" class="muted">输入密钥后点「加载」</td></tr></tbody>
  </table>
</main>
<script>
(function () {
  var SECRET_KEY = 'canvas_model_overrides_secret_v1';
  var state = { models: [], overrides: { models: {} } };
  var $ = function (id) { return document.getElementById(id); };
  function setMsg(text, ok) { var el = $('msg'); el.textContent = text || ''; el.className = text ? (ok ? 'ok' : 'err') : ''; }
  function secret() { return $('secret').value.trim(); }
  function headers() { return { 'Content-Type': 'application/json', 'x-model-overrides-secret': secret() }; }
  function parse(v) { var n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null; }
  function fmtYuan(v) { return v === null || v === undefined ? '—' : String(Number(Number(v).toFixed(4))); }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function unitSuffix(unit) { return unit === 'image' ? '张' : unit === 'second' ? '秒' : '次'; }
  function healthCell(m) {
    if (m.healthSuccessRate === null || m.healthSuccessRate === undefined) return '<span class="muted">—</span>';
    var pct = Math.round(m.healthSuccessRate * 100);
    var cls = pct >= 90 ? 'health-good' : pct >= 70 ? 'health-mid' : 'health-low';
    return '<span class="' + cls + '">' + pct + '%</span> <span class="muted">(' + m.healthSamples + ')</span>';
  }
  function currentPrice(row) {
    if (row.pricingMode === 'token') {
      return '入 ¥' + fmtYuan(row.inputYuanPerMillion) + '/M · 出 ¥' + fmtYuan(row.outputYuanPerMillion) + '/M';
    }
    if (row.byResolution) return Object.keys(row.byResolution).sort().map(function (r) { return esc(r.toUpperCase()) + ' ' + row.byResolution[r]; }).join(' / ');
    if (row.yuan !== null) return String(row.yuan) + ' 元/' + unitSuffix(row.unit);
    if (row.baseYuan !== null) return fmtYuan(row.baseYuan) + ' 元/' + unitSuffix(row.unit);
    return '—';
  }
  function render() {
    var q = $('search').value.trim().toLowerCase();
    var modality = $('modality').value;
    var onlyHidden = $('onlyHidden').checked;
    var onlyPromo = $('onlyPromo').checked;
    var body = $('rows');
    var list = state.models.filter(function (m) {
      if (modality && m.modality !== modality) return false;
      var isPromo = state.overrides.models[m.id] && state.overrides.models[m.id].zone === 'promo';
      if (onlyHidden && !(state.overrides.models[m.id] && state.overrides.models[m.id].hidden === true)) return false;
      if (onlyPromo && !isPromo) return false;
      if (!q) return true;
      return (m.id + ' ' + m.label).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) { body.innerHTML = '<tr><td colspan="9" class="muted">没有匹配的模型</td></tr>'; return; }
    body.innerHTML = list.map(function (m) {
      var o = state.overrides.models[m.id] || {};
      var hidden = o.hidden === true;
      var isPromo = o.zone === 'promo';
      var tokenPrice = o.price || {};
      var res = (m.resolutions && m.resolutions.length ? m.resolutions.map(function (r) { return esc(r); }).join(' / ') : '—');
      var priceCell;
      if (m.pricingMode === 'token') {
        priceCell = '<div class="token-inputs">' +
          '<input class="price-input" data-field="tokenIn" type="number" min="0" step="0.01" placeholder="入 元/M" value="' + (tokenPrice.inputYuanPerMillion !== undefined && tokenPrice.inputYuanPerMillion !== null ? String(tokenPrice.inputYuanPerMillion) : '') + '">' +
          '<input class="price-input" data-field="tokenOut" type="number" min="0" step="0.01" placeholder="出 元/M" value="' + (tokenPrice.outputYuanPerMillion !== undefined && tokenPrice.outputYuanPerMillion !== null ? String(tokenPrice.outputYuanPerMillion) : '') + '">' +
          '</div>';
      } else {
        var custom = o.price && o.price.yuan !== undefined && o.price.yuan !== null ? String(o.price.yuan) : (o.price && o.price.byResolution ? '' : '');
        priceCell = '<input class="price-input" data-field="price" type="number" min="0" step="0.001" placeholder="不改" value="' + custom + '">';
      }
      var shownLabel = o.displayName || m.label;
      return '<tr data-id="' + esc(m.id) + '"' + (hidden ? ' class="hidden-row"' : '') + '>' +
        '<td class="id"><code>' + esc(m.id) + '</code><span class="label">' + esc(shownLabel) + (isPromo ? ' <span class="badge badge-promo">特惠</span>' : '') + '</span></td>' +
        '<td>' + m.modality + ' · ' + m.unit + (m.listed === false ? ' <span class="badge">兼容项</span>' : '') + '</td>' +
        '<td>' + healthCell(m) + '</td>' +
        '<td class="muted">' + res + '</td>' +
        '<td>' + currentPrice(m) + (o.price && o.price.byResolution ? ' <span class="badge">分档</span>' : '') + (tokenPrice.inputYuanPerMillion !== undefined || tokenPrice.outputYuanPerMillion !== undefined ? ' <span class="badge">已改</span>' : '') + '</td>' +
        '<td>' + priceCell + '</td>' +
        '<td><select class="zone-input" data-field="zone" title="特惠区：随时可能下架、不保证可用性与成功率">' +
          '<option value=""' + (!isPromo ? ' selected' : '') + '>稳定主推</option>' +
          '<option value="promo"' + (isPromo ? ' selected' : '') + '>特惠</option>' +
        '</select></td>' +
        '<td><input class="name-input" data-field="displayName" type="text" maxlength="60" placeholder="不改名（' + esc(shownLabel) + '）" title="站内显示名；留空沿用上游名称" value="' + esc(o.displayName || '') + '">' +
          '<input class="desc-input" data-field="description" type="text" maxlength="400" placeholder="不改简介" title="站内简介文案；留空沿用上游描述" value="' + esc(o.description || '') + '"></td>' +
        '<td><input data-field="visible" type="checkbox"' + (hidden ? '' : ' checked') + '></td>' +
      '</tr>';
    }).join('');
  }
  function collect() {
    var models = {};
    state.models.forEach(function (m) {
      // data-id 在 render() 里经过 esc()，这里必须用同一转义才能选回同一行。
      var tr = $('rows').querySelector('tr[data-id="' + esc(m.id) + '"]');
      var existing = state.overrides.models[m.id] || {};
      var entry = {};
      var visible;
      var price = null;
      if (tr) {
        visible = tr.querySelector('[data-field=visible]').checked;
        if (m.pricingMode === 'token') {
          var tokenIn = tr.querySelector('[data-field=tokenIn]');
          var tokenOut = tr.querySelector('[data-field=tokenOut]');
          var inValue = tokenIn ? parse(tokenIn.value.trim()) : null;
          var outValue = tokenOut ? parse(tokenOut.value.trim()) : null;
          if (inValue !== null || outValue !== null) {
            price = {};
            if (inValue !== null) price.inputYuanPerMillion = inValue;
            if (outValue !== null) price.outputYuanPerMillion = outValue;
          }
        } else {
          var priceInput = tr.querySelector('[data-field=price]');
          price = priceInput ? parse(priceInput.value.trim()) : null;
        }
        var zoneSelect = tr.querySelector('[data-field=zone]');
        var zone = zoneSelect ? zoneSelect.value : '';
        var displayName = tr.querySelector('[data-field=displayName]');
        var nameValue = displayName ? displayName.value.trim() : '';
        var descriptionInput = tr.querySelector('[data-field=description]');
        var descriptionValue = descriptionInput ? descriptionInput.value.trim() : '';
      } else {
        visible = existing.hidden !== true;
        if (m.pricingMode === 'token') {
          price = existing.price && (existing.price.inputYuanPerMillion !== undefined || existing.price.outputYuanPerMillion !== undefined) ? existing.price : null;
        } else {
          price = existing.price && existing.price.yuan !== undefined ? existing.price.yuan : null;
        }
        var zone = existing.zone === 'promo' ? 'promo' : '';
        var nameValue = existing.displayName || '';
        var descriptionValue = existing.description || '';
      }
      if (!visible) entry.hidden = true;
      if (price !== null) entry.price = m.pricingMode === 'token' ? price : { yuan: price };
      else if (existing.price && existing.price.byResolution) entry.price = { byResolution: existing.price.byResolution };
      if (existing.sortOrder !== undefined) entry.sortOrder = existing.sortOrder;
      if (zone === 'promo') entry.zone = 'promo';
      if (nameValue) entry.displayName = nameValue;
      if (descriptionValue) entry.description = descriptionValue;
      if (Object.keys(entry).length) models[m.id] = entry;
    });
    return { models: models };
  }
  function load() {
    if (!secret()) { setMsg('请先填写管理密钥', false); return; }
    setMsg('加载中…', true);
    fetch('/api/v1/admin/model-overrides', { headers: headers(), cache: 'no-store' }).then(function (res) {
      return res.json().then(function (json) { if (!res.ok || !json.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status)); return json.data; });
    }).then(function (data) {
      sessionStorage.setItem(SECRET_KEY, secret());
      state = data;
      $('save').disabled = false;
      setMsg('已加载 ' + data.models.length + ' 个模型' + (Object.keys(data.overrides.models || {}).length ? '（' + Object.keys(data.overrides.models).length + ' 条覆盖）' : ''), true);
      render();
    }).catch(function (e) { setMsg('加载失败：' + e.message, false); });
  }
  function save() {
    if (!secret()) { setMsg('请先填写管理密钥', false); return; }
    setMsg('保存中…', true);
    fetch('/api/v1/admin/model-overrides', { method: 'PUT', headers: headers(), body: JSON.stringify(collect()) }).then(function (res) {
      return res.json().then(function (json) { if (!res.ok || !json.ok) throw new Error((json.error && json.error.message) || ('HTTP ' + res.status)); return json.data; });
    }).then(function (data) {
      state = data;
      setMsg('已保存，画布模型面板将在下次目录刷新后生效', true);
      render();
    }).catch(function (e) { setMsg('保存失败：' + e.message, false); });
  }
  $('secret').value = sessionStorage.getItem(SECRET_KEY) || '';
  $('load').addEventListener('click', load);
  $('save').addEventListener('click', save);
  $('search').addEventListener('input', render);
  $('modality').addEventListener('change', render);
  $('onlyHidden').addEventListener('change', render);
  $('onlyPromo').addEventListener('change', render);
})();
</script>
</body>
</html>`;

export function modelCatalogViewVersion(catalog: Pick<PublicModelCatalog, "models">) {
  return createHash("sha256")
    .update(JSON.stringify(catalog.models))
    .digest("base64url")
    .slice(0, 16);
}

export function withModelHealth(
  models: PublicModel[],
  health: Map<string, ModelHealth> | undefined,
) {
  if (!health?.size) return models;
  return models.map((model) => {
    const stats = health.get(model.id);
    return stats ? { ...model, health: stats } : model;
  });
}

export function modelOverrideAdminRows(
  models: readonly PublicModel[],
  overrides: ModelOverrides,
): ModelOverrideAdminRow[] {
  return models.map((model) => {
    const override = overrides.models[model.id];
    const resolutionParameter = model.parameters.find(
      (parameter) => parameter.name === "resolution",
    );
    const resolutions = resolutionParameter
      ? Array.isArray(resolutionParameter.options)
        ? resolutionParameter.options.filter(
            (option): option is string => typeof option === "string",
          )
        : typeof resolutionParameter.fixed === "string"
          ? [resolutionParameter.fixed]
          : []
      : [];
    return {
      id: model.id,
      label: model.label,
      description: model.description,
      modality: model.modality,
      unit: model.pricing.unit,
      pricingMode: model.pricing.mode,
      creditsPerYuan: model.pricing.creditsPerYuan,
      baseYuan:
        model.pricing.baseYuanMicros !== undefined
          ? model.pricing.baseYuanMicros / 1_000_000
          : null,
      inputYuanPerMillion:
        model.pricing.inputYuanMicrosPerMillion !== undefined
          ? model.pricing.inputYuanMicrosPerMillion / 1_000_000
          : null,
      outputYuanPerMillion:
        model.pricing.outputYuanMicrosPerMillion !== undefined
          ? model.pricing.outputYuanMicrosPerMillion / 1_000_000
          : null,
      resolutions,
      listed: model.listed !== false,
      hidden: override?.hidden === true,
      yuan: override?.price?.yuan ?? null,
      byResolution: override?.price?.byResolution ?? null,
      tokenInputYuanPerMillion: override?.price?.inputYuanPerMillion ?? null,
      tokenOutputYuanPerMillion: override?.price?.outputYuanPerMillion ?? null,
      displayName: override?.displayName ?? null,
      overrideDescription: override?.description ?? null,
      zone: override?.zone ?? null,
      healthSuccessRate: model.health?.successRate ?? null,
      healthSamples: model.health?.sampleCount ?? null,
    };
  });
}

type OperatorCatalog = Pick<import("../catalog/adapter.js").WeftcanvasCatalogAdapter, "getCatalog">;
type ModelOverridesStore = {
  load(): Promise<ModelOverrides>;
  save(value: ModelOverrides): Promise<void>;
};
type AnnouncementsStore = {
  load(): Promise<AnnouncementCollection>;
  save(value: AnnouncementCollection): Promise<void>;
};
type ModelHealthProvider = { get(): Promise<Map<string, ModelHealth>> };
type CanvasOpsService = {
  overview(): Promise<unknown>;
  recentJobs(status: string, limit: number): Promise<unknown>;
  users(query: string, limit: number): Promise<unknown>;
};

type ModelOverrideAdminRow = {
  id: string;
  label: string;
  description: string;
  modality: string;
  unit: string;
  pricingMode: string;
  creditsPerYuan: number;
  baseYuan: number | null;
  /** 当前 token 费率（元 / 百万 token）。 */
  inputYuanPerMillion: number | null;
  outputYuanPerMillion: number | null;
  resolutions: string[];
  /** false = 本地兼容占位（老项目可报价），不是 API 站上架模型。 */
  listed: boolean;
  hidden: boolean;
  yuan: number | null;
  byResolution: Record<string, number> | null;
  /** 自定义 token 费率（元 / 百万 token）。 */
  tokenInputYuanPerMillion: number | null;
  tokenOutputYuanPerMillion: number | null;
  /** 覆盖：站内显示名 / 简介 / 运营分区。 */
  displayName: string | null;
  overrideDescription: string | null;
  zone: "stable" | "promo" | null;
  /** 近 7 天真实成功率（0..1）与样本数；样本不足或无数据库为 null。 */
  healthSuccessRate: number | null;
  healthSamples: number | null;
};

export type OperatorRouteDependencies = {
  catalogAdapter: OperatorCatalog;
  modelOverrides?: ModelOverridesStore;
  modelOverridesAdminSecret?: string;
  modelHealth?: ModelHealthProvider;
  announcements?: AnnouncementsStore;
  announcementsAdminSecret?: string;
  ops?: CanvasOpsService;
  opsAdminSecret?: string;
};

/**
 * 运营面路由（从 app.ts 抽出，纯搬移）：模型目录（含 ETag/health/modality 过滤）、
 * 模型上下架与改价、站点公告（公开读 + 运营密钥写）、运营后台（只读监控）与
 * 两个内联管理页。所有管理端点在缺密钥时整体 404（与拆分前一致）。
 */
export function registerOperatorRoutes(app: Hono, deps: OperatorRouteDependencies) {
  const {
    catalogAdapter,
    modelOverrides,
    modelOverridesAdminSecret,
    modelHealth,
    announcements,
    announcementsAdminSecret,
    ops,
    opsAdminSecret,
  } = deps;

  app.get("/api/v1/model-catalog", async (context) => {
    const forceRefresh = context.req.query("refresh") === "1";
    const requestedModality = context.req.query("modality");
    const modality = requestedModality ? modelModalitySchema.safeParse(requestedModality) : null;
    if (modality && !modality.success)
      return errorResponse(context, 400, "INVALID_MODALITY", "不支持这个模型类型");
    const catalog = toPublicCatalogView(
      await catalogAdapter.getCatalog({
        forceRefresh,
        awaitRefresh: forceRefresh,
        // The canvas hydrates every modality from the unfiltered response.
        awaitVideoAvailability: modality?.success ? modality.data === "video" : true,
      }),
    );
    const health = await modelHealth?.get();
    const data = modality?.success
      ? {
          ...catalog,
          models: withModelHealth(catalog.models, health).filter(
            (model) => model.modality === modality.data,
          ),
        }
      : { ...catalog, models: withModelHealth(catalog.models, health) };
    const catalogViewVersion = modelCatalogViewVersion(data);
    const etag = `"${data.version}:${data.capabilityVersion}:${data.pricingVersion}:${catalogViewVersion}:${data.quoteAvailable ? "fresh" : "stale"}:${data.expiresAt}:${modality?.success ? modality.data : "all"}"`;
    context.header("ETag", etag);
    // Visitor-independent: the catalog view carries no account state, so the
    // shared caches in front of this API (the Canvas release router's edge
    // cache included) may serve it. `private` used to keep every cold canvas
    // boot crossing the ocean to this origin for a response that is identical
    // for every visitor. Operator edits still propagate within a minute.
    context.header(
      "Cache-Control",
      forceRefresh ? "no-store" : "public, max-age=60, stale-while-revalidate=300",
    );
    if (context.req.header("If-None-Match") === etag) return context.body(null, 304);
    return context.json(modelCatalogResponseSchema.parse({ ok: true, data }));
  });

  app.get("/api/v1/model-catalog/version", async (context) => {
    const catalog = toPublicCatalogView(await catalogAdapter.getCatalog());
    const viewVersion = modelCatalogViewVersion(catalog);
    const etag = `"${catalog.version}:${catalog.capabilityVersion}:${catalog.pricingVersion}:${viewVersion}:${catalog.quoteAvailable ? "fresh" : "stale"}"`;
    context.header("ETag", etag);
    context.header("Cache-Control", "private, max-age=60, stale-while-revalidate=300");
    if (context.req.header("If-None-Match") === etag) return context.body(null, 304);
    return context.json({
      ok: true,
      data: {
        version: catalog.version,
        capabilityVersion: catalog.capabilityVersion,
        pricingVersion: catalog.pricingVersion,
        viewVersion,
        quoteAvailable: catalog.quoteAvailable,
      },
    });
  });

  // Operator model overrides. The API is the source of the fields Canvas
  // actually bills against, so hiding a model or repricing it here takes effect
  // for the picker, quotes, and new jobs without touching the upstream catalog.
  // A strong per-deployment secret guards both reads and writes; when the
  // secret is not configured the whole surface is invisible.
  app.get("/api/v1/admin/model-overrides", async (context) => {
    const secret = modelOverridesAdminSecret;
    if (!modelOverrides || !secret || context.req.header("x-model-overrides-secret") !== secret) {
      return context.notFound();
    }
    const [overrides, catalog] = await Promise.all([
      modelOverrides.load(),
      catalogAdapter.getCatalog({ includeOverrides: false }),
    ]);
    const health = await modelHealth?.get();
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: {
        overrides,
        models: modelOverrideAdminRows(withModelHealth(catalog.models, health), overrides),
      },
    });
  });

  app.put("/api/v1/admin/model-overrides", async (context) => {
    const secret = modelOverridesAdminSecret;
    if (!modelOverrides || !secret || context.req.header("x-model-overrides-secret") !== secret) {
      return context.notFound();
    }
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const parsed = modelOverridesSchema.safeParse(body);
    if (!parsed.success)
      return errorResponse(context, 422, "INVALID_MODEL_OVERRIDES", "模型覆盖配置格式不正确");
    await modelOverrides.save(parsed.data);
    const catalog = await catalogAdapter.getCatalog({ includeOverrides: false });
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: { overrides: parsed.data, models: modelOverrideAdminRows(catalog.models, parsed.data) },
    });
  });

  app.get("/admin/model-overrides", (context) => {
    context.header("Content-Type", "text/html; charset=utf-8");
    context.header("Cache-Control", "no-store");
    context.header("X-Robots-Tag", "noindex, nofollow");
    return context.body(MODEL_OVERRIDES_ADMIN_PAGE);
  });

  // 站点公告：运营在后台维护，画布前端匿名读取。启用 / 定时发布 / 过期都在
  // 读取时现算，保存即生效，不需要定时任务；写用运营密钥（与后台同一把，
  // 缺省已回落到模型密钥），没配密钥时管理面整体 404。
  const requireAnnouncementAdmin = (context: {
    req: { header(name: string): string | undefined };
  }) =>
    Boolean(announcements && announcementsAdminSecret) &&
    context.req.header("x-canvas-ops-secret") === announcementsAdminSecret;

  app.get("/api/v1/announcements", async (context) => {
    const collection = announcements ? await announcements.load() : EMPTY_ANNOUNCEMENTS;
    context.header("Cache-Control", "no-store");
    return context.json(
      announcementListResponseSchema.parse({
        ok: true,
        data: { items: publicAnnouncements(collection) },
      }),
    );
  });

  app.get("/api/v1/admin/announcements", async (context) => {
    if (!requireAnnouncementAdmin(context)) return context.notFound();
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: await announcements!.load() });
  });

  app.put("/api/v1/admin/announcements", async (context) => {
    if (!requireAnnouncementAdmin(context)) return context.notFound();
    const body = await readJsonBody(context);
    if (body instanceof Response) return body;
    const parsed = announcementCollectionSchema.safeParse(body);
    if (!parsed.success)
      return errorResponse(context, 422, "INVALID_ANNOUNCEMENTS", "公告格式不正确");
    await announcements!.save(parsed.data);
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: parsed.data });
  });

  // 画布运营后台（只读监控）。独立密钥，缺省回落到模型后台那把，少配一个变量。
  const requireOpsAdmin = (context: { req: { header(name: string): string | undefined } }) =>
    Boolean(ops && opsAdminSecret) && context.req.header("x-canvas-ops-secret") === opsAdminSecret;

  app.get("/api/v1/admin/ops/overview", async (context) => {
    if (!requireOpsAdmin(context)) return context.notFound();
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: await ops!.overview() });
  });

  app.get("/api/v1/admin/ops/jobs", async (context) => {
    if (!requireOpsAdmin(context)) return context.notFound();
    const status = context.req.query("status") === "all" ? "all" : "failed";
    const limit = Number(context.req.query("limit") ?? 50);
    context.header("Cache-Control", "no-store");
    return context.json({
      ok: true,
      data: { jobs: await ops!.recentJobs(status, limit) },
    });
  });

  app.get("/api/v1/admin/ops/users", async (context) => {
    if (!requireOpsAdmin(context)) return context.notFound();
    const query = context.req.query("query") ?? "";
    const limit = Number(context.req.query("limit") ?? 50);
    context.header("Cache-Control", "no-store");
    return context.json({ ok: true, data: await ops!.users(query, limit) });
  });

  app.get("/admin/ops", (context) => {
    context.header("Content-Type", "text/html; charset=utf-8");
    context.header("Cache-Control", "no-store");
    context.header("X-Robots-Tag", "noindex, nofollow");
    return context.body(CANVAS_OPS_ADMIN_PAGE);
  });
}
