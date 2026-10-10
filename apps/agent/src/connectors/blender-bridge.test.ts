import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { BlenderBridgeClient } from "./blender-bridge.js";
import { parseEndpoint, probeBlenderEndpoint } from "./probe.js";

const servers: Server[] = [];

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
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
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

describe("BlenderBridgeClient", () => {
  it("sends one JSON line and reads the result", async () => {
    const { port } = await listen((line) => {
      const request = JSON.parse(line) as { id: string; method: string; params: { code: string } };
      expect(request.method).toBe("run_python");
      return JSON.stringify({ id: request.id, ok: true, result: { stdout: "hello\n", value: { objects: 3 } } });
    });
    const client = new BlenderBridgeClient(`127.0.0.1:${port}`, 5_000);
    await expect(client.runPython("print('hello')")).resolves.toEqual({
      ok: true,
      stdout: "hello\n",
      value: { objects: 3 },
    });
  });

  it("surfaces a Blender-side error", async () => {
    const { port } = await listen((line) => {
      const request = JSON.parse(line) as { id: string };
      return JSON.stringify({ id: request.id, ok: false, error: "NameError: name 'bpyy' is not defined" });
    });
    const client = new BlenderBridgeClient(`127.0.0.1:${port}`, 5_000);
    await expect(client.runPython("bpyy")).resolves.toEqual({
      ok: false,
      error: "NameError: name 'bpyy' is not defined",
    });
  });

  it("reports a clear error when nothing is listening", async () => {
    const client = new BlenderBridgeClient("127.0.0.1:1", 1_000);
    const result = await client.runPython("print(1)");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Blender 桥接没有在监听");
  });

  it("rejects empty code without opening a connection", async () => {
    const client = new BlenderBridgeClient("127.0.0.1:1", 1_000);
    await expect(client.runPython("   ")).resolves.toEqual({ ok: false, error: "Python 代码为空" });
  });
});

describe("probeBlenderEndpoint", () => {
  it("reports reachable for a listening port and unavailable otherwise", async () => {
    const { port } = await listen(() => "");
    await expect(probeBlenderEndpoint(`127.0.0.1:${port}`)).resolves.toMatchObject({ reachable: true });
    await expect(probeBlenderEndpoint("127.0.0.1:1")).resolves.toMatchObject({
      reachable: false,
      detail: "端口上没有 Blender 桥接在监听",
    });
    await expect(probeBlenderEndpoint("not-an-address")).resolves.toMatchObject({ reachable: false });
  });
});
