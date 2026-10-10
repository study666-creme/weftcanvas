import type { CloudResource } from "@kachang/contracts";
import { AlertCircle, Check, CloudOff, Download, Film, HardDrive, LoaderCircle, Music, RefreshCw, ShieldAlert, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { useCloudResourceStore, formatBytes } from "../state/cloud-resource-store";
import { useIdentityStore } from "../state/identity-store";
import { mediaContentPath } from "../lib/api-client";

/**
 * 云端资源清理面板：盘点账号下全部服务端素材，标出哪些仍被云项目引用、
 * 哪些已是删除画布后留下的孤立资源；可自选清理，支持清理前先存到本地，
 * 以及一键开启“不再保存素材到云端”。
 */
export function CloudResourceDialog() {
  const open = useCloudResourceStore((state) => state.open);
  const loading = useCloudResourceStore((state) => state.loading);
  const busy = useCloudResourceStore((state) => state.busy);
  const items = useCloudResourceStore((state) => state.items);
  const usage = useCloudResourceStore((state) => state.usage);
  const error = useCloudResourceStore((state) => state.error);
  const selected = useCloudResourceStore((state) => state.selected);
  const progress = useCloudResourceStore((state) => state.progress);
  const skipCloudUploads = useCloudResourceStore((state) => state.skipCloudUploads);
  const closeDialog = useCloudResourceStore((state) => state.closeDialog);
  const load = useCloudResourceStore((state) => state.load);
  const toggle = useCloudResourceStore((state) => state.toggle);
  const selectOrphans = useCloudResourceStore((state) => state.selectOrphans);
  const clearSelection = useCloudResourceStore((state) => state.clearSelection);
  const setSkipCloudUploads = useCloudResourceStore((state) => state.setSkipCloudUploads);
  const cleanup = useCloudResourceStore((state) => state.cleanup);
  const authenticated = useIdentityStore((state) => state.status === "authenticated");

  const [saveLocally, setSaveLocally] = useState(false);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) closeDialog();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, closeDialog, open]);

  // 只有“画布已删除的遗留素材”可清理。
  const orphanItems = useMemo(() => items.filter((item) => item.orphaned), [items]);
  const boundItems = useMemo(() => items.filter((item) => item.projectIds.length > 0), [items]);
  const activeItems = useMemo(
    () => items.filter((item) => !item.orphaned && item.projectIds.length === 0),
    [items],
  );
  const selectedItems = useMemo(
    () => orphanItems.filter((item) => selected[item.id]),
    [orphanItems, selected],
  );
  const selectedBytes = selectedItems.reduce((sum, item) => sum + item.size, 0);
  const percent = usage && usage.quotaBytes > 0
    ? Math.min(100, Math.round((usage.usedBytes / usage.quotaBytes) * 1000) / 10)
    : 0;

  if (!open) return null;

  return createPortal(
    <div
      className="kc-cloud-res-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="kc-cloud-res-title"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) closeDialog();
      }}
    >
      <section className="kc-cloud-res-dialog" onPointerDown={(event) => event.stopPropagation()}>
        <header className="kc-cloud-res-header">
          <div className="kc-cloud-res-heading">
            <span className="kc-cloud-res-symbol"><HardDrive aria-hidden="true" /></span>
            <div>
              <strong id="kc-cloud-res-title">云端资源清理</strong>
              <span>盘点云端素材，自选释放占用的存储空间</span>
            </div>
          </div>
          <button type="button" className="kc-dialog-close" aria-label="关闭" title="关闭" onClick={closeDialog} disabled={busy}>
            <X aria-hidden="true" />
          </button>
        </header>

        {!authenticated ? (
          <div className="kc-cloud-res-state"><AlertCircle aria-hidden="true" />登录后可以管理云端资源</div>
        ) : (
          <>
            <section className="kc-cloud-res-usage" aria-label="云端存储用量">
              <div className="kc-cloud-res-usage-head">
                <span>素材存储</span>
                <strong>
                  {usage ? `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.quotaBytes)}` : "--"}
                </strong>
              </div>
              <div className={`kc-cloud-res-bar ${percent >= 95 ? "is-critical" : percent >= 80 ? "is-nearing" : ""}`}>
                <i style={{ width: `${percent}%` }} />
              </div>
              {usage ? (
                <p>
                  其中画布已删除遗留的孤立资源 {formatBytes(usage.orphanBytes)} · {usage.orphanCount} 个，
                  清理后即可释放；仍在使用的素材不会被删除。
                </p>
              ) : null}
            </section>

            <div className="kc-cloud-res-toolbar">
              <div className="kc-cloud-res-actions">
                <button type="button" onClick={selectOrphans} disabled={busy || !orphanItems.length}>
                  <Check aria-hidden="true" />全选可清理（{orphanItems.length}）
                </button>
                <button type="button" onClick={clearSelection} disabled={busy || !selectedItems.length}>清空选择</button>
              </div>
              <button type="button" className="kc-cloud-res-refresh" onClick={() => void load(true)} disabled={loading || busy} title="刷新列表" aria-label="刷新列表">
                <RefreshCw className={loading ? "is-spinning" : ""} aria-hidden="true" />
              </button>
            </div>

            <div className="kc-cloud-res-list" role="list">
              {loading && !items.length ? (
                <div className="kc-cloud-res-state"><LoaderCircle className="is-spinning" aria-hidden="true" />正在读取云端资源</div>
              ) : error && !items.length ? (
                <div className="kc-cloud-res-state is-error"><AlertCircle aria-hidden="true" />{error}</div>
              ) : !items.length ? (
                <div className="kc-cloud-res-state"><CloudOff aria-hidden="true" />云端还没有素材</div>
              ) : (
                <>
                  <ResourceGroup
                    title="可清理（画布已删除的遗留素材）"
                    items={orphanItems}
                    selected={selected}
                    disabled={busy}
                    onToggle={toggle}
                  />
                  <ResourceGroup
                    title="仍在使用（未被云端画布引用）"
                    hint="由本地画布或工作台使用，清理会丢失"
                    items={activeItems}
                    selected={selected}
                    disabled
                    onToggle={toggle}
                  />
                  <ResourceGroup
                    title="已被云端画布引用"
                    hint="需先删除对应画布才能清理"
                    items={boundItems}
                    selected={selected}
                    disabled
                    onToggle={toggle}
                  />
                </>
              )}
            </div>

            <section className="kc-cloud-res-options">
              <label className="kc-cloud-res-option">
                <input type="checkbox" checked={saveLocally} disabled={busy} onChange={(event) => setSaveLocally(event.target.checked)} />
                <span>
                  <strong><Download aria-hidden="true" />清理前自动保存到本地</strong>
                  <small>先把所选素材下载到本地素材库，再从云端删除；保存失败会取消本次清理。未同步到云端的画布素材会用本地副本重新上传。</small>
                </span>
              </label>
              <label className="kc-cloud-res-option is-switch">
                <input type="checkbox" checked={skipCloudUploads} disabled={busy} onChange={(event) => setSkipCloudUploads(event.target.checked)} />
                <span>
                  <strong><CloudOff aria-hidden="true" />不再保存素材到云端</strong>
                  <small>开启后新的画布内容只同步文档，素材保留在本地，不再占用云端配额。</small>
                </span>
              </label>
            </section>

            {error && items.length ? (
              <div className="kc-cloud-res-inline-error" role="alert"><AlertCircle aria-hidden="true" />{error}</div>
            ) : null}

            <footer className="kc-cloud-res-footer">
              <span className="kc-cloud-res-selection">
                {busy && progress
                  ? `正在保存到本地 ${progress.done}/${progress.total}`
                  : `已选 ${selectedItems.length} 项 · 可释放 ${formatBytes(selectedBytes)}`}
              </span>
              <div>
                <button type="button" onClick={closeDialog} disabled={busy}>取消</button>
                <button
                  type="button"
                  className="is-danger"
                  disabled={busy || !selectedItems.length}
                  onClick={() => void cleanup({ saveLocally })}
                >
                  {busy ? <LoaderCircle className="is-spinning" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
                  {busy ? "正在清理" : "清理所选"}
                </button>
              </div>
            </footer>
          </>
        )}
      </section>
    </div>,
    document.body,
  );
}

function ResourceGroup({
  title,
  hint,
  items,
  selected,
  disabled,
  onToggle,
}: {
  title: string;
  hint?: string;
  items: CloudResource[];
  selected: Record<string, true>;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="kc-cloud-res-group" aria-label={title}>
      <header>
        <span>{title}</span>
        <small>{hint ?? `${items.length} 个`}</small>
      </header>
      {items.map((item) => (
        <ResourceRow
          key={item.id}
          item={item}
          checked={Boolean(selected[item.id])}
          disabled={disabled}
          onToggle={onToggle}
        />
      ))}
    </section>
  );
}

function ResourceRow({
  item,
  checked,
  disabled,
  onToggle,
}: {
  item: CloudResource;
  checked: boolean;
  disabled: boolean;
  onToggle: (id: string) => void;
}) {
  const bound = item.projectIds.length > 0;
  return (
    <label className={`kc-cloud-res-row ${disabled ? "is-disabled" : ""} ${checked ? "is-checked" : ""}`} role="listitem">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle(item.id)}
        aria-label={`选择 ${item.name}`}
      />
      <span className="kc-cloud-res-thumb" aria-hidden="true">
        {item.kind === "image" ? (
          <img
            src={mediaContentPath(item.id, item.projectIds[0], { variant: "thumb" })}
            alt=""
            loading="lazy"
            onError={(event) => { event.currentTarget.style.display = "none"; }}
          />
        ) : item.kind === "video" ? <Film /> : <Music />}
      </span>
      <span className="kc-cloud-res-copy">
        <strong title={item.name}>{item.name}</strong>
        <small>
          {formatBytes(item.size)} · {new Date(item.createdAt).toLocaleDateString("zh-CN")}
          {item.status !== "ready" ? ` · ${item.status === "failed" ? "已失败" : "未完成"}` : ""}
        </small>
      </span>
      {bound ? (
        <span className="kc-cloud-res-tag is-bound" title={`被 ${item.projectIds.length} 个云端画布引用`}>
          <ShieldAlert aria-hidden="true" />已被引用
        </span>
      ) : item.orphaned ? (
        <span className="kc-cloud-res-tag is-orphan"><Trash2 aria-hidden="true" />可清理</span>
      ) : (
        <span className="kc-cloud-res-tag"><HardDrive aria-hidden="true" />使用中</span>
      )}
    </label>
  );
}
