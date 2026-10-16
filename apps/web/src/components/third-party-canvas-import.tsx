import {
  canvasImportProviderLabels,
  canvasImportProviderHints,
  canvasImportProviders,
  type CanvasImportPreview,
  type CanvasImportProvider,
  type CanvasImportProviderStatus,
} from "@weftcanvas/contracts";
import { AlertTriangle, CircleAlert, CloudDownload, FileDown, LoaderCircle, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import {
  CanvasApiError,
  requestCanvasImportPreview,
  requestCanvasImportProviders,
} from "../lib/api-client";
import { fetchImportedAsset, planImportedGraph, viewportCenterInFlow } from "../lib/canvas-import";
import { useCanvasStore } from "../state/canvas-store";
import { useIdentityStore } from "../state/identity-store";
import { useToastStore } from "../state/toast-store";

/**
 * 第三方画布导入入口：顶栏「导入第三方画布」→ 选来源 → 粘贴链接 → 预览 → 确认。
 *
 * 三方（LibTV / TapNow / UpDream）只有标识形态不同，流程完全一致：读预览（服务端
 * 一次请求）→ 一次性落节点与连线 → 逐个把素材拉进本地媒体库。素材逐个失败不会
 * 影响整块导入，失败的节点如实留在画布上作为占位并提示原因。
 */
const PROVIDER_ICONS: Record<CanvasImportProvider, typeof FileDown> = {
  libtv: FileDown,
  tapnow: CloudDownload,
  updream: FileDown,
};

type ImportPhase = "idle" | "reading" | "ready" | "applying";

export const CanvasImportMenu = memo(function CanvasImportMenu({
  onOpen,
}: {
  onOpen: (provider: CanvasImportProvider) => void;
}) {
  const [open, setOpen] = useState(false);
  const [statuses, setStatuses] = useState<CanvasImportProviderStatus[] | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 打开菜单时问一次可用性：LibTV 缺服务端令牌时如实显示为不可用，并说明差什么。
  useEffect(() => {
    if (!open || statuses || statusFailed) return;
    let cancelled = false;
    void requestCanvasImportProviders()
      .then((response) => {
        if (!cancelled) setStatuses(response.data.providers);
      })
      .catch(() => {
        if (!cancelled) setStatusFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, statuses, statusFailed]);

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && containerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const dismissWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissWithKeyboard);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissWithKeyboard);
    };
  }, [open]);

  const statusByProvider = useMemo(() => {
    const map = new Map<CanvasImportProvider, CanvasImportProviderStatus>();
    for (const status of statuses ?? []) map.set(status.provider, status);
    return map;
  }, [statuses]);

  return (
    <div className="wc-canvas-import" ref={containerRef}>
      <button
        type="button"
        data-wc-preserve-drawers
        className={`wc-canvas-import-trigger ${open ? "is-open" : ""}`}
        aria-label="导入第三方画布"
        title="导入第三方画布"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((value) => !value)}
      >
        <CloudDownload aria-hidden="true" />
        <span>导入第三方画布</span>
      </button>
      {open ? (
        <div
          className="wc-canvas-import-menu nodrag nopan nowheel"
          role="menu"
          aria-label="选择要导入的第三方画布"
        >
          {canvasImportProviders.map((provider) => {
            const Icon = PROVIDER_ICONS[provider];
            const status = statusByProvider.get(provider);
            const disabled = status ? !status.available : false;
            return (
              <button
                key={provider}
                type="button"
                role="menuitem"
                className="wc-canvas-import-option"
                disabled={disabled}
                title={disabled && status ? status.reason : canvasImportProviderHints[provider]}
                onClick={() => {
                  setOpen(false);
                  onOpen(provider);
                }}
              >
                <Icon aria-hidden="true" />
                <span className="wc-canvas-import-option-label">
                  导入 {canvasImportProviderLabels[provider]} 画布
                </span>
                {statusFailed || !status || status.available ? null : (
                  <span className="wc-canvas-import-option-note">未配置</span>
                )}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
});

export const CanvasImportDialog = memo(function CanvasImportDialog({
  provider,
  onClose,
}: {
  provider: CanvasImportProvider;
  onClose: () => void;
}) {
  const [reference, setReference] = useState("");
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [preview, setPreview] = useState<CanvasImportPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const label = canvasImportProviderLabels[provider];

  useEffect(() => {
    window.requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    if (phase === "applying") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, phase]);

  const read = useCallback(async () => {
    const value = reference.trim();
    if (!value) {
      setError(`请先粘贴${label} 画布链接${provider === "updream" ? "或分享口令" : ""}`);
      return;
    }
    setPhase("reading");
    setError(null);
    setPreview(null);
    try {
      const response = await requestCanvasImportPreview({ provider, reference: value });
      setPreview(response.data);
      setPhase("ready");
    } catch (reason) {
      setPhase("idle");
      // 401 说明本地还以为是登录态：让身份 store 回到真实状态，并把原因说清楚，
      // 而不是丢一句"读取失败"。
      if (reason instanceof CanvasApiError && reason.status === 401) {
        useIdentityStore.getState().expire();
        setError("导入第三方画布需要先登录画布账号");
        return;
      }
      setError(
        reason instanceof Error && reason.message ? reason.message : `读取${label} 画布失败`,
      );
    }
  }, [label, provider, reference]);

  const apply = useCallback(async () => {
    if (!preview) return;
    // 整块居中到当前视口中心：导入的多半是一屏内容，先按视口摆好再让用户微调。
    const anchor = viewportCenterInFlow(useCanvasStore.getState().viewport);
    const plan = planImportedGraph(preview, anchor);
    if (!plan.nodes.length) {
      setError("这个画布里没有可导入的节点");
      return;
    }
    setPhase("applying");
    const nodeIds = useCanvasStore.getState().addImportedGraph(
      plan.nodes.map((node) => ({
        kind: node.kind,
        position: node.position,
        width: node.width,
        height: node.height,
        data: node.data,
      })),
      plan.edges,
    );
    const nodeIdByKey = new Map(plan.nodes.map((node, index) => [node.key, nodeIds[index]]));
    const withAsset = preview.nodes.filter((node) => node.asset);
    let done = 0;
    setProgress({ done, total: withAsset.length });
    const failures: string[] = [];
    // 逐个取：对方的 CDN 不该被同时打十几个并发，进度也才说得清。
    for (const node of preview.nodes) {
      const nodeId = nodeIdByKey.get(node.key);
      if (!nodeId || !node.asset) continue;
      try {
        const media = await fetchImportedAsset(node);
        useCanvasStore.getState().setNodeMedia(nodeId, media, false);
        useCanvasStore
          .getState()
          .updateNodeData(nodeId, { uploading: false, status: "success" }, false);
      } catch (reason) {
        const message = reason instanceof Error && reason.message ? reason.message : "素材拉取失败";
        failures.push(`「${node.title || node.key}」${message}`);
        const current = useCanvasStore.getState().nodes.find((item) => item.id === nodeId)?.data;
        useCanvasStore.getState().updateNodeData(
          nodeId,
          {
            uploading: false,
            status: "error",
            ...(current ? { generation: { ...current.generation, error: message } } : {}),
          },
          false,
        );
      }
      done += 1;
      setProgress({ done, total: withAsset.length });
    }
    const showToast = useToastStore.getState().show;
    const placed = plan.nodes.length;
    const linked = plan.edges.length;
    showToast(
      `已导入 ${placed} 个节点${linked ? `、${linked} 条连线` : ""}${failures.length ? `，${failures.length} 个素材没取到` : ""}`,
      failures.length ? "error" : "success",
    );
    for (const failure of failures) console.error("[canvas-import]", failure);
    onClose();
  }, [onClose, preview]);

  return createPortal(
    <div
      className="wc-project-delete-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`导入 ${label} 画布`}
      onPointerDown={() => {
        if (phase !== "applying") onClose();
      }}
    >
      <section
        className="wc-project-delete-dialog wc-canvas-import-dialog"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <header>
          <span className="wc-canvas-import-dialog-mark" aria-hidden="true">
            <CloudDownload />
          </span>
          <strong>导入 {label} 画布</strong>
          <button
            type="button"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
            disabled={phase === "applying"}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="wc-canvas-import-body">
          <label htmlFor="wc-canvas-import-reference">{canvasImportProviderHints[provider]}</label>
          <input
            id="wc-canvas-import-reference"
            ref={inputRef}
            value={reference}
            data-wc-canvas-import-reference
            spellCheck={false}
            autoComplete="off"
            disabled={phase === "reading" || phase === "applying"}
            onChange={(event) => {
              setReference(event.target.value);
              setPreview(null);
              setError(null);
              setPhase("idle");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && phase === "idle") {
                event.preventDefault();
                void read();
              }
            }}
          />
          {error ? (
            <p className="wc-canvas-import-error" role="alert">
              <CircleAlert aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : null}
          {phase === "reading" ? (
            <p className="wc-canvas-import-status">
              <LoaderCircle aria-hidden="true" className="is-spinning" />
              <span>正在读取 {label} 画布…</span>
            </p>
          ) : null}
          {preview ? (
            <div className="wc-canvas-import-summary" data-wc-canvas-import-summary>
              <div className="wc-canvas-import-summary-head">
                <strong>{preview.projectName || `${label} 画布`}</strong>
                <span>
                  {preview.nodes.length} 个节点
                  {preview.edges.length ? ` · ${preview.edges.length} 条连线` : ""}
                </span>
              </div>
              <p className="wc-canvas-import-summary-note">
                节点保留来源画布的相对位置，整体放到当前视口中心。素材会逐个下载到本地素材库。
              </p>
              {preview.warnings.length || preview.skipped.length ? (
                <p className="wc-canvas-import-summary-warn">
                  <AlertTriangle aria-hidden="true" />
                  <span>
                    {preview.skipped.length
                      ? `${preview.skipped.length} 项未导入（${preview.skipped[0]?.message}）`
                      : ""}
                    {preview.skipped.length && preview.warnings.length ? " · " : ""}
                    {preview.warnings.length
                      ? `${preview.warnings.length} 条提醒：${preview.warnings[0]?.message}`
                      : ""}
                  </span>
                </p>
              ) : null}
            </div>
          ) : null}
          {progress ? (
            <p className="wc-canvas-import-status" data-wc-canvas-import-progress>
              <LoaderCircle aria-hidden="true" className="is-spinning" />
              <span>
                正在取素材 {progress.done}/{progress.total}
              </span>
            </p>
          ) : null}
        </div>
        <footer>
          <button type="button" onClick={onClose} disabled={phase === "applying"}>
            {preview ? "取消" : "关闭"}
          </button>
          {preview ? (
            <button
              type="button"
              className="is-primary"
              data-wc-canvas-import-confirm
              onClick={() => void apply()}
              disabled={phase === "applying"}
            >
              确认导入
            </button>
          ) : (
            <button
              type="button"
              className="is-primary"
              data-wc-canvas-import-read
              onClick={() => void read()}
              disabled={phase === "reading"}
            >
              读取画布
            </button>
          )}
        </footer>
      </section>
    </div>,
    document.body,
  );
});
