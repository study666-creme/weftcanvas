import type { CanvasNodeKind } from "@weftcanvas/contracts";
import { NodeToolbar, Position } from "@xyflow/react";
import {
  Clapperboard,
  Download,
  Info,
  Maximize2,
  Pencil,
  PenTool,
  ScanFace,
  ScanLine,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, type ReactNode, type WheelEvent } from "react";

import { useHorizontalViewportClamp } from "../hooks/use-horizontal-viewport-clamp";

type ToolbarAction = {
  id: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  danger?: boolean;
};

type NodeActionToolbarProps = {
  visible: boolean;
  kind: CanvasNodeKind;
  hasMedia: boolean;
  showGenerationAction: boolean;
  onInfo: () => void;
  onGenerate: () => void;
  onEdit: () => void;
  onPreview: () => void;
  onDownload: () => void;
  onFaceGrid: () => void;
  onAnnotate: () => void;
  onCaptureVideoFrame: () => void;
  onOpenDirector: () => void;
  onUpload: () => void;
  onDelete: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
};

export function NodeActionToolbar({
  visible,
  kind,
  hasMedia,
  showGenerationAction,
  onInfo,
  onGenerate,
  onEdit,
  onPreview,
  onDownload,
  onFaceGrid,
  onAnnotate,
  onCaptureVideoFrame,
  onOpenDirector,
  onUpload,
  onDelete,
  onPointerEnter,
  onPointerLeave,
}: NodeActionToolbarProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isText = kind === "text";
  const isMedia = kind === "image" || kind === "video" || kind === "audio";
  const previewable = kind === "image" || kind === "video";
  const mediaLabel = kind === "image" ? "图片" : kind === "video" ? "视频" : "音频";
  const actions: ToolbarAction[] = [
    ...(kind === "edit"
      ? [
          {
            id: "clip-editor",
            label: "打开剪辑",
            icon: <Clapperboard aria-hidden="true" />,
            onClick: onEdit,
          },
        ]
      : []),
    ...(showGenerationAction
      ? [
          {
            id: "generate",
            label: kind === "config" ? "配置" : "生成",
            icon:
              kind === "config" ? (
                <SlidersHorizontal aria-hidden="true" />
              ) : (
                <Sparkles aria-hidden="true" />
              ),
            onClick: onGenerate,
          },
        ]
      : []),
    ...(isText
      ? [{ id: "edit", label: "全屏编辑", icon: <Pencil aria-hidden="true" />, onClick: onEdit }]
      : []),
    { id: "info", label: "节点信息", icon: <Info aria-hidden="true" />, onClick: onInfo },
    ...(isText
      ? [
          {
            id: "director",
            label: "送入 3D 导演台",
            icon: <Clapperboard aria-hidden="true" />,
            onClick: onOpenDirector,
          },
        ]
      : []),
    ...(previewable && hasMedia
      ? [
          {
            id: "preview",
            label: `查看${mediaLabel}`,
            icon: <Maximize2 aria-hidden="true" />,
            onClick: onPreview,
          },
        ]
      : []),
    ...(kind === "image"
      ? [
          {
            id: "face-grid",
            label: hasMedia ? "人脸网格" : "人脸网格（先选择图片）",
            icon: <ScanFace aria-hidden="true" />,
            onClick: onFaceGrid,
          },
        ]
      : []),
    ...(kind === "image"
      ? [
          {
            id: "annotate",
            label: hasMedia ? "标注图片" : "标注图片（先选择图片）",
            icon: <PenTool aria-hidden="true" />,
            onClick: onAnnotate,
          },
        ]
      : []),
    ...(isMedia && hasMedia
      ? [
          {
            id: "download",
            label: `下载${mediaLabel}`,
            icon: <Download aria-hidden="true" />,
            onClick: onDownload,
          },
        ]
      : []),
    ...(kind === "video" && hasMedia
      ? [
          {
            id: "capture-frame",
            label: "截取当前帧",
            icon: <ScanLine aria-hidden="true" />,
            onClick: onCaptureVideoFrame,
          },
        ]
      : []),
    ...(isMedia
      ? [
          {
            id: "upload",
            label: hasMedia ? `替换${mediaLabel}` : `上传${mediaLabel}`,
            icon: <Upload aria-hidden="true" />,
            onClick: onUpload,
          },
        ]
      : []),
    {
      id: "delete",
      label: "删除节点",
      icon: <Trash2 aria-hidden="true" />,
      onClick: onDelete,
      danger: true,
    },
  ];

  useHorizontalViewportClamp(shellRef, "--wc-toolbar-shift", visible, 12, "--wc-toolbar-shift-y");

  const scrollHorizontally = (event: WheelEvent<HTMLDivElement>) => {
    const toolbar = scrollRef.current;
    if (!toolbar || toolbar.scrollWidth <= toolbar.clientWidth + 1) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    toolbar.scrollLeft += delta;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <NodeToolbar
      isVisible={visible}
      position={Position.Top}
      offset={0}
      className="wc-node-toolbar-anchor"
      data-canvas-node-toolbar
      onPointerDown={(event) => event.stopPropagation()}
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <div ref={shellRef} className="wc-node-toolbar-shell">
        <div
          ref={scrollRef}
          className="wc-node-action-toolbar nodrag nowheel"
          data-node-kind={kind}
          role="toolbar"
          aria-label={`${kind === "config" ? "配置" : "节点"}操作`}
          onWheel={scrollHorizontally}
        >
          {actions.map((action) => (
            <button
              key={action.id}
              type="button"
              className={action.danger ? "is-danger" : undefined}
              data-toolbar-action={action.id}
              aria-label={action.label}
              title={action.label}
              onClick={(event) => {
                event.stopPropagation();
                action.onClick();
              }}
            >
              {action.icon}
            </button>
          ))}
        </div>
        <div className="wc-node-toolbar-bridge" aria-hidden="true" />
      </div>
    </NodeToolbar>
  );
}
