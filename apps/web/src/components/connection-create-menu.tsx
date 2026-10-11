import type { CanvasNodeKind } from "@kachang/contracts";
import { useCreatableNodeDefinitions } from "../lib/node-registry";
import { Puzzle } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import type { XYPosition } from "@xyflow/react";

export type PendingConnectionCreate = {
  anchorId: string;
  side: "left" | "right";
  flowPosition: XYPosition;
  clientPosition: XYPosition;
  zoom: number;
};

type ConnectionCreateMenuProps = {
  pending: PendingConnectionCreate;
  onCreate: (kind: CanvasNodeKind) => void;
  onClose: () => void;
};

// 单排紧凑条：6 种节点类型 × 约 68px + 间距 + 内边距。
const MENU_WIDTH = 468;
const MENU_HEIGHT = 44;
const VIEWPORT_MARGIN = 16;

export function ConnectionCreateMenu({ pending, onCreate, onClose }: ConnectionCreateMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const creatableNodes = useCreatableNodeDefinitions();
  const position = useMemo(() => {
    const preferredLeft = pending.side === "right"
      ? pending.clientPosition.x + 18
      : pending.clientPosition.x - MENU_WIDTH - 18;
    return {
      left: clamp(preferredLeft, VIEWPORT_MARGIN, window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN),
      top: clamp(pending.clientPosition.y - MENU_HEIGHT / 2, VIEWPORT_MARGIN, window.innerHeight - MENU_HEIGHT - VIEWPORT_MARGIN),
    };
  }, [pending.clientPosition.x, pending.clientPosition.y, pending.side]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>(".kc-connection-create-option")?.focus());
    const dismissOutside = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      onClose();
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="kc-connection-create-menu nodrag nopan nowheel"
      role="menu"
      aria-label="选择要连接创建的节点"
      data-connection-create-menu
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {creatableNodes.map((definition) => {
        const Icon = definition.icon ?? Puzzle;
        return (
          <button
            key={definition.kind}
            type="button"
            role="menuitem"
            className={`kc-connection-create-option kc-quick-add--${definition.kind}`}
            aria-label={`创建并连接${definition.label()}`}
            onClick={() => onCreate(definition.kind)}
          >
            <Icon aria-hidden="true" />
            <span>{definition.label().replace("节点", "")}</span>
          </button>
        );
      })}
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}
