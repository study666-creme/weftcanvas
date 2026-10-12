import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const previewAllowedHost = process.env.CANVAS_PREVIEW_ALLOWED_HOST;
const previewAllowsAnyHost = process.env.CANVAS_PREVIEW_ALLOW_ALL_HOSTS === "true";
const declaredCanvasSourceCommit = process.env.CANVAS_RELEASE_SOURCE_COMMIT?.trim();
const vercelCanvasSourceCommit = process.env.VERCEL_GIT_COMMIT_SHA?.trim();
if (
  declaredCanvasSourceCommit &&
  vercelCanvasSourceCommit &&
  declaredCanvasSourceCommit.toLowerCase() !== vercelCanvasSourceCommit.toLowerCase()
) {
  throw new Error("CANVAS_RELEASE_SOURCE_COMMIT does not match VERCEL_GIT_COMMIT_SHA");
}
const canvasBuildId =
  process.env.CANVAS_RELEASE_ID?.trim() ||
  (vercelCanvasSourceCommit?.slice(0, 12) || "local") + "-" + Date.now().toString(36);
const canvasSourceCommit = vercelCanvasSourceCommit || declaredCanvasSourceCommit || "local";

export default defineConfig(({ mode }) => {
  const localEnvironment = loadEnv(mode, "../../", "");
  const apiProxyTarget =
    process.env.CANVAS_API_PROXY_TARGET?.trim() ||
    localEnvironment.CANVAS_API_PROXY_TARGET?.trim() ||
    "http://127.0.0.1:8787";

  return {
    plugins: [
      react(),
      {
        name: "weftcanvas-build-marker",
        transformIndexHtml: {
          order: "pre",
          handler: () => [
            {
              tag: "meta",
              attrs: { name: "weftcanvas-build", content: canvasBuildId },
              injectTo: "head",
            },
            {
              tag: "meta",
              attrs: { name: "weftcanvas-source", content: canvasSourceCommit },
              injectTo: "head",
            },
          ],
        },
      },
      {
        // 入口 CSS 有 100KB+（压缩后），作为渲染阻塞资源时，连 index.html 里
        // 已经内联的启动屏都要等到它下载完才首绘（实测首绘从 ~950ms 拖到
        // ~1900ms）。改成 preload + 异步切换：启动屏立刻可见，React 挂载时
        // 样式通常已经到位（CSS 812ms 先于入口 JS 870ms 完成）。
        name: "weftcanvas-async-entry-css",
        transformIndexHtml: {
          order: "post",
          handler: (html) =>
            html.replace(
              /<link rel="stylesheet"([^>]*?)href="([^"]+)"([^>]*?)>/g,
              (_match, pre: string, href: string, post: string) => {
                const extra = `${pre}${post}`.replace(/\s*href="[^"]*"/g, "");
                return (
                  `<link rel="preload" as="style" href="${href}"${extra}>` +
                  `<link rel="stylesheet" href="${href}"${extra} media="print" onload="this.media='all';this.onload=null">` +
                  `<noscript><link rel="stylesheet" href="${href}"${extra}></noscript>`
                );
              },
            ),
        },
      },
    ],
    define: {
      __WEFTCANVAS_CANVAS_BUILD_ID__: JSON.stringify(canvasBuildId),
    },
    // Vite only exposes root variables carrying the VITE_ prefix to browser code.
    envDir: "../../",
    server: {
      port: 4173,
      strictPort: true,
      ...(previewAllowsAnyHost
        ? { allowedHosts: true }
        : previewAllowedHost
          ? { allowedHosts: [previewAllowedHost] }
          : {}),
      proxy: {
        // The API intentionally rejects browser requests from untrusted origins.
        // Vite is the same-origin boundary during local development, so do not
        // forward its local Origin header to a production-style API target.
        "/api": {
          target: apiProxyTarget,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("proxyReq", (request) => request.removeHeader("origin"));
          },
        },
      },
    },
    preview: {
      port: 4174,
    },
  };
});
