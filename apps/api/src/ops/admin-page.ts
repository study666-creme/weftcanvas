/**
 * 画布运营后台：监控 + 模型运营 + 任务排查三页合一的控制台。
 * 模型页与「画布模型上架与定价」页同源同接口（GET/PUT /api/v1/admin/model-overrides），
 * 上下架、排序、零售价（固定/分档/token 双费率）、稳定/特惠分区、显示名与简介
 * 覆盖都在这里完成；概览与任务页走 /api/v1/admin/ops/*。两把密钥共用一个输入框：
 * 请求同时带 x-canvas-ops-secret 与 x-model-overrides-secret（server 侧 ops 缺省
 * 回落到模型密钥，一把通两页）。
 * 兼容性：脚本 ES5 + XMLHttpRequest，CSS 不用新特性；窄屏卡片换行、表格横向滚动。
 */
export const CANVAS_OPS_ADMIN_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>画布运营后台</title>
<style>
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 26px 26px 60px; background: #0f1110; color: #e6e9e6;
  font: 13px/1.6 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 1200px; margin: 0 auto; }
.head { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; }
h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: .02em; }
.sub { color: #767d76; font-size: 12px; }
.bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 18px 0 6px; }
input, button, select {
  font: inherit; color: #dfe3df; background: #171a18; border: 1px solid #2a2e2c;
  border-radius: 6px; padding: 6px 10px;
}
button { cursor: pointer; transition: border-color 120ms ease, color 120ms ease; }
button:hover:not(:disabled) { border-color: #57b98a; color: #fff; }
button:disabled { opacity: .45; cursor: default; }
button.on { border-color: #57b98a; color: #57b98a; }
#secret { width: 200px; }
#msg { color: #767d76; font-size: 12px; }
#msg.err { color: #d0796f; } #msg.ok { color: #57b98a; }
.tabs { display: flex; gap: 4px; margin: 10px 0 20px; border-bottom: 1px solid #222623; }
.tabs button {
  border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none;
  padding: 8px 14px; color: #767d76;
}
.tabs button.on { color: #e6e9e6; border-bottom-color: #57b98a; }
h2 { margin: 24px 0 10px; font-size: 13px; font-weight: 600; color: #a7ada7; letter-spacing: .04em; }
.cards { display: flex; flex-wrap: wrap; gap: 10px; }
.card { flex: 1 1 140px; min-width: 140px; padding: 12px 14px; background: #161917; border: 1px solid #222623; border-radius: 8px; }
.card small { display: block; color: #767d76; font-size: 11px; }
.card b { display: block; margin-top: 3px; font-size: 21px; font-weight: 600; font-variant-numeric: tabular-nums; }
.card em { display: block; margin-top: 2px; font-size: 11px; font-style: normal; color: #767d76; }
.ok { color: #57b98a; } .warn { color: #c7a45f; } .bad { color: #d0796f; }
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 7px 9px; text-align: left; border-bottom: 1px solid #1e2220; white-space: nowrap; vertical-align: middle; }
th { color: #767d76; font-weight: 500; font-size: 11px; }
td { font-variant-numeric: tabular-nums; }
td.wide { white-space: normal; word-break: break-all; min-width: 150px; }
code { font: 11.5px/1.5 ui-monospace, Consolas, monospace; color: #b9c2b9; }
.meter { display: inline-block; width: 64px; height: 4px; margin-right: 8px; vertical-align: middle; background: #242826; border-radius: 2px; overflow: hidden; }
.meter i { display: block; height: 100%; background: currentColor; border-radius: 2px; }
.badge { display: inline-block; padding: 1px 7px; margin-left: 6px; border: 1px solid #34383d; border-radius: 999px; font-size: 11px; color: #9aa2a0; }
.badge.promo { border-color: #8a6a2f; color: #e0b25f; }
.badge.off { border-color: #7a3f3a; color: #d0796f; }
.empty { padding: 14px 2px; color: #767d76; font-size: 12px; }
.filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
.filters input[type=text] { flex: 1; min-width: 160px; }
.filters label { color: #767d76; font-size: 12px; }
.cell-input { width: 100%; min-width: 90px; padding: 4px 8px; font-size: 12px; }
.cell-input.small { min-width: 70px; width: 80px; }
.tokenpair { display: flex; gap: 4px; }
.hidden-row td { opacity: .45; }
[hidden] { display: none !important; }
@media (max-width: 640px) {
  body { padding: 16px 12px 40px; }
  .card { flex-basis: calc(50% - 10px); min-width: 0; }
}
</style>
</head>
<body>
<main>
  <div class="head">
    <h1>画布运营后台</h1>
    <span class="sub">监控 · 模型运营 · 任务排查</span>
  </div>
  <div class="bar">
    <input id="secret" type="password" placeholder="运营密钥" autocomplete="off">
    <button id="load" type="button">加载</button>
    <span id="msg"></span>
  </div>
  <nav class="tabs" aria-label="后台分区">
    <button id="tab-overview" class="on" type="button">概览</button>
    <button id="tab-models" type="button">模型运营</button>
    <button id="tab-jobs" type="button">任务</button>
  </nav>

  <section id="page-overview">
    <div class="cards" id="cards"></div>
    <h2>模型成功率 · 近 7 天真实任务</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>模型</th><th>成功率</th><th>样本</th></tr></thead>
      <tbody id="health"></tbody>
    </table></div>
  </section>

  <section id="page-models" hidden>
    <div class="filters">
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
      <button id="save" type="button">保存修改</button>
      <span id="saveMsg" class="sub"></span>
    </div>
    <div class="tablewrap"><table>
      <thead><tr>
        <th>模型</th><th>类型</th><th>成功率(7天)</th><th>当前价</th><th>自定义价（元）</th>
        <th>分区</th><th>显示名 / 简介</th><th>展示</th>
      </tr></thead>
      <tbody id="modelRows"></tbody>
    </table></div>
  </section>

  <section id="page-jobs" hidden>
    <div class="filters">
      <button id="failed" class="on" type="button">失败</button>
      <button id="all" type="button">全部</button>
    </div>
    <div class="tablewrap"><table>
      <thead><tr><th>任务</th><th>用户</th><th>模型</th><th>状态</th><th>错误</th><th>更新时间</th></tr></thead>
      <tbody id="jobs"></tbody>
    </table></div>
  </section>
</main>
<script>
(function () {
  var SECRET_KEY = "canvas_ops_admin_secret_v1";
  var state = {
    tab: "overview", filter: "failed", loaded: false,
    overview: null, models: null, overrides: null,
  };
  function $(id) { return document.getElementById(id); }
  function secret() { return $("secret").value.replace(/^\\s+|\\s+$/g, ""); }
  function msg(t, cls) { var el = $("msg"); el.textContent = t; el.className = cls || ""; }
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
  function api(method, path, body, done, fail) {
    var xhr = new XMLHttpRequest();
    xhr.open(method, path, true);
    xhr.setRequestHeader("x-canvas-ops-secret", secret());
    xhr.setRequestHeader("x-model-overrides-secret", secret());
    if (body) xhr.setRequestHeader("content-type", "application/json");
    xhr.timeout = 15000;
    xhr.onload = function () {
      if (xhr.status >= 200 && xhr.status < 300) { done(JSON.parse(xhr.responseText).data); }
      else { fail("HTTP " + xhr.status); }
    };
    xhr.onerror = function () { fail("网络错误"); };
    xhr.ontimeout = function () { fail("请求超时"); };
    xhr.send(body ? JSON.stringify(body) : null);
  }
  function card(label, value, cls, sub) {
    return '<div class="card"><small>' + esc(label) + "</small>"
      + "<b" + (cls ? ' class="' + cls + '"' : "") + ">" + esc(value) + "</b>"
      + (sub ? "<em>" + esc(sub) + "</em>" : "") + "</div>";
  }
  function renderOverview(d) {
    var terminal = d.jobs.completed + d.jobs.failed;
    var rate = terminal ? Math.round((d.jobs.failed / terminal) * 100) : -1;
    var catalogOk = d.catalog.version && d.catalog.quoteAvailable;
    $("cards").innerHTML =
      card("用户", d.users) +
      card("云项目", d.projects) +
      card("云端素材", d.media.count, "", bytes(d.media.bytes)) +
      card("任务 · 24h", terminal, "", "成功 " + d.jobs.completed + " · 失败 " + d.jobs.failed) +
      card("失败率", rate < 0 ? "—" : rate + "%", rate < 0 ? "" : rate > 30 ? "bad" : rate > 10 ? "warn" : "ok") +
      card("在途", d.jobs.inFlight, d.jobs.staleInFlight > 0 ? "bad" : "",
        d.jobs.staleInFlight > 0 ? d.jobs.staleInFlight + " 个超 30 分钟" : "") +
      card("模型目录", catalogOk ? "正常" : "不可用", catalogOk ? "ok" : "bad",
        d.catalog.version ? "v" + String(d.catalog.version).substring(0, 10) : "");
    var health = d.modelHealth || [];
    $("health").innerHTML = health.length ? health.map(function (m) {
      var pct = Math.round(m.successRate * 100);
      var cls = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
      return "<tr><td class=wide><code>" + esc(m.modelId) + "</code></td>"
        + '<td class="' + cls + '"><span class="meter"><i style="width:' + pct + '%"></i></span>' + pct + "%</td>"
        + "<td>" + m.sampleCount + "</td></tr>";
    }).join("") : '<tr><td colspan="3" class="empty">暂无足够样本的模型（近 7 天 ≥5 次终态任务才统计）</td></tr>';
  }
  function currentPrice(m) {
    if (m.pricingMode === "token") {
      return "入 ¥" + (m.inputYuanPerMillion === null ? "—" : m.inputYuanPerMillion) + "/M · 出 ¥"
        + (m.outputYuanPerMillion === null ? "—" : m.outputYuanPerMillion) + "/M";
    }
    if (m.byResolution) {
      var keys = []; for (var k in m.byResolution) { if (m.byResolution.hasOwnProperty(k)) keys.push(k); }
      return keys.sort().map(function (r) { return r.toUpperCase() + " " + m.byResolution[r]; }).join(" / ");
    }
    if (m.yuan !== null) return m.yuan + " 元";
    if (m.baseYuan !== null) return m.baseYuan + " 元";
    return "—";
  }
  function overrideOf(id) {
    return (state.overrides && state.overrides.models && state.overrides.models[id]) || {};
  }
  function renderModels() {
    if (!state.models) { $("modelRows").innerHTML = '<tr><td colspan="8" class="empty">点「加载」拉取模型目录</td></tr>'; return; }
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
    if (!rows.length) { $("modelRows").innerHTML = '<tr><td colspan="8" class="empty">没有匹配的模型</td></tr>'; return; }
    $("modelRows").innerHTML = rows.map(function (m) {
      var o = overrideOf(m.id);
      var priceCell;
      var tp = o.price || {};
      if (m.pricingMode === "token") {
        priceCell = '<div class="tokenpair">'
          + '<input class="cell-input" data-field="tokenIn" type="number" min="0" step="0.01" placeholder="入 元/M" value="' + (tp.inputYuanPerMillion !== undefined && tp.inputYuanPerMillion !== null ? tp.inputYuanPerMillion : "") + '">'
          + '<input class="cell-input" data-field="tokenOut" type="number" min="0" step="0.01" placeholder="出 元/M" value="' + (tp.outputYuanPerMillion !== undefined && tp.outputYuanPerMillion !== null ? tp.outputYuanPerMillion : "") + '">'
          + "</div>";
      } else {
        priceCell = '<input class="cell-input" data-field="price" type="number" min="0" step="0.001" placeholder="不改" value="' + (tp.yuan !== undefined && tp.yuan !== null ? tp.yuan : "") + '">';
      }
      var health = m.healthSuccessRate === null || m.healthSuccessRate === undefined
        ? '<span class="sub">—</span>'
        : (function () {
            var pct = Math.round(m.healthSuccessRate * 100);
            var cls = pct >= 90 ? "ok" : pct >= 70 ? "warn" : "bad";
            return '<span class="' + cls + '">' + pct + '%</span> <span class="sub">(' + m.healthSamples + ")</span>";
          })();
      return '<tr data-id="' + esc(m.id) + '"' + (o.hidden === true ? ' class="hidden-row"' : "") + ">"
        + '<td class="wide"><code>' + esc(m.id) + "</code>"
        + '<div class="sub">' + esc(o.displayName || m.label)
        + (o.zone === "promo" ? '<span class="badge promo">特惠</span>' : "")
        + (m.listed === false ? '<span class="badge">兼容项</span>' : "")
        + (o.hidden === true ? '<span class="badge off">已下架</span>' : "") + "</div></td>"
        + "<td>" + esc(m.modality) + " · " + esc(m.unit) + "</td>"
        + "<td>" + health + "</td>"
        + "<td>" + esc(currentPrice(m)) + (o.price && o.price.byResolution ? ' <span class="badge">分档</span>' : "") + "</td>"
        + "<td>" + priceCell + "</td>"
        + '<td><select class="cell-input" data-field="zone" title="特惠区：随时可能下架、不保证可用性与成功率">'
        + '<option value=""' + (o.zone !== "promo" ? " selected" : "") + ">稳定主推</option>"
        + '<option value="promo"' + (o.zone === "promo" ? " selected" : "") + ">特惠</option></select></td>"
        + '<td style="min-width:220px"><input class="cell-input" data-field="displayName" type="text" maxlength="60" placeholder="不改名" title="站内显示名；留空沿用上游名称" value="' + esc(o.displayName || "") + '">'
        + '<input class="cell-input" data-field="description" type="text" maxlength="400" placeholder="不改简介" title="站内简介；留空沿用上游描述" value="' + esc(o.description || "") + '"></td>'
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
    $("saveMsg").textContent = "保存中…"; $("saveMsg").className = "sub";
    api("PUT", "/api/v1/admin/model-overrides", { models: models }, function (data) {
      state.overrides = data.overrides;
      $("save").disabled = false;
      $("saveMsg").textContent = "已保存，目录版本号自动轮转，报价与选择器即时生效";
      $("saveMsg").className = "ok";
      renderModels();
    }, function (e) {
      $("save").disabled = false;
      $("saveMsg").textContent = "保存失败：" + e; $("saveMsg").className = "bad";
    });
  }
  function renderJobs(jobs) {
    $("jobs").innerHTML = jobs.length ? jobs.map(function (j) {
      var cls = j.status === "failed" ? "bad" : j.status === "completed" ? "ok" : "warn";
      return "<tr><td><code>" + esc(j.id.substring(0, 8)) + "</code></td>"
        + "<td><code>" + esc(j.ownerId.substring(0, 8)) + "</code></td>"
        + '<td class="wide"><code>' + esc(j.modelId) + "</code></td>"
        + '<td class="' + cls + '">' + esc(j.status) + "</td>"
        + "<td>" + esc(j.errorCode || "—") + "</td>"
        + "<td>" + esc(new Date(j.updatedAt).toLocaleString("zh-CN")) + "</td></tr>";
    }).join("") : '<tr><td colspan="6" class="empty">没有匹配的任务</td></tr>';
  }
  function showTab(t) {
    state.tab = t;
    var names = ["overview", "models", "jobs"];
    for (var i = 0; i < names.length; i++) {
      $("tab-" + names[i]).className = t === names[i] ? "on" : "";
      $("page-" + names[i]).hidden = t !== names[i];
    }
  }
  function load() {
    if (!secret()) { msg("先输入运营密钥", "err"); return; }
    sessionStorage.setItem(SECRET_KEY, secret());
    msg("加载中…");
    api("GET", "/api/v1/admin/ops/overview", null, function (d) {
      state.overview = d; renderOverview(d);
      msg("更新于 " + new Date().toLocaleTimeString("zh-CN"));
    }, function (e) { msg("概览加载失败：" + e, "err"); });
    api("GET", "/api/v1/admin/ops/jobs?status=" + state.filter + "&limit=20", null, function (part) {
      renderJobs(part.jobs);
    }, function () {});
    api("GET", "/api/v1/admin/model-overrides", null, function (data) {
      state.models = data.models; state.overrides = data.overrides;
      renderModels();
      if (!state.loaded) { state.loaded = true; setInterval(function () {
        api("GET", "/api/v1/admin/ops/overview", null, function (d) { state.overview = d; renderOverview(d); }, function () {});
      }, 60000); }
    }, function (e) { msg("模型列表加载失败：" + e, "err"); });
  }
  $("secret").value = sessionStorage.getItem(SECRET_KEY) || "";
  $("load").onclick = load;
  $("tab-overview").onclick = function () { showTab("overview"); };
  $("tab-models").onclick = function () { showTab("models"); };
  $("tab-jobs").onclick = function () { showTab("jobs"); };
  $("save").onclick = saveModels;
  $("search").oninput = renderModels;
  $("modality").onchange = renderModels;
  $("onlyHidden").onchange = renderModels;
  $("onlyPromo").onchange = renderModels;
  function setFilter(f) {
    if (state.filter === f) return;
    state.filter = f;
    $("failed").className = f === "failed" ? "on" : "";
    $("all").className = f === "all" ? "on" : "";
    if (!secret()) return;
    api("GET", "/api/v1/admin/ops/jobs?status=" + f + "&limit=20", null, function (part) {
      renderJobs(part.jobs);
    }, function (e) { msg("加载失败：" + e, "err"); });
  }
  $("failed").onclick = function () { setFilter("failed"); };
  $("all").onclick = function () { setFilter("all"); };
})();
</script>
</body>
</html>`;
