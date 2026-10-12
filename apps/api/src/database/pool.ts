import { Socket } from "node:net";
import { Duplex } from "node:stream";

import { Pool, type PoolConfig } from "pg";

const DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_DATABASE_PROXY_TIMEOUT_MS = 5_000;
const MAX_PROXY_RESPONSE_HEADER_BYTES = 16 * 1024;

export interface DatabasePoolEnvironment {
  DATABASE_URL?: string;
  DATABASE_PROXY_URL?: string;
  DATABASE_CONNECTION_TIMEOUT_MS?: string;
  DATABASE_PROXY_TIMEOUT_MS?: string;
}

interface HttpProxyEndpoint {
  hostname: string;
  port: number;
  authorization?: string;
}

export function createDatabasePool(environment: DatabasePoolEnvironment = process.env) {
  const connectionString = environment.DATABASE_URL?.trim();
  if (!connectionString) return undefined;

  const connectionTimeoutMillis = readTimeout(
    environment.DATABASE_CONNECTION_TIMEOUT_MS,
    DEFAULT_DATABASE_CONNECTION_TIMEOUT_MS,
    "DATABASE_CONNECTION_TIMEOUT_MS",
  );
  const config: PoolConfig = { connectionString, connectionTimeoutMillis };
  if (shouldDefaultToVerifiedTls(connectionString)) {
    config.ssl = { rejectUnauthorized: true };
  }
  const proxyUrl = environment.DATABASE_PROXY_URL?.trim();
  if (proxyUrl) {
    const proxy = parseHttpProxy(proxyUrl);
    const proxyTimeoutMs = readTimeout(
      environment.DATABASE_PROXY_TIMEOUT_MS,
      DEFAULT_DATABASE_PROXY_TIMEOUT_MS,
      "DATABASE_PROXY_TIMEOUT_MS",
    );
    config.stream = () => new HttpConnectStream(proxy, proxyTimeoutMs);
  }

  const pool = new Pool(config);
  pool.on("error", (error) => {
    const code = readSafeErrorCode(error);
    console.error(
      code ? `Idle database connection failed (${code})` : "Idle database connection failed",
    );
  });
  return pool;
}

class HttpConnectStream extends Duplex {
  readonly #proxy: HttpProxyEndpoint;
  readonly #proxyTimeoutMs: number;
  #socket: Socket | undefined;
  #handshakeTimer: NodeJS.Timeout | undefined;
  #response = Buffer.alloc(0);
  #tunneled = false;
  #noDelay = false;
  #keepAlive = false;
  #keepAliveInitialDelay = 0;
  #referenced = true;

  constructor(proxy: HttpProxyEndpoint, proxyTimeoutMs: number) {
    super({ allowHalfOpen: false });
    this.#proxy = proxy;
    this.#proxyTimeoutMs = proxyTimeoutMs;
  }

  connect(portOrPath: number | string, host?: string) {
    if (this.#socket || this.destroyed) return this;
    if (
      !Number.isInteger(portOrPath) ||
      Number(portOrPath) < 1 ||
      Number(portOrPath) > 65_535 ||
      !host
    ) {
      queueMicrotask(() =>
        this.destroy(new Error("Database proxy requires a TCP database host and port")),
      );
      return this;
    }

    let authority: string;
    try {
      authority = formatAuthority(host, Number(portOrPath));
    } catch (error) {
      queueMicrotask(() =>
        this.destroy(error instanceof Error ? error : new Error("Invalid database proxy target")),
      );
      return this;
    }
    const socket = new Socket();
    this.#socket = socket;
    socket.setNoDelay(this.#noDelay);
    socket.setKeepAlive(this.#keepAlive, this.#keepAliveInitialDelay);
    if (!this.#referenced) socket.unref();

    this.#handshakeTimer = setTimeout(() => {
      this.destroy(new Error("Database proxy handshake timed out"));
    }, this.#proxyTimeoutMs);
    this.#handshakeTimer.unref?.();

    socket.once("connect", () => {
      socket.write(buildConnectRequest(authority, this.#proxy.authorization));
    });
    socket.on("data", (chunk: Buffer) => this.#handleData(chunk));
    socket.once("end", () => this.push(null));
    socket.once("error", (cause) => {
      this.destroy(databaseProxyConnectionError(cause));
    });
    socket.once("close", () => {
      if (!this.destroyed) this.destroy();
    });

    try {
      socket.connect({ host: this.#proxy.hostname, port: this.#proxy.port });
    } catch (cause) {
      queueMicrotask(() => this.destroy(databaseProxyConnectionError(cause)));
    }
    return this;
  }

  setNoDelay(noDelay = true) {
    this.#noDelay = noDelay;
    this.#socket?.setNoDelay(noDelay);
    return this;
  }

  setKeepAlive(enable = false, initialDelay = 0) {
    this.#keepAlive = enable;
    this.#keepAliveInitialDelay = initialDelay;
    this.#socket?.setKeepAlive(enable, initialDelay);
    return this;
  }

  ref() {
    this.#referenced = true;
    this.#socket?.ref();
    return this;
  }

  unref() {
    this.#referenced = false;
    this.#socket?.unref();
    return this;
  }

  override _read() {
    if (this.#tunneled) this.#socket?.resume();
  }

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ) {
    const socket = this.#socket;
    if (!socket || !this.#tunneled || socket.destroyed) {
      callback(new Error("Database proxy tunnel is not connected"));
      return;
    }
    socket.write(chunk, callback);
  }

  override _final(callback: (error?: Error | null) => void) {
    const socket = this.#socket;
    if (!socket || socket.destroyed) {
      callback();
      return;
    }
    socket.end(callback);
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.#clearHandshakeTimer();
    const socket = this.#socket;
    this.#socket = undefined;
    if (socket) {
      socket.removeAllListeners();
      socket.destroy();
    }
    callback(error);
  }

  #handleData(chunk: Buffer) {
    if (this.#tunneled) {
      if (!this.push(chunk)) this.#socket?.pause();
      return;
    }

    this.#response = Buffer.concat([this.#response, chunk]);
    const headerEnd = this.#response.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      if (this.#response.length > MAX_PROXY_RESPONSE_HEADER_BYTES) {
        this.destroy(new Error("Database proxy response headers are too large"));
      }
      return;
    }
    if (headerEnd + 4 > MAX_PROXY_RESPONSE_HEADER_BYTES) {
      this.destroy(new Error("Database proxy response headers are too large"));
      return;
    }

    const statusLineEnd = this.#response.indexOf("\r\n");
    const statusLine = this.#response.subarray(0, statusLineEnd).toString("latin1");
    const match = /^HTTP\/1\.[01] ([0-9]{3})(?:[ \t]|$)/.exec(statusLine);
    const status = match ? Number(match[1]) : 0;
    if (status < 200 || status >= 300) {
      this.destroy(
        new Error(
          status
            ? `Database proxy CONNECT failed with status ${status}`
            : "Database proxy returned an invalid response",
        ),
      );
      return;
    }

    const remainder = this.#response.subarray(headerEnd + 4);
    this.#response = Buffer.alloc(0);
    this.#tunneled = true;
    this.#clearHandshakeTimer();
    this.emit("connect");
    if (remainder.length > 0 && !this.push(remainder)) this.#socket?.pause();
  }

  #clearHandshakeTimer() {
    if (!this.#handshakeTimer) return;
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = undefined;
  }
}

function parseHttpProxy(value: string): HttpProxyEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DATABASE_PROXY_URL must be a valid http:// URL");
  }
  if (
    url.protocol !== "http:" ||
    !url.hostname ||
    (url.pathname && url.pathname !== "/") ||
    url.search ||
    url.hash
  ) {
    throw new Error("DATABASE_PROXY_URL must be an http:// host and optional port");
  }
  const port = url.port ? Number(url.port) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DATABASE_PROXY_URL contains an invalid port");
  }

  const username = decodeUrlComponent(url.username);
  const password = decodeUrlComponent(url.password);
  return {
    hostname: url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname,
    port,
    ...(username || password
      ? {
          authorization: `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`,
        }
      : {}),
  };
}

function decodeUrlComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Error("DATABASE_PROXY_URL contains invalid credentials");
  }
}

function formatAuthority(host: string, port: number) {
  const unwrappedHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (/[^\u0021-\u007e]/.test(unwrappedHost) || /[\s\[\]]/.test(unwrappedHost)) {
    throw new Error("Database host cannot be encoded in a proxy CONNECT request");
  }
  const normalizedHost = unwrappedHost.includes(":") ? `[${unwrappedHost}]` : unwrappedHost;
  return `${normalizedHost}:${port}`;
}

function buildConnectRequest(authority: string, authorization?: string) {
  return [
    `CONNECT ${authority} HTTP/1.1`,
    `Host: ${authority}`,
    "Proxy-Connection: Keep-Alive",
    ...(authorization ? [`Proxy-Authorization: ${authorization}`] : []),
    "",
    "",
  ].join("\r\n");
}

function shouldDefaultToVerifiedTls(connectionString: string) {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    return false;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return false;
  if (!url.hostname || isLoopbackHost(url.hostname)) return false;

  const sslParameters = ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "sslnegotiation"];
  return !sslParameters.some((name) => url.searchParams.has(name));
}

function isLoopbackHost(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function readTimeout(value: string | undefined, fallback: number, name: string) {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 100 || parsed > 120_000) {
    throw new Error(`${name} must be an integer between 100 and 120000`);
  }
  return parsed;
}

function databaseProxyConnectionError(cause: unknown) {
  const error = new Error("Database proxy connection failed", { cause }) as Error & {
    code?: string;
  };
  const code = readSafeErrorCode(cause);
  if (code) error.code = code;
  return error;
}

function readSafeErrorCode(error: unknown) {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z0-9_-]{1,32}$/i.test(code) ? code : undefined;
}
