import { describe, expect, it } from "vitest";

import {
  CONNECTOR_ONLINE_WINDOW_MS,
  ExternalConnectorService,
} from "./external-connector-service.js";

function service(now = () => 1_000) {
  return new ExternalConnectorService({ now });
}

describe("ExternalConnectorService pairing", () => {
  it("issues a token that only its owner can use for its own connector", () => {
    const connectors = service();
    const pairing = connectors.createPairing("user-a", "blender");
    expect(pairing.token.length).toBeGreaterThanOrEqual(32);

    expect(connectors.authenticate(pairing.token)).toEqual({
      ownerId: "user-a",
      connectorId: "blender",
    });
    // 令牌和连接必须匹配：拿 blender 的令牌不能领 codex 的任务
    expect(connectors.poll({ token: pairing.token, connectorId: "codex" })).toBeNull();
    expect(connectors.poll({ token: pairing.token, connectorId: "blender" })).toMatchObject({
      tasks: [],
    });
    expect(connectors.authenticate("not-a-token")).toBeNull();
  });

  it("reports paired and online state per connector", () => {
    let now = 1_000;
    const connectors = service(() => now);
    expect(connectors.listStatus("user-a", ["codex", "blender"])).toEqual([
      { connectorId: "codex", paired: false, connected: false, pairedAt: null, lastSeenAt: null },
      { connectorId: "blender", paired: false, connected: false, pairedAt: null, lastSeenAt: null },
    ]);

    const pairing = connectors.createPairing("user-a", "blender");
    expect(connectors.listStatus("user-a", ["blender"])[0]).toMatchObject({
      paired: true,
      connected: false,
    });

    connectors.poll({ token: pairing.token, connectorId: "blender" });
    expect(connectors.listStatus("user-a", ["blender"])[0]).toMatchObject({
      paired: true,
      connected: true,
    });

    now += CONNECTOR_ONLINE_WINDOW_MS + 1;
    expect(connectors.listStatus("user-a", ["blender"])[0]).toMatchObject({
      paired: true,
      connected: false,
    });
    // 另一个用户看不到这条配对
    expect(connectors.listStatus("user-b", ["blender"])[0]).toMatchObject({ paired: false });
  });

  it("rotates on re-pairing and revokes the old token", () => {
    const connectors = service();
    const first = connectors.createPairing("user-a", "codex");
    const second = connectors.createPairing("user-a", "codex");
    expect(second.token).not.toBe(first.token);
    expect(connectors.authenticate(first.token)).toBeNull();
    expect(connectors.authenticate(second.token)).not.toBeNull();

    expect(connectors.revokePairing("user-a", "codex")).toBe(true);
    expect(connectors.authenticate(second.token)).toBeNull();
    expect(connectors.revokePairing("user-a", "codex")).toBe(false);
  });
});

describe("ExternalConnectorService task delivery", () => {
  it("delivers a task to the user's client and resolves with its result", async () => {
    const connectors = service();
    const pairing = connectors.createPairing("user-a", "blender");
    connectors.poll({ token: pairing.token, connectorId: "blender" });

    const running = connectors.runTask("user-a", {
      connectorId: "blender",
      method: "run_python",
      params: { code: "print(bpy.app.version_string)" },
      waitMs: 5_000,
    });

    const polled = connectors.poll({ token: pairing.token, connectorId: "blender" });
    expect(polled?.tasks).toHaveLength(1);
    const task = polled!.tasks[0]!;
    expect(task).toMatchObject({ connectorId: "blender", method: "run_python" });

    // 领取即出队：同一任务不会被投递两次
    expect(connectors.poll({ token: pairing.token, connectorId: "blender" })?.tasks).toHaveLength(
      0,
    );

    expect(
      connectors.submitResult(pairing.token, {
        connectorId: "blender",
        taskId: task.id,
        ok: true,
        stdout: "4.2.1\n",
        error: null,
      }),
    ).toBe(true);

    await expect(running).resolves.toEqual({
      taskId: task.id,
      status: "completed",
      stdout: "4.2.1\n",
      error: null,
    });
  });

  it("refuses tasks when the client is not connected, and never fakes success", async () => {
    const connectors = service();
    connectors.createPairing("user-a", "blender");
    await expect(
      connectors.runTask("user-a", { connectorId: "blender", method: "ping", params: {} }),
    ).resolves.toMatchObject({ status: "disconnected" });

    await expect(
      connectors.runTask("user-b", { connectorId: "blender", method: "ping", params: {} }),
    ).resolves.toMatchObject({ status: "failed", error: "这个连接还没有配对" });
  });

  it("converges to timeout when nobody answers", async () => {
    const connectors = service();
    const pairing = connectors.createPairing("user-a", "blender");
    connectors.poll({ token: pairing.token, connectorId: "blender" });
    await expect(
      connectors.runTask("user-a", {
        connectorId: "blender",
        method: "ping",
        params: {},
        waitMs: 1_000,
      }),
    ).resolves.toMatchObject({ status: "timeout" });
  });

  it("does not let another user's client settle this task", async () => {
    const connectors = service();
    const owner = connectors.createPairing("user-a", "blender");
    const other = connectors.createPairing("user-b", "blender");
    connectors.poll({ token: owner.token, connectorId: "blender" });
    connectors.poll({ token: other.token, connectorId: "blender" });

    const running = connectors.runTask("user-a", {
      connectorId: "blender",
      method: "ping",
      params: {},
      waitMs: 2_000,
    });
    // user-b 的客户端拿不到这条任务，也就无从结算
    expect(connectors.poll({ token: other.token, connectorId: "blender" })?.tasks).toHaveLength(0);
    const task = connectors.poll({ token: owner.token, connectorId: "blender" })!.tasks[0]!;
    expect(
      connectors.submitResult(other.token, {
        connectorId: "blender",
        taskId: task.id,
        ok: true,
        stdout: "",
        error: null,
      }),
    ).toBe(false);
    connectors.submitResult(owner.token, {
      connectorId: "blender",
      taskId: task.id,
      ok: true,
      stdout: "ok",
      error: null,
    });
    await expect(running).resolves.toMatchObject({ status: "completed", stdout: "ok" });
  });

  it("caps pending tasks and revoking a pairing fails the queue instead of hanging", async () => {
    const connectors = service();
    const pairing = connectors.createPairing("user-a", "blender");
    connectors.poll({ token: pairing.token, connectorId: "blender" });
    const running = Array.from({ length: 8 }, () =>
      connectors.runTask("user-a", {
        connectorId: "blender",
        method: "ping",
        params: {},
        waitMs: 5_000,
      }),
    );
    await expect(
      connectors.runTask("user-a", {
        connectorId: "blender",
        method: "ping",
        params: {},
        waitMs: 5_000,
      }),
    ).resolves.toMatchObject({ status: "failed", error: "待办任务过多，请稍后重试" });

    connectors.revokePairing("user-a", "blender");
    for (const task of await Promise.all(running)) {
      expect(task).toMatchObject({ status: "timeout", error: "配对已撤销" });
    }
  });
});
