/**
 * 画布后台的共享视觉层。
 *
 * 后台页是 API 内嵌的单文件 HTML（无构建步骤、ES5 脚本），但观感必须和画布
 * （apps/web）一致，所以这里把画布的石墨设计 token 原样搬过来，不引入任何
 * 画布组件：
 *   - 亮色 = 石墨（`:root` 默认），暗色 = 墨黑（`[data-theme="dark"]`），
 *     两套值与 `apps/web/src/styles.css` 同源；
 *   - 几何：6-8px 圆角、1px 描边撑层级、阴影只留给浮动层；
 *   - 字体：系统栈 + 13px + 零字距（画布明确禁止 letter-spacing）；
 *   - 强调色是单色（亮色近黑 #1a1a1a / 暗色近白 #f2f2f2），语义色只做安静
 *     的次级线索——后台不能出现画布早已弃用的绿色高亮块；
 *   - 手感对齐画布：hover/按压 100-160ms、按压只染不闪白、聚焦环只在键盘
 *     导航出现（`:focus-visible`）、`prefers-reduced-motion` 下关过渡。
 *
 * 约束（与页面注释一致）：CSS 只用自定义属性与基础 flex，不用 `:has`、
 * 容器查询等新特性；脚本 ES5，用 XMLHttpRequest。
 */

/** 画布后台配色 token + 基础组件样式。两页共用，保证两个后台表面观感一致。 */
export const ADMIN_THEME_CSS = `
:root {
  color-scheme: light;
  --wc-canvas: #e7e8e5;
  --wc-surface: #f4f5f2;
  --wc-surface-raised: #fbfcfa;
  --wc-surface-muted: #eceeeb;
  --wc-surface-strong: #dfe2de;
  --wc-text: #202422;
  --wc-text-secondary: #626864;
  --wc-text-tertiary: #898e8b;
  --wc-border: #ccd1cd;
  --wc-border-strong: #abb2ad;
  --wc-accent: #1a1a1a;
  --wc-accent-hover: #000000;
  --wc-accent-soft: #e8e8e8;
  --wc-on-accent: #f7fbf9;
  --wc-success: #2d806a;
  --wc-success-soft: #dff0e8;
  --wc-blue: #4777a8;
  --wc-blue-soft: #e3edf5;
  --wc-amber: #ad7a25;
  --wc-amber-soft: #f3ecd9;
  --wc-danger: #bb4b43;
  --wc-danger-soft: #f6e7e5;
  --wc-shadow-float: 0 0 0 1px rgb(31 37 34 / 7%), 0 8px 20px rgb(25 33 30 / 12%);
  --wc-radius: 8px;
  --wc-radius-sm: 6px;
  --wc-topbar-height: 52px;
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --wc-canvas: #141414;
  --wc-surface: #1c1c1c;
  --wc-surface-raised: #242424;
  --wc-surface-muted: #171717;
  --wc-surface-strong: #2e2e2e;
  --wc-text: #f0f0f0;
  --wc-text-secondary: #b8b8b8;
  --wc-text-tertiary: #757575;
  --wc-border: #2a2a2a;
  --wc-border-strong: #4a4a4a;
  --wc-accent: #f2f2f2;
  --wc-accent-hover: #ffffff;
  --wc-accent-soft: #2a2a2a;
  /* 暗色强调色是近白，实底按钮必须配深色前景，否则变成白底白字。 */
  --wc-on-accent: #141414;
  --wc-success: #75aa91;
  --wc-success-soft: #1b3027;
  --wc-blue: #86abc5;
  --wc-blue-soft: #1d2b34;
  --wc-amber: #c7a45f;
  --wc-amber-soft: #30291d;
  --wc-danger: #ff6e68;
  --wc-danger-soft: #382121;
  --wc-shadow-float: 0 0 0 1px rgb(255 255 255 / 6%), 0 8px 28px rgb(0 0 0 / 40%);
}

* { box-sizing: border-box; }
html, body { margin: 0; }
body {
  background: var(--wc-canvas);
  color: var(--wc-text);
  font: 13px/1.6 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "PingFang SC",
    "Microsoft YaHei", sans-serif;
  letter-spacing: 0;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
a { color: var(--wc-text); }

/* 顶栏：吸顶、1px 底边撑层级，不用阴影。 */
.wc-topbar {
  position: sticky;
  top: 0;
  z-index: 5;
  background: var(--wc-surface);
  border-bottom: 1px solid var(--wc-border);
}
.wc-topbar-inner {
  display: flex;
  align-items: center;
  gap: 8px 12px;
  flex-wrap: wrap;
  max-width: 1280px;
  margin: 0 auto;
  padding: 9px 24px;
}
.wc-brand { display: flex; align-items: baseline; gap: 10px; margin-right: auto; min-width: 0; }
.wc-brand h1 { margin: 0; font-size: 15px; font-weight: 600; }
.wc-topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.wc-admin-shell { max-width: 1280px; margin: 0 auto; padding: 0 24px 64px; }

/* 控件：安静的面板底 + 1px 描边；hover 只提描边、按压只染深，不闪白、不发光。 */
input, select, button, textarea {
  font: inherit;
  letter-spacing: 0;
  color: var(--wc-text);
  background: var(--wc-surface-raised);
  border: 1px solid var(--wc-border);
  border-radius: var(--wc-radius-sm);
  padding: 6px 9px;
}
input::placeholder, textarea::placeholder { color: var(--wc-text-tertiary); }
input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--wc-border-strong);
  box-shadow: 0 0 0 2px var(--wc-accent-soft);
}
button {
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}
button:hover:not(:disabled) { border-color: var(--wc-border-strong); }
button:active:not(:disabled) { background: var(--wc-surface-strong); }
button:focus { outline: none; }
button:focus-visible { outline: 1px solid var(--wc-accent); outline-offset: 1px; }
button:disabled { opacity: .5; cursor: default; }
button.wc-btn.on { background: var(--wc-accent-soft); border-color: var(--wc-border-strong); }
button.wc-btn-primary {
  background: var(--wc-accent);
  border-color: var(--wc-accent);
  color: var(--wc-on-accent);
}
button.wc-btn-primary:hover:not(:disabled) {
  background: var(--wc-accent-hover);
  border-color: var(--wc-accent-hover);
  color: var(--wc-on-accent);
}
button.wc-btn-primary:active:not(:disabled) { background: var(--wc-accent-hover); }

/* 配色切换：成套两格（石墨 / 墨黑），与画布方形分段同形。 */
.wc-seg {
  display: inline-flex;
  align-items: stretch;
  border: 1px solid var(--wc-border);
  border-radius: var(--wc-radius-sm);
  background: var(--wc-surface-raised);
  overflow: hidden;
}
.wc-seg button {
  border: 0;
  border-radius: 0;
  background: none;
  padding: 6px 10px;
  color: var(--wc-text-secondary);
}
.wc-seg button + button { border-left: 1px solid var(--wc-border); }
.wc-seg button:hover:not(:disabled) { color: var(--wc-text); background: var(--wc-surface-muted); }
.wc-seg button.on { background: var(--wc-accent-soft); color: var(--wc-text); }

/* 分区 tab：画布同款方形分段控件。 */
.wc-tabs { display: flex; gap: 6px; flex-wrap: wrap; padding: 16px 0 0; }
.wc-tab {
  border: 1px solid transparent;
  border-radius: var(--wc-radius-sm);
  background: none;
  padding: 6px 12px;
  color: var(--wc-text-secondary);
}
.wc-tab:hover:not(:disabled) { color: var(--wc-text); border-color: var(--wc-border); }
.wc-tab.on {
  background: var(--wc-surface-raised);
  border-color: var(--wc-border-strong);
  color: var(--wc-text);
}

.wc-h2 { margin: 22px 0 10px; font-size: 12px; font-weight: 600; color: var(--wc-text-secondary); }
.wc-sub { color: var(--wc-text-tertiary); font-size: 11.5px; }
.wc-msg { font-size: 12px; color: var(--wc-text-tertiary); min-width: 96px; }
.wc-msg.ok { color: var(--wc-success); }
.wc-msg.err { color: var(--wc-danger); }
.wc-ok { color: var(--wc-success); }
.wc-warn { color: var(--wc-amber); }
.wc-bad { color: var(--wc-danger); }

.wc-cards { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.wc-card {
  flex: 1 1 150px;
  min-width: 150px;
  padding: 11px 13px;
  background: var(--wc-surface);
  border: 1px solid var(--wc-border);
  border-radius: var(--wc-radius);
}
.wc-card small { display: block; color: var(--wc-text-tertiary); font-size: 11px; }
.wc-card b {
  display: block;
  margin-top: 2px;
  font-size: 20px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.wc-card em { display: block; margin-top: 2px; font-size: 11px; font-style: normal; color: var(--wc-text-tertiary); }

/* 表格：长表在面板内滚动，表头吸顶，横向不够时同样只滚面板。 */
.wc-tablewrap {
  max-height: calc(100vh - 252px);
  overflow: auto;
  border: 1px solid var(--wc-border);
  border-radius: var(--wc-radius);
  background: var(--wc-surface);
}
.wc-tablewrap input, .wc-tablewrap select { background: var(--wc-canvas); }
.wc-table { width: 100%; border-collapse: collapse; }
.wc-table th, .wc-table td {
  padding: 7px 10px;
  text-align: left;
  border-bottom: 1px solid var(--wc-border);
  white-space: nowrap;
  vertical-align: middle;
}
.wc-table thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--wc-surface);
  color: var(--wc-text-tertiary);
  font-size: 11px;
  font-weight: 500;
  /* border-collapse 下吸顶表头的下边框会跟着滚走，用内阴影钉住那条发丝线。 */
  box-shadow: inset 0 -1px 0 var(--wc-border);
}
.wc-table tbody tr:last-child td { border-bottom: 0; }
.wc-table td { font-variant-numeric: tabular-nums; }
.wc-table tbody tr:hover td { background: var(--wc-surface-muted); }
.wc-table td.wc-wide { white-space: normal; word-break: break-all; min-width: 170px; }
.wc-table code, code.wc-code {
  font: 11.5px/1.5 ui-monospace, "SF Mono", Consolas, monospace;
  color: var(--wc-text-secondary);
}
.wc-row-off td { opacity: .5; }
.wc-empty {
  padding: 26px 12px;
  color: var(--wc-text-tertiary);
  font-size: 12px;
  text-align: center;
}

.wc-meter {
  display: inline-block;
  width: 56px;
  height: 4px;
  margin-right: 8px;
  vertical-align: middle;
  background: var(--wc-surface-strong);
  border-radius: 2px;
  overflow: hidden;
}
.wc-meter i { display: block; height: 100%; background: currentColor; border-radius: 2px; }

/* 徽标：方形直角（与画布模型选择器的方形徽标一致），语义色走柔和底。 */
.wc-badge {
  display: inline-block;
  padding: 0 6px;
  margin-left: 6px;
  border: 1px solid var(--wc-border-strong);
  border-radius: 3px;
  font-size: 11px;
  line-height: 16px;
  color: var(--wc-text-secondary);
  vertical-align: middle;
  white-space: nowrap;
}
.wc-badge.on { background: var(--wc-success-soft); border-color: transparent; color: var(--wc-success); }
.wc-badge.off { background: var(--wc-danger-soft); border-color: transparent; color: var(--wc-danger); }
.wc-badge.promo { background: var(--wc-amber-soft); border-color: transparent; color: var(--wc-amber); }
.wc-badge.info { background: var(--wc-blue-soft); border-color: transparent; color: var(--wc-blue); }

.wc-filters { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 14px 0 10px; }
.wc-filters input[type=text] { flex: 1; min-width: 180px; }
.wc-filters label { color: var(--wc-text-tertiary); font-size: 12px; }
.wc-filters .wc-tail { display: flex; gap: 8px; align-items: center; margin-left: auto; }
.wc-cell-input { width: 100%; min-width: 90px; padding: 4px 8px; font-size: 12px; }
.wc-cell-input.wc-small { min-width: 70px; width: 82px; }
.wc-tokenpair { display: flex; gap: 4px; }
.wc-hint { color: var(--wc-text-tertiary); font-size: 12px; margin: 12px 0 0; max-width: 900px; }
[hidden] { display: none !important; }

/* 细滚动条（画布同款 thin），滚动面板与页面都不出现粗条。 */
.wc-tablewrap, .wc-scroll { scrollbar-width: thin; scrollbar-color: var(--wc-border-strong) transparent; }
.wc-tablewrap::-webkit-scrollbar, .wc-scroll::-webkit-scrollbar { width: 10px; height: 10px; }
.wc-tablewrap::-webkit-scrollbar-thumb, .wc-scroll::-webkit-scrollbar-thumb {
  background: var(--wc-border-strong);
  border: 3px solid transparent;
  border-radius: 4px;
  background-clip: content-box;
}
.wc-tablewrap::-webkit-scrollbar-corner, .wc-scroll::-webkit-scrollbar-corner { background: transparent; }

@media (max-width: 720px) {
  .wc-topbar-inner { padding: 8px 14px; }
  .wc-brand { flex-basis: 100%; margin-right: 0; }
  .wc-admin-shell { padding: 0 14px 48px; }
  .wc-card { flex-basis: calc(50% - 8px); min-width: 0; }
  .wc-filters input[type=text] { min-width: 120px; }
  .wc-filters .wc-tail { margin-left: 0; }
  .wc-tablewrap { max-height: calc(100vh - 300px); }
}

/* 画布明确尊重减少动效偏好：这类开关下后台不留过渡。 */
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0.01ms !important; animation-duration: 0.01ms !important; }
}
`;

/**
 * 主题引导脚本（ES5，放在 `<head>` 里避免首屏闪白/闪黑）。
 * 默认跟随系统；显式选择写入 localStorage 后长期生效。
 * 页面里带 `data-wc-theme-set="light|dark"` 的按钮组会被自动接上选中态与切换。
 */
export const ADMIN_THEME_BOOT_JS = `(function () {
  var KEY = "canvas_admin_theme_v1";
  function preferred() {
    try {
      var saved = localStorage.getItem(KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) {}
    try {
      if (window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
    } catch (e) {}
    return "dark";
  }
  function normalize(mode) { return mode === "light" ? "light" : "dark"; }
  function apply(mode) {
    document.documentElement.setAttribute("data-theme", normalize(mode));
  }
  apply(preferred());
  window.kcAdminTheme = {
    current: function () {
      return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
    },
    set: function (mode) {
      apply(mode);
      try { localStorage.setItem(KEY, normalize(mode)); } catch (e) {}
      var buttons = document.querySelectorAll("[data-wc-theme-set]");
      for (var i = 0; i < buttons.length; i++) {
        var want = buttons[i].getAttribute("data-wc-theme-set");
        buttons[i].className = want === normalize(mode) ? "on" : "";
        buttons[i].setAttribute("aria-pressed", want === normalize(mode) ? "true" : "false");
      }
    },
    toggle: function () { this.set(this.current() === "light" ? "dark" : "light"); }
  };
  document.addEventListener("DOMContentLoaded", function () {
    var buttons = document.querySelectorAll("[data-wc-theme-set]");
    for (var i = 0; i < buttons.length; i++) {
      (function (button) {
        button.onclick = function () { window.kcAdminTheme.set(button.getAttribute("data-wc-theme-set")); };
      })(buttons[i]);
    }
    window.kcAdminTheme.set(window.kcAdminTheme.current());
  });
})();`;
