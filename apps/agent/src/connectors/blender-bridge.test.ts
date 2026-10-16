import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  BRIDGE_TOKEN_ENV,
  BRIDGE_TOKEN_FILE_ENV,
  BlenderBridgeClient,
  resolveBridgeToken,
} from "./blender-bridge.js";
import { parseEndpoint, probeBlenderEndpoint } from "./probe.js";

const servers: Server[] = [];
const TEST_TOKEN = () => "test-token-0123456789abcdef0123456789abcdef";

function client(address: string, timeoutMs = 5_000) {
  return new BlenderBridgeClient(address, timeoutMs, TEST_TOKEN);
}

function listen(handler: (line: string) => string): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        socket.write(`${handler(buffer.slice(0, newline))}\n`);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, port });
    });
  });
}

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

describe("parseEndpoint", () => {
  it("accepts host:port and rejects anything else", () => {
    expect(parseEndpoint("127.0.0.1:9876")).toEqual({ host: "127.0.0.1", port: 9876 });
    expect(parseEndpoint("[::1]:9876")).toEqual({ host: "::1", port: 9876 });
    expect(parseEndpoint("localhost")).toBeNull();
    expect(parseEndpoint("127.0.0.1:0")).toBeNull();
    expect(parseEndpoint("127.0.0.1:70000")).toBeNull();
  });
});

describe("resolveBridgeToken", () => {
  it("prefers the explicit env token over the token file", () => {
    expect(
      resolveBridgeToken({ [BRIDGE_TOKEN_ENV]: "  env-token  ", [BRIDGE_TOKEN_FILE_ENV]: "" }),
    ).toBe("env-token");
  });

  it("returns null when neither env nor file carries a token", () => {
    expect(resolveBridgeToken({ [BRIDGE_TOKEN_FILE_ENV]: "/nonexistent/token/file" })).toBeNull();
  });
});

describe("BlenderBridgeClient", () => {
  it("sends the access token with every request line", async () => {
    let seenToken: unknown;
    const { port } = await listen((line) => {
      const request = JSON.parse(line) as {
        id: string;
        method: string;
        params: { code: string };
        token?: unknown;
      };
      expect(request.method).toBe("run_python");
      seenToken = request.token;
      return JSON.stringify({
        id: request.id,
        ok: true,
        result: { stdout: "hello\n", value: { objects: 3 } },
      });
    });
    const bridge = client(`127.0.0.1:${port}`);
    await expect(bridge.runPython("print('hello')")).resolves.toEqual({
      ok: true,
      stdout: "hello\n",
      value: { objects: 3 },
    });
    expect(seenToken).toBe("test-token-0123456789abcdef0123456789abcdef");
  });

  it("surfaces a Blender-side error", async () => {
    const { port } = await listen((line) => {
      const request = JSON.parse(line) as { id: string };
      return JSON.stringify({
        id: request.id,
        ok: false,
        error: "NameError: name 'bpyy' is not defined",
      });
    });
    await expect(client(`127.0.0.1:${port}`).runPython("bpyy")).resolves.toEqual({
      ok: false,
      error: "NameError: name 'bpyy' is not defined",
    });
  });

  it("surfaces a bridge-side auth rejection verbatim", async () => {
    const { port } = await listen((line) => {
      const request = JSON.parse(line) as { id: string };
      return JSON.stringify({
        id: request.id,
        ok: false,
        error: "认证失败：访问令牌缺失或不正确。请重启 Blender 桥接或重新一键配置。",
      });
    });
    const result = await client(`127.0.0.1:${port}`).runPython("print(1)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("认证失败");
  });

  it("reports a clear error when the token cannot be resolved", async () => {
    const bridge = new BlenderBridgeClient("127.0.0.1:1", 1_000, () => null);
    const result = await bridge.runPython("print(1)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("找不到 Blender 桥接访问令牌");
  });

  it("reports a clear error when nothing is listening", async () => {
    const result = await client("127.0.0.1:1", 1_000).runPython("print(1)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Blender 桥接没有在监听");
  });

  it("rejects empty code without opening a connection", async () => {
    await expect(client("127.0.0.1:1", 1_000).runPython("   ")).resolves.toEqual({
      ok: false,
      error: "Python 代码为空",
    });
  });
});

describe("probeBlenderEndpoint", () => {
  it("reports reachable for a listening port and unavailable otherwise", async () => {
    const { port } = await listen(() => "");
    await expect(probeBlenderEndpoint(`127.0.0.1:${port}`)).resolves.toMatchObject({
      reachable: true,
    });
    await expect(probeBlenderEndpoint("127.0.0.1:1")).resolves.toMatchObject({
      reachable: false,
      detail: "端口上没有 Blender 桥接在监听",
    });
    await expect(probeBlenderEndpoint("not-an-address")).resolves.toMatchObject({
      reachable: false,
    });
  });
});
