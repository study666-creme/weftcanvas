import type { CanvasImportProvider } from "@weftcanvas/contracts";

import { CanvasImportError } from "./adapt.js";
import {
  LIBTV_DETAIL_URL,
  TAPNOW_SHARE_URL_PREFIX,
  UPDREAM_SHARE_URL_PREFIX,
} from "./reference.js";

/**
 * 三个来源的读取。
 *
 * 目标主机全部来自本文件的常量，用户输入只影响查询参数或路径段，因此这里不需要
 * SSRF 守卫；但必须禁止重定向（LibTV 的令牌是自定义请求头，跟着 302 走会把凭证
 * 带到别的主机），并且限制响应体大小与等待时间。
 */
const SOURCE_TIMEOUT_MS = 20_000;
const SOURCE_MAX_BYTES: Record<CanvasImportProvider, number> = {
  libtv: 8 << 20,
  tapnow: 16 << 20,
  updream: 16 << 20,
};
const SOURCE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export type CanvasImportSourceOptions = {
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
};

export async function fetchLibTVCanvasDetail(
  uuid: string,
  token: string,
  options: CanvasImportSourceOptions = {},
): Promise<unknown> {
  const url = new URL(LIBTV_DETAIL_URL);
  url.searchParams.set("uuid", uuid);
  const payload = await readSourceEnvelope("libtv", url, options, { token });
  return payload;
}

export async function fetchTapNowCanvasShare(
  shareId: string,
  options: CanvasImportSourceOptions = {},
): Promise<unknown> {
  const url = new URL(`${TAPNOW_SHARE_URL_PREFIX}${encodeURIComponent(shareId)}`);
  return readSourceEnvelope("tapnow", url, options);
}

/**
 * UpDream 的口令本体可能带 `:`（`<id>:node:share`），路径段里 `:` 是合法字符，
 * 保持原样发给对方，其余字符按规范转义。
 */
export async function fetchUpDreamShare(
  code: string,
  options: CanvasImportSourceOptions = {},
): Promise<unknown> {
  const url = new URL(
    `${UPDREAM_SHARE_URL_PREFIX}${encodeURIComponent(code).replace(/%3A/gi, ":")}`,
  );
  return readSourceEnvelope("updream", url, options);
}

async function readSourceEnvelope(
  provider: CanvasImportProvider,
  url: URL,
  options: CanvasImportSourceOptions,
  headers: { token?: string } = {},
): Promise<unknown> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const label = provider === "libtv" ? "LibTV" : provider === "tapnow" ? "TapNow" : "UpDream";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? SOURCE_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": SOURCE_USER_AGENT,
          ...(headers.token ? { token: headers.token } : {}),
        },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new CanvasImportError(503, "IMPORT_SOURCE_TIMEOUT", `${label} 响应超时，请稍后再试`);
      }
      throw new CanvasImportError(
        503,
        "IMPORT_SOURCE_UNAVAILABLE",
        `${label} 暂时连不上，请检查网络${headers.token ? "与画布令牌" : "与分享链接"}后重试`,
      );
    }
    // 3xx 不该出现：上面的 redirect:"manual" 已经拦住跟随，这里只是把结果说清楚。
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      throw new CanvasImportError(
        503,
        "IMPORT_SOURCE_UNAVAILABLE",
        `${label} 返回了跳转，已拒绝跟随`,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new CanvasImportError(
        503,
        "IMPORT_SOURCE_UNAVAILABLE",
        `${label} 读取失败（HTTP ${response.status}）`,
      );
    }
    const text = await readBoundedText(response, SOURCE_MAX_BYTES[provider], label);
    let envelope: unknown;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new CanvasImportError(503, "IMPORT_SOURCE_INVALID", `${label} 返回了无法识别的数据`);
    }
    return unwrapEnvelope(envelope, label);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 业务信封：`{code, data, msg}`（UpDream 的分享接口还会用 `message`）。
 * code 非 0 时把对方的 msg 原样当错误文案——那是唯一能让用户看懂"为什么读不到"的信息。
 */
function unwrapEnvelope(value: unknown, label: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CanvasImportError(503, "IMPORT_SOURCE_INVALID", `${label} 返回了无法识别的数据`);
  }
  const envelope = value as Record<string, unknown>;
  const hasCode = typeof envelope.code === "number";
  if (hasCode && envelope.code !== 0) {
    const message =
      (typeof envelope.msg === "string" && envelope.msg.trim()) ||
      (typeof envelope.message === "string" && envelope.message.trim()) ||
      `${label} 返回了业务错误`;
    throw new CanvasImportError(400, "IMPORT_SOURCE_REJECTED", message.slice(0, 200));
  }
  if ("data" in envelope && envelope.data !== undefined && envelope.data !== null) {
    return envelope.data;
  }
  // 没有信封结构的接口（UpDream 的分享载荷）直接返回本体。
  return envelope;
}

async function readBoundedText(response: Response, maxBytes: number, label: string) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > maxBytes) {
        throw new CanvasImportError(
          413,
          "IMPORT_SOURCE_TOO_LARGE",
          `${label} 画布数据过大，暂时无法导入`,
        );
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder().decode(concatBytes(chunks));
}

function concatBytes(chunks: Uint8Array[]) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}
