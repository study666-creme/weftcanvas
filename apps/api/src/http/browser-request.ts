/**
 * 跨站请求判定（从 app.ts 抽出，纯搬运）：Sec-Fetch-Site: cross-site 直接拒绝；
 * 有 Origin 时必须是白名单来源或同源。账号、生成、钱包等浏览器侧写接口共用的门。
 */
export function isTrustedBrowserRequest(request: Request, allowedOrigins: readonly string[] = []) {
  if (request.headers.get("Sec-Fetch-Site")?.toLowerCase() === "cross-site") return false;
  const origin = request.headers.get("Origin");
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}
