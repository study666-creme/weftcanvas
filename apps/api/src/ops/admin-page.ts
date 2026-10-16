import { ADMIN_THEME_BOOT_JS, ADMIN_THEME_CSS } from "./admin-theme.js";

/**
 * 画布运营后台：概览 + 用户 + 任务 + 模型运营四页合一的控制台。
 *
 * - 模型页与「画布模型上架与定价」页同源同接口（GET/PUT /api/v1/admin/model-overrides），
 *   上下架、自定义价（固定/分档/token 双费率）、稳定/特惠分区、显示名与简介覆盖
 *   都在这里完成（上游价只读展示，排序字段不在这个界面上改）；概览走
 *   /api/v1/admin/ops/overview，用户页走 /api/v1/admin/ops/users，任务页走
 *   /api/v1/admin/ops/jobs。两把密钥共用一个输入框：请求同时带 x-canvas-ops-secret
 *   与 x-model-overrides-secret（server 侧 ops 缺省回落到模型密钥，一把通两页）。
 * - 观感与画布同源：颜色/字体/几何全部走 admin-theme 的石墨 token（亮色石墨、
 *   暗色墨黑），顶栏吸顶、描边撑层级、方形徽标、零字距。
 * - 兼容性：脚本 ES5 + XMLHttpRequest，CSS 不用 `:has`/容器查询这类新特性
 *   （自定义属性、flex、calc、`:focus-visible` 可用）；窄屏卡片换行、长表在
 *   面板内滚动。
 */
export const CANVAS_OPS_ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>画布运营后台</title>
<style>
${ADMIN_THEME_CSS}
/* 本页专属：只放布局量，颜色与几何一律用共享 token。 */
#secret { width: 190px; }
/* 表格单元格是 nowrap，显示名/简介两个输入框必须显式换行（inline-block 在
   nowrap 里不会折行，第二个输入框会横着溢出整张表）。 */
#modelRows .wc-name-input input { display: block; width: 100%; }
#modelRows .wc-name-input input + input { margin-top: 4px; }
.wc-user-cell code { display: block; }
.wc-user-cell .wc-sub { display: block; }
/* 徽标默认跟在文字后（margin-left 6px）；单独占格的列要贴齐表头。 */
.wc-table td.wc-badge-cell .wc-badge { margin-left: 0; }
</style>
<script>${ADMIN_THEME_BOOT_JS}</script>
</head>
<body>
<header class="wc-topbar">
  <div class="wc-topbar-inner">
    <div class="wc-brand">
      <h1>画布运营后台</h1>
      <span class="wc-sub">概览 · 用户 · 任务 · 模型运营</span>
    </div>
    <div class="wc-topbar-actions">
      <input id="secret" type="password" placeholder="运营密钥" autocomplete="off">
      <button id="load" class="wc-btn wc-btn-primary" type="button">加载</button>
      <span id="msg" class="wc-msg"></span>
      <div class="wc-seg" role="group" aria-label="配色">
        <button type="button" data-wc-theme-set="light" title="石墨（亮色）">石墨</button>
        <button type="button" data-wc-theme-set="dark" title="墨黑（暗色）">墨黑</button>
      </div>
    </div>
  </div>
</header>
<main class="wc-admin-shell">
  <nav class="wc-tabs" aria-label="后台分区">
    <button id="tab-overview" class="wc-tab on" type="button">概览</button>
    <button id="tab-users" class="wc-tab" type="button">用户</button>
    <button id="tab-jobs" class="wc-tab" type="button">任务</button>
    <button id="tab-models" class="wc-tab" type="button">模型运营</button>
  </nav>

  <section id="page-overview">
    <div class="wc-cards" id="cards"></div>
    <h2 class="wc-h2">模型成功率 · 近 7 天真实任务</h2>
    <div class="wc-tablewrap"><table class="wc-table">
      <thead><tr><th>模型</th><th>成功率</th><th>样本</th></tr></thead>
      <tbody id="health"><tr><td colspan="3" class="wc-empty">点「加载」拉取概览</td></tr></tbody>
    </table></div>
  </section>

  <section id="page-users" hidden>
    <div class="wc-filters">
      <input id="userQuery" type="text" placeholder="搜索邮箱 / 昵称 / 用户 id">
      <button id="userSearch" class="wc-btn" type="button">搜索</button>
      <span id="usersSummary" class="wc-sub"></span>
    </div>
    <div class="wc-tablewrap"><table class="wc-table">
      <thead><tr>
        <th>用户</th><th>状态</th><th title="可用余额（画布积分，换算率取自目录）">积分</th><th>云项目</th><th>素材</th>
        <th>任务</th><th>任务 · 24h</th><th>最近登录</th><th>注册</th>
      </tr></thead>
      <tbody id="userRows"><tr><td colspan="9" class="wc-empty">点「加载」拉取用户列表</td></tr></tbody>
    </table></div>
  </section>

  <section id="page-jobs" hidden>
    <div class="wc-filters">
      <button id="failed" class="wc-btn on" type="button">失败</button>
      <button id="all" class="wc-btn" type="button">全部</button>
      <span class="wc-sub">按更新时间倒序 · 最近 20 条</span>
    </div>
    <div class="wc-tablewrap"><table class="wc-table">
      <thead><tr><th>任务</th><th>用户</th><th>模型</th><th>状态</th><th>错误</th><th>更新时间</th></tr></thead>
      <tbody id="jobs"><tr><td colspan="6" class="wc-empty">点「加载」拉取任务</td></tr></tbody>
    </table></div>
  </section>

  <section id="page-models" hidden>
    <div class="wc-filters">
      <input id="search" type="text" placeholder="搜索模型 id / 名称">
      <select id="modality">
        <option value="">全部类型</option>
        <option value="image">图片</option>
        <option value="video">视频</option>
        <option value="text">文本</option>
        <option value="audio">音频</option>
      </select>
      <label><input id="onlyHidden" type="checkbox"> 只看已下架</label>
      <label><input id="onlyPromo" type="checkbox"> 只看特惠区</label>
      <span class="wc-tail">
        <span id="saveMsg" class="wc-sub"></span>
        <button id="save" class="wc-btn wc-btn-primary" type="button">保存修改</button>
      </span>
    </div>
    <div class="wc-tablewrap"><table class="wc-table">
      <thead><tr>
        <th>模型</th><th>类型</th><th>成功率(7天)</th><th title="跟随上游目录的价格；改价后仅供参考">上游价</th><th>自定义价（元）</th>
        <th>分区</th><th>显示名 / 简介</th><th>展示</th>
      </tr></thead>
      <tbody id="modelRows"><tr><td colspan="8" class="wc-empty">点「加载」拉取模型目录</td></tr></tbody>
    </table></div>
  </section>
</main>
<script>
(function () {
  var SECRET_KEY = "canvas_ops_admin_secret_v1";
  var TABS = ["overview", "users", "jobs", "models"];
  var state = {
    tab: "overview", filter: "failed", loaded: false,
    overview: null, models: null, overrides: null, users: null, userQuery: "",
  };
  function $(id) { return document.getElementById(id); }
  function secret() { return $("secret").value.replace(/^\\s+|\\s+$/g, ""); }
  function msg(t, cls) { var el = $("msg"); el.textContent = t; el.className = "wc-msg" + (cls ? " " + cls : ""); }
  function esc(v) {
    return String(v === null || v === undefined ? "" : v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }
  function bytes(n) {
    if (!isFinite(n) || n <= 0) return "0 B";
    var u = ["B", "KB", "MB", "GB", "TB"];
    var i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
  }
  function credits(n) {
    if (!isFinite(n)) return "—";
    return (Math.round(n * 100) / 100).toLocaleString("zh-CN");
  }
  function count(n) {
    return isFinite(n) ? Number(n).toLocaleString("zh-CN") : "—";
  }
  function shortVersion(v) {
    var text = String(v === null || v === undefined ? "" : v);
    return text.length > 14 ? text.substring(0, 14) + "…" : text;
  }
  function when(v) { return v ? new Date(v).toLocaleString("zh-CN") : "—"; }
  function api(method, path, body, done, fail) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.setRequestHeader("x-canvas-ops-secret", secret());
    xhr.setRequestHeader("x-model-overrides-secret", secret());
    if (body) xhr.setRequestHeader("content-type", "application/json");
    xhr.timeout = 15000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) { done(JSON.parse(xhr.responseText).data); }
      else if (xhr.status === 404) { fail("密钥无效或后台未启用（HTTP 404）"); }
      else { fail("HTTP " + xhr.status); }
    };
    xhr.onerror = function () { fail("网络错误"); };
    xhr.ontimeout = function () { fail("请求超时"); };
    xhr.send(body ? JSON.stringify(body) : null);
  }
  function card(label, value, cls, sub, title) {
    return '<div class="wc-card"' + (title ? ' title="' + esc(title) + '"' : "") + "><small>"
      + esc(label) + "</small>"
      + "<b" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(value) + "</b>"
      + (sub ? "<em>" + esc(sub) + "</em>" : "") + "</div>";
  }

  /* ---------- 概览 ---------- */
  function renderOverview(d) {
    state.overview = d;
    var terminal = d.jobs.completed + d.jobs.failed;
    var rate = terminal ? Math.round((d.jobs.failed / terminal) * 100) : -1;
    var catalogOk = d.catalog.version && d.catalog.quoteAvailable;
    $("cards").innerHTML =
      card("用户", count(d.users), "", "", "注册账号总数") +
      card("云项目", count(d.projects), "", "", "云端保存的画布项目数") +
      card("云端素材", count(d.media.count), "", bytes(d.media.bytes), "云端已就绪素材数与占用") +
      card("任务 · 24h", count(terminal), "", "成功 " + count(d.jobs.completed) + " · 失败 " + count(d.jobs.failed),
        "近 24 小时收敛的生成任务") +
      card("失败率", rate < 0 ? "—" : rate + "%", rate < 0 ? "" : rate > 30 ? "wc-bad" : rate > 10 ? "wc-warn" : "wc-ok",
        "", "近 24 小时终态任务的失败占比") +
      card("在途", count(d.jobs.inFlight), d.jobs.staleInFlight > 0 ? "wc-bad" : "",
        d.jobs.staleInFlight > 0 ? d.jobs.staleInFlight + " 个超 30 分钟" : "",
        "尚未收敛的任务；超过 30 分钟未更新即积压") +
      card("模型目录", catalogOk ? "正常" : "不可用", catalogOk ? "wc-ok" : "wc-bad",
        d.catalog.version ? "版本 " + shortVersion(d.catalog.version) : "",
        "目录版本与报价可用性（上游目录自动跟随，本地可覆盖）");
    var health = d.modelHealth || [];
    $("health").innerHTML = health.length ? health.map(function (m) {
      var pct = Math.round(m.successRate * 100);
      var cls = pct >= 90 ? "wc-ok" : pct >= 70 ? "wc-warn" : "wc-bad";
      return "<tr><td class=wc-wide><code>" + esc(m.modelId) + "</code></td>"
        + '<td class="' + cls + '"><span class="wc-meter"><i style="width:' + pct + '%"></i></span>' + pct + "%</td>"
        + "<td>" + m.sampleCount + "</td></tr>";
    }).join("") : '<tr><td colspan="3" class="wc-empty">暂无足够样本的模型（近 7 天 ≥5 次终态任务才统计）</td></tr>';
  }
  function loadOverview() {
    api("GET", "/api/v1/admin/ops/overview", null, function (d) {
      renderOverview(d);
      msg("更新于 " + new Date().toLocaleTimeString("zh-CN"));
    }, function (e) { msg("概览加载失败：" + e, "err"); });
  }

  /* ---------- 用户 ---------- */
  function renderUsers(payload) {
    state.users = payload;
    var rows = payload.users || [];
    var matched = payload.total || 0;
    var all = state.overview ? state.overview.users : null;
    $("usersSummary").textContent = rows.length
      ? "匹配 " + matched + " 人 · 显示前 " + rows.length + " 条" + (all === null ? "" : "（共 " + all + " 用户）")
      : (all === null ? "没有匹配的用户" : "没有匹配的用户（共 " + all + " 用户）");
    if (!rows.length) {
      $("userRows").innerHTML = '<tr><td colspan="9" class="wc-empty">没有匹配的用户</td></tr>';
      return;
    }
    $("userRows").innerHTML = rows.map(function (u) {
      var status = u.status === "disabled"
        ? '<span class="wc-badge off">已禁用</span>'
        : '<span class="wc-badge on">正常</span>';
      var window24h = count(u.jobsCompleted) + " / " + '<span class="' + (u.jobsFailed > 0 ? "wc-bad" : "wc-sub") + '">' + count(u.jobsFailed) + "</span>";
      return "<tr>"
        + '<td class="wc-wide wc-user-cell"><code>' + esc(u.email) + "</code>"
        + '<span class="wc-sub">' + esc(u.displayName) + " · " + esc(String(u.id).substring(0, 8)) + "</span></td>"
        + '<td class="wc-badge-cell">' + status + "</td>"
        + "<td>" + esc(credits(u.credits)) + "</td>"
        + "<td>" + esc(count(u.projects)) + "</td>"
        + '<td>' + esc(count(u.mediaCount)) + ' <span class="wc-sub">' + esc(bytes(u.mediaBytes)) + "</span></td>"
        + "<td>" + esc(count(u.jobs)) + "</td>"
        + '<td title="成功 / 失败">' + window24h + "</td>"
        + "<td>" + esc(when(u.lastLoginAt)) + "</td>"
        + "<td>" + esc(when(u.createdAt)) + "</td>"
        + "</tr>";
    }).join("");
  }
  function loadUsers() {
    if (!secret()) { msg("先输入运营密钥", "err"); return; }
    state.userQuery = $("userQuery").value.replace(/^\\s+|\\s+$/g, "");
    $("userRows").innerHTML = '<tr><td colspan="9" class="wc-empty">加载中…</td></tr>';
    api("GET", "/api/v1/admin/ops/users?limit=50&query=" + encodeURIComponent(state.userQuery),
      null, renderUsers, function (e) {
        $("userRows").innerHTML = '<tr><td colspan="9" class="wc-empty">用户加载失败：' + esc(e) + "</td></tr>";
      });
  }

  /* ---------- 任务 ---------- */
  function renderJobs(jobs) {
    $("jobs").innerHTML = jobs.length ? jobs.map(function (j) {
      var cls = j.status === "failed" ? "wc-bad" : j.status === "completed" ? "wc-ok" : "wc-warn";
      return "<tr><td><code>" + esc(j.id.substring(0, 8)) + "</code></td>"
        + "<td><code>" + esc(j.ownerId.substring(0, 8)) + "</code></td>"
        + '<td class="wc-wide"><code>' + esc(j.modelId) + "</code></td>"
        + '<td class="' + cls + '">' + esc(j.status) + "</td>"
        + "<td>" + esc(j.errorCode || "—") + "</td>"
        + "<td>" + esc(when(j.updatedAt)) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="wc-empty">没有匹配的任务</td></tr>';
  }
  function loadJobs() {
    if (!secret()) return;
    api("GET", "/api/v1/admin/ops/jobs?status=" + state.filter + "&limit=20", null, function (part) {
      renderJobs(part.jobs);
    }, function (e) { msg("任务加载失败：" + e, "err"); });
  }

  /* ---------- 模型运营 ---------- */
  function unitSuffix(unit) { return unit === "image" ? "张" : unit === "second" ? "秒" : "次"; }
  function fmtYuan(v) { return v === null || v === undefined ? "—" : String(Number(Number(v).toFixed(4))); }
  /** 上游价（只读）：目录里跟随来的价格，与右侧的自定义价形成对照。 */
  function upstreamPrice(m) {
    if (m.pricingMode === "token") {
      return "入 ¥" + fmtYuan(m.inputYuanPerMillion) + "/M · 出 ¥" + fmtYuan(m.outputYuanPerMillion) + "/M";
    }
    if (m.baseYuan === null || m.baseYuan === undefined) return "—";
    return fmtYuan(m.baseYuan) + " 元/" + unitSuffix(m.unit);
  }
  function overrideOf(id) {
    return (state.overrides && state.overrides.models && state.overrides.models[id]) || {};
  }
  function renderModels() {
    if (!state.models) { $("modelRows").innerHTML = '<tr><td colspan="8" class="wc-empty">点「加载」拉取模型目录</td></tr>'; return; }
    var q = $("search").value.replace(/^\\s+|\\s+$/g, "").toLowerCase();
    var modality = $("modality").value;
    var onlyHidden = $("onlyHidden").checked;
    var onlyPromo = $("onlyPromo").checked;
    var rows = [];
    for (var i = 0; i < state.models.length; i++) {
      var m = state.models[i];
      var o = overrideOf(m.id);
      if (modality && m.modality !== modality) continue;
      if (onlyHidden && o.hidden !== true) continue;
      if (onlyPromo && o.zone !== "promo") continue;
      if (q && (m.id + " " + m.label).toLowerCase().indexOf(q) < 0) continue;
      rows.push(m);
    }
    if (!rows.length) { $("modelRows").innerHTML = '<tr><td colspan="8" class="wc-empty">没有匹配的模型</td></tr>'; return; }
    $("modelRows").innerHTML = rows.map(function (m) {
      var o = overrideOf(m.id);
      var priceCell;
      var tp = o.price || {};
      if (m.pricingMode === "token") {
        priceCell = '<div class="wc-tokenpair">'
          + '<input class="wc-cell-input wc-small" data-field="tokenIn" type="number" min="0" step="0.01" placeholder="入 元/M" value="' + (tp.inputYuanPerMillion !== undefined && tp.inputYuanPerMillion !== null ? tp.inputYuanPerMillion : "") + '">'
          + '<input class="wc-cell-input wc-small" data-field="tokenOut" type="number" min="0" step="0.01" placeholder="出 元/M" value="' + (tp.outputYuanPerMillion !== undefined && tp.outputYuanPerMillion !== null ? tp.outputYuanPerMillion : "") + '">'
          + "</div>";
      } else {
        priceCell = '<input class="wc-cell-input" data-field="price" type="number" min="0" step="0.001" placeholder="不改" value="' + (tp.yuan !== undefined && tp.yuan !== null ? tp.yuan : "") + '">';
      }
      var health = m.healthSuccessRate === null || m.healthSuccessRate === undefined
        ? '<span class="wc-sub">—</span>'
        : (function () {
            var pct = Math.round(m.healthSuccessRate * 100);
            var cls = pct >= 90 ? "wc-ok" : pct >= 70 ? "wc-warn" : "wc-bad";
            return '<span class="' + cls + '">' + pct + '%</span> <span class="wc-sub">(' + m.healthSamples + ")</span>";
          })();
      return '<tr data-id="' + esc(m.id) + '"' + (o.hidden === true ? ' class="wc-row-off"' : "") + ">"
        + '<td class="wc-wide"><code>' + esc(m.id) + "</code>"
        + '<div class="wc-sub">' + esc(o.displayName || m.label)
        + (o.zone === "promo" ? '<span class="wc-badge promo">特惠</span>' : "")
        + (m.listed === false ? '<span class="wc-badge info">兼容项</span>' : "")
        + (o.hidden === true ? '<span class="wc-badge off">已下架</span>' : "") + "</div></td>"
        + "<td>" + esc(m.modality) + " · " + esc(m.unit) + "</td>"
        + "<td>" + health + "</td>"
        + "<td>" + esc(upstreamPrice(m))
        + (o.price ? ' <span class="wc-badge info" title="自定义价已生效，上游价仅供参考">已改价</span>' : "") + "</td>"
        + "<td>" + priceCell + "</td>"
        + '<td><select class="wc-cell-input" data-field="zone" title="特惠区：随时可能下架、不保证可用性与成功率">'
        + '<option value=""' + (o.zone !== "promo" ? " selected" : "") + ">稳定主推</option>"
        + '<option value="promo"' + (o.zone === "promo" ? " selected" : "") + ">特惠</option></select></td>"
        + '<td class="wc-name-input"><input class="wc-cell-input" data-field="displayName" type="text" maxlength="60" placeholder="不改名" title="站内显示名；留空沿用上游名称" value="' + esc(o.displayName || "") + '">'
        + '<input class="wc-cell-input" data-field="description" type="text" maxlength="400" placeholder="不改简介" title="站内简介；留空沿用上游描述" value="' + esc(o.description || "") + '"></td>'
        + '<td><input data-field="visible" type="checkbox"' + (o.hidden === true ? "" : " checked") + "></td>"
        + "</tr>";
    }).join("");
  }
  function parse(v) { var n = Number(v); return isFinite(n) && n >= 0 && v !== "" ? n : null; }
  function saveModels() {
    var models = {};
    var trs = $("modelRows").querySelectorAll("tr[data-id]");
    for (var i = 0; i < trs.length; i++) {
      var tr = trs[i];
      var id = tr.getAttribute("data-id");
      var entry = {};
      var visibleEl = tr.querySelector("[data-field=visible]");
      if (visibleEl && !visibleEl.checked) entry.hidden = true;
      var zoneEl = tr.querySelector("[data-field=zone]");
      if (zoneEl && zoneEl.value === "promo") entry.zone = "promo";
      var nameEl = tr.querySelector("[data-field=displayName]");
      if (nameEl && nameEl.value.replace(/^\\s+|\\s+$/g, "")) entry.displayName = nameEl.value.replace(/^\\s+|\\s+$/g, "");
      var descEl = tr.querySelector("[data-field=description]");
      if (descEl && descEl.value.replace(/^\\s+|\\s+$/g, "")) entry.description = descEl.value.replace(/^\\s+|\\s+$/g, "");
      var priceIn = tr.querySelector("[data-field=price]");
      if (priceIn) { var y = parse(priceIn.value); if (y !== null) entry.price = { yuan: y }; }
      var tIn = tr.querySelector("[data-field=tokenIn]");
      var tOut = tr.querySelector("[data-field=tokenOut]");
      if (tIn || tOut) {
        var inV = tIn ? parse(tIn.value) : null;
        var outV = tOut ? parse(tOut.value) : null;
        if (inV !== null || outV !== null) {
          entry.price = {};
          if (inV !== null) entry.price.inputYuanPerMillion = inV;
          if (outV !== null) entry.price.outputYuanPerMillion = outV;
        }
      }
      if (entry.hidden || entry.zone || entry.displayName || entry.description || entry.price) models[id] = entry;
    }
    $("save").disabled = true;
    $("saveMsg").textContent = "保存中…"; $("saveMsg").className = "wc-sub";
    api("PUT", "/api/v1/admin/model-overrides", { models: models }, function (data) {
      state.overrides = data.overrides;
      $("save").disabled = false;
      $("saveMsg").textContent = "已保存，目录版本号自动轮转，报价与选择器即时生效";
      $("saveMsg").className = "wc-sub wc-ok";
      renderModels();
    }, function (e) {
      $("save").disabled = false;
      $("saveMsg").textContent = "保存失败：" + e; $("saveMsg").className = "wc-sub wc-bad";
    });
  }

  /* ---------- 分区与加载 ---------- */
  function showTab(t) {
    state.tab = t;
    for (var i = 0; i < TABS.length; i++) {
      $("tab-" + TABS[i]).className = "wc-tab" + (t === TABS[i] ? " on" : "");
      $("page-" + TABS[i]).hidden = t !== TABS[i];
    }
    if (t === "users" && !state.users && secret()) loadUsers();
  }
  function load() {
    if (!secret()) { msg("先输入运营密钥", "err"); return; }
    sessionStorage.setItem(SECRET_KEY, secret());
    msg("加载中…");
    $("load").textContent = "刷新";
    loadOverview();
    loadJobs();
    state.users = null;
    if (state.tab === "users") loadUsers();
    api("GET", "/api/v1/admin/model-overrides", null, function (data) {
      state.models = data.models; state.overrides = data.overrides;
      renderModels();
      if (!state.loaded) { state.loaded = true; setInterval(function () {
        api("GET", "/api/v1/admin/ops/overview", null, function (d) { renderOverview(d); }, function () {});
      }, 60000); }
    }, function (e) { msg("模型列表加载失败：" + e, "err"); });
  }
  $("secret").value = sessionStorage.getItem(SECRET_KEY) || "";
  $("load").onclick = load;
  $("tab-overview").onclick = function () { showTab("overview"); };
  $("tab-users").onclick = function () { showTab("users"); };
  $("tab-jobs").onclick = function () { showTab("jobs"); };
  $("tab-models").onclick = function () { showTab("models"); };
  $("userSearch").onclick = loadUsers;
  $("userQuery").onkeydown = function (event) { if (event.keyCode === 13) loadUsers(); };
  $("save").onclick = saveModels;
  $("search").oninput = renderModels;
  $("modality").onchange = renderModels;
  $("onlyHidden").onchange = renderModels;
  $("onlyPromo").onchange = renderModels;
  function setFilter(f) {
    if (state.filter === f) return;
    state.filter = f;
    $("failed").className = "wc-btn" + (f === "failed" ? " on" : "");
    $("all").className = "wc-btn" + (f === "all" ? " on" : "");
    loadJobs();
  }
  $("failed").onclick = function () { setFilter("failed"); };
  $("all").onclick = function () { setFilter("all"); };
})();
</script>
</body>
</html>`;
