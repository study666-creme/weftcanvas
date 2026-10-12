import { describe, expect, it, vi } from "vitest";

import { createRemoteBlenderTool, RemoteBlenderRunner } from "./remote-blender.js";

function runner(fetchImpl: typeof fetch, timeoutMs = 5_000) {
  return new RemoteBlenderRunner("http://127.0.0.1:8788", "runtime-token", timeoutMs, {
    fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RemoteBlenderRunner", () => {
  it("dispatches the code to the API with the shared runtime token", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: { taskId: "t1", status: "completed", stdout: "4.2.1\n", error: null },
      }),
    ) as unknown as typeof fetch;

    const result = await runner(fetchImpl).run("user-a", "print(bpy.app.version_string)");
    expect(result).toEqual({ ok: true, content: "Blender 执行完成：\n4.2.1" });

    const [url, init] = (fetchImpl as unknown as { mock: { calls: Array<[string, RequestInit]> } })
      .mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8788/internal/v1/connectors/blender/run");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer runtime-token");
    expect(JSON.parse(String(init.body))).toEqual({
      ownerId: "user-a",
      code: "print(bpy.app.version_string)",
    });
  });

  it("turns an offline user machine into a truthful failure", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: {
          taskId: "t2",
          status: "disconnected",
          stdout: "",
          error: "用户机器上的客户端当前不在线",
        },
      }),
    ) as unknown as typeof fetch;
    await expect(runner(fetchImpl).run("user-a", "print(1)")).resolves.toEqual({
      ok: false,
      content: "用户机器上的客户端当前不在线",
    });
  });

  it("does not pretend success when the dispatch is rejected or unreachable", async () => {
    const unauthorized = vi.fn(async () =>
      jsonResponse({ ok: false, error: { code: "UNAUTHORIZED" } }, 401),
    ) as unknown as typeof fetch;
    await expect(runner(unauthorized).run("user-a", "print(1)")).resolves.toMatchObject({
      ok: false,
    });

    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    await expect(runner(down).run("user-a", "print(1)")).resolves.toEqual({
      ok: false,
      content: "用户机器上的 Blender 暂时不可达",
    });
  });

  it("reports a timeout instead of hanging", async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;
    await expect(runner(fetchImpl, 50).run("user-a", "print(1)")).resolves.toEqual({
      ok: false,
      content: "用户机器上的 Blender 暂时不可达",
    });
  });
});

describe("createRemoteBlenderTool", () => {
  it("uses the same tool name and parameters as the local bridge", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        ok: true,
        data: { taskId: "t3", status: "completed", stdout: "done", error: null },
      }),
    ) as unknown as typeof fetch;
    const tool = createRemoteBlenderTool(runner(fetchImpl), "user-a");
    expect(tool.name).toBe("blender_run_python");
    expect(tool.parameters.map((parameter) => parameter.name)).toEqual(["code", "purpose"]);
    await expect(
      tool.run({ code: "bpy.ops.mesh.primitive_cube_add()" }, {}),
    ).resolves.toMatchObject({ ok: true });
  });

  it("rejects an empty code argument without dispatching", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ ok: true, data: {} }),
    ) as unknown as typeof fetch;
    const tool = createRemoteBlenderTool(runner(fetchImpl), "user-a");
    await expect(tool.run({ purpose: "随便" }, {})).resolves.toEqual({
      ok: false,
      content: "缺少要执行的 Python 代码",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
