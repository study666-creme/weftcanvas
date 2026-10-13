/**
 * 画布运营后台：总览（用户/项目/素材/任务/目录新鲜度）、模型成功率、
 * 近期任务。自包含单页，密钥与「画布模型上架与定价」页同一把（server 侧
 * CANVAS_OPS_ADMIN_SECRET 缺省回落到 MODEL_OVERRIDES_ADMIN_SECRET）。
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
body { margin: 0; padding: 20px 24px 40px; background: #101211; color: #e7eae7;
  font: 13px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; }
h1 { margin: 0 0 4px; font-size: 17px; }
.muted { color: #7d8684; font-size: 12px; }
.bar { display: flex; gap: 8px; align-items: center; margin: 14px 0 18px; flex-wrap: wrap; }
input, button, select { font: inherit; color: inherit; background: #1a1d1c; border: 1px solid #34383d;
  border-radius: 6px; padding: 5px 10px; }
button { cursor: pointer; }
button:hover:not(:disabled) { border-color: #57b98a; }
button:disabled { opacity: .5; cursor: default; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
.card { padding: 10px 12px; background: #171a19; border: 1px solid #26292b; border-radius: 8px; }
.card b { display: block; font-size: 19px; margin-top: 2px; }
.card small { color: #7d8684; }
.state-ok { color: #57b98a; } .state-warn { color: #e0b25f; } .state-bad { color: #e07a6f; }
table { width: 100%; border-collapse: collapse; margin-bottom: 22px; }
th, td { padding: 6px 8px; text-align: left; border-bottom: 1px solid #26292b; }
th { color: #9aa2a0; font-weight: 500; font-size: 12px; }
td code { font-size: 11px; color: #b9c4bd; word-break: break-all; }
.badge { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; border: 1px solid #34383d; }
.badge-failed { border-color: #7a3f3a; color: #e07a6f; }
.badge-ok { border-color: #2f5c46; color: #57b98a; }
h2 { font-size: 14px; margin: 22px 0 8px; }
#msg { font-size: 12px; } #msg.ok { color: #57b98a; } #msg.err { color: #e07a6f; }
</style>
</head>
<body>
<h1>画布运营后台</h1>
<p class="muted">只读监控：用户 / 项目 / 素材 / 生成任务 / 目录新鲜度 / 模型成功率。改价与上下架在「画布模型上架与定价」页。</p>
<div class="bar">
  <input id="secret" type="password" placeholder="运营密钥" style="width:220px">
  <button id="load">加载</button>
  <select id="jobFilter">
    <option value="failed">近期失败任务</option>
    <option value="all">近期全部任务</option>
  </select>
  <span id="msg" class="muted"></span>
</div>
<div class="cards" id="cards"></div>
<h2>模型成功率（近 7 天真实任务）</h2>
<table><thead><tr><th>模型</th><th>成功率</th><th>样本数</th></tr></thead><tbody id="healthRows"></tbody></table>
<h2>近期任务</h2>
<table><thead><tr><th>任务</th><th>用户</th><th>模型</th><th>类型</th><th>状态</th><th>错误</th><th>更新时间</th></tr></thead><tbody id="jobRows"></tbody></table>
<script>
(function () {
  var SECRET_KEY = 'canvas_ops_admin_secret_v1';
  var $ = function (id) { return document.getElementById(id); };
  $('secret').value = sessionStorage.getItem(SECRET_KEY) || '';
  function secret() { return $('secret').value.trim(); }
  function setMsg(t, ok) { var el = $('msg'); el.textContent = t || ''; el.className = t ? (ok ? 'ok' : 'err') : ''; }
  function esc(v) { return String(v === null || v === undefined ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtBytes(n) { if (!Number.isFinite(n) || n <= 0) return '0 B';
    var u = ['B','KB','MB','GB','TB'], i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), 4);
    return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i]; }
  function headers() { return { 'x-canvas-ops-secret': secret() }; }
  function card(label, value, cls, sub) {
    return '<div class="card"><small>' + esc(label) + '</small><b class="' + (cls || '') + '">' + esc(value) + '</b>'
      + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  }
  function load() {
    if (!secret()) { setMsg('先输入运营密钥', false); return; }
    sessionStorage.setItem(SECRET_KEY, secret());
    setMsg('加载中…');
    Promise.all([
      fetch('/api/v1/admin/ops/overview', { headers: headers(), cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); }),
      fetch('/api/v1/admin/ops/jobs?status=' + $('jobFilter').value + '&limit=50', { headers: headers(), cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
    ]).then(function (parts) {
      render(parts[0].data, parts[1].data.jobs);
      setMsg('更新于 ' + new Date().toLocaleTimeString(), true);
    }).catch(function (e) { setMsg('加载失败：' + e, false); });
  }
  function render(d, jobs) {
    var terminal = d.jobs.completed + d.jobs.failed;
    var rate = terminal ? Math.round(d.jobs.failed / terminal * 100) : null;
    var catalogOk = d.catalog.version && d.catalog.quoteAvailable;
    var cards = [
      card('用户', d.users),
      card('云项目', d.projects),
      card('素材', d.media.count, '', fmtBytes(d.media.bytes)),
      card('任务 · 近' + d.windowHours + '小时', terminal, '', '成功 ' + d.jobs.completed + ' / 失败 ' + d.jobs.failed),
      card('失败率', rate === null ? '—' : rate + '%', rate === null ? '' : rate > 30 ? 'state-bad' : rate > 10 ? 'state-warn' : 'state-ok'),
      card('在途任务', d.jobs.inFlight, d.jobs.staleInFlight > 0 ? 'state-bad' : '', d.jobs.staleInFlight > 0 ? d.jobs.staleInFlight + ' 个超 30 分钟未推进' : ''),
      card('目录', catalogOk ? '正常' : '不可用', catalogOk ? 'state-ok' : 'state-bad', d.catalog.version ? 'v' + String(d.catalog.version).slice(0, 10) : '')
    ];
    $('cards').innerHTML = cards.join('');
    $('healthRows').innerHTML = d.modelHealth.length ? d.modelHealth.map(function (m) {
      var pct = Math.round(m.successRate * 100);
      var cls = pct >= 90 ? 'state-ok' : pct >= 70 ? 'state-warn' : 'state-bad';
      return '<tr><td><code>' + esc(m.modelId) + '</code></td><td class="' + cls + '">' + pct + '%</td><td>' + m.sampleCount + '</td></tr>';
    }).join('') : '<tr><td colspan="3" class="muted">暂无足够样本的模型</td></tr>';
    $('jobRows').innerHTML = jobs.length ? jobs.map(function (j) {
      return '<tr><td><code>' + esc(j.id.slice(0, 8)) + '</code></td><td><code>' + esc(j.ownerId.slice(0, 8)) + '</code></td>'
        + '<td><code>' + esc(j.modelId) + '</code></td><td>' + esc(j.modality) + '</td>'
        + '<td><span class="badge ' + (j.status === 'failed' ? 'badge-failed' : j.status === 'completed' ? 'badge-ok' : '') + '">' + esc(j.status) + '</span></td>'
        + '<td>' + esc(j.errorCode || '—') + '</td><td class="muted">' + esc(new Date(j.updatedAt).toLocaleString('zh-CN')) + '</td></tr>';
    }).join('') : '<tr><td colspan="7" class="muted">没有匹配的任务</td></tr>';
  }
  $('load').addEventListener('click', load);
  $('jobFilter').addEventListener('change', load);
})();
</script>
</body>
</html>`;
