import { memo, useEffect } from "react";

import { pollCanvasControlCommands } from "../lib/api-client";
import {
  applyCanvasControlCommand,
  describeCanvasControlOutcome,
  reportCanvasControlOutcome,
} from "../lib/canvas-control-client";
import { readCurrentAgentCanvasContext } from "../lib/current-canvas-context";
import { useCanvasStore } from "../state/canvas-store";
import { useConnectorStore } from "../state/connector-store";
import { useToastStore } from "../state/toast-store";

const BASE_INTERVAL_MS = 2_500;
const MAX_INTERVAL_MS = 30_000;

/**
 * Codex 画布通道：Codex 侧通过 MCP 下单，浏览器在这里拉取并用与 Agent 相同的
 * 执行器落到画布，再把回执发回去。只有 Codex 连接打开时才轮询。
 */
export const CanvasControlBridge = memo(function CanvasControlBridge() {
  const projectId = useCanvasStore((state) => state.projectId);
  const codexEnabled = useConnectorStore((state) =>
    state.items.some((item) => item.id === "codex" && item.enabled),
  );
  const showToast = useToastStore((state) => state.show);

  useEffect(() => {
    // 先取一次连接状态，否则不知道 Codex 连接是否开着。
    void useConnectorStore.getState().load();
  }, [projectId]);

  useEffect(() => {
    if (!codexEnabled) return;
    let stopped = false;
    let timer: number | null = null;
    let failures = 0;

    const tick = async () => {
      if (stopped) return;
      try {
        const commands = await pollCanvasControlCommands(
          projectId,
          readCurrentAgentCanvasContext(),
        );
        failures = 0;
        for (const command of commands) {
          if (stopped) return;
          const outcome = applyCanvasControlCommand(projectId, command);
          await reportCanvasControlOutcome(command, outcome).catch(() => undefined);
          const message = describeCanvasControlOutcome(command, outcome);
          if (message) showToast(message, outcome.status === "applied" ? "success" : "error");
        }
      } catch {
        // 轮询失败不打扰用户：外部连接面板会显示真实状态。
        failures = Math.min(failures + 1, 4);
      }
      if (stopped) return;
      timer = window.setTimeout(
        tick,
        failures ? Math.min(MAX_INTERVAL_MS, BASE_INTERVAL_MS * 2 ** failures) : BASE_INTERVAL_MS,
      );
    };

    void tick();
    return () => {
      stopped = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [codexEnabled, projectId, showToast]);

  return null;
});
