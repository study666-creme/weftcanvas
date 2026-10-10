import type { CanvasNodeData } from "@kachang/contracts";
import { memo, useRef } from "react";
import { createPortal } from "react-dom";

import { useNodeOverlayPosition } from "../hooks/use-node-overlay-position";
import { NodeGenerationPanel } from "./node-generation-panel";

type NodeConfigurationComposerProps = {
  nodeId: string;
  data: CanvasNodeData;
};

export const NodeConfigurationComposer = memo(function NodeConfigurationComposer({ nodeId, data }: NodeConfigurationComposerProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  useNodeOverlayPosition(nodeId, shellRef);

  return createPortal(
    <div
      ref={shellRef}
      className="kc-node-config-shell nodrag nowheel nopan"
      data-node-configuration-composer
      onPointerDown={(event) => event.stopPropagation()}
    >
      <NodeGenerationPanel
        nodeId={nodeId}
        data={data}
        presentation="embedded"
        onClose={() => undefined}
      />
    </div>,
    document.body,
  );
});
